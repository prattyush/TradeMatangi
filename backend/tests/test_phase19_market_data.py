import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.market_data import FeedGroup, MarketDataHub, fallback_sources, instrument_key
from app.services.kite_service import KiteBroadcaster

EQUITY = {"kind": "equity", "exchange": "NSE", "symbol": "RELIND"}
OPTION = {"kind": "option", "exchange": "NSE", "underlying": "NIFTY", "expiry": "2026-10-06", "strike": 25000, "right": "CE"}


class FakeAdapter:
    def __init__(self):
        self.opened, self.closed, self.deliveries = [], [], {}
        self.failed = set()

    async def open(self, source, instrument, delivery, loop):
        if source in self.failed:
            raise RuntimeError(f"{source} unavailable")
        key = (source, instrument_key(instrument))
        self.opened.append(key)
        self.deliveries[key] = delivery
        return lambda: self.closed.append(key)


@pytest.mark.asyncio
async def test_shared_instrument_across_users_and_independent_release():
    adapter = FakeAdapter()
    hub = MarketDataHub(adapter)
    first, second = asyncio.Queue(), asyncio.Queue()
    group = FeedGroup("kite")
    a, b = await asyncio.gather(hub.subscribe(OPTION, "website:user-a", group, first),
                               hub.subscribe({**OPTION, "exchange": "NFO", "strike": "25000"}, "desktop:user-b", FeedGroup("kite"), second))
    assert len(adapter.opened) == 1
    tick = {"type": "tick", "right": "CE", "time": 100, "open": 10, "high": 12, "low": 9, "close": 11}
    adapter.deliveries[a.key].put_nowait(tick)
    assert first.get_nowait()["close"] == second.get_nowait()["close"] == 11
    a.close()
    assert not adapter.closed
    b.close()
    assert len(adapter.closed) == 1
    b.close()
    assert len(adapter.closed) == 1


@pytest.mark.asyncio
async def test_exact_expiry_and_strike_routing():
    adapter = FakeAdapter()
    hub = MarketDataHub(adapter)
    a, b = asyncio.Queue(), asyncio.Queue()
    first = await hub.subscribe(OPTION, "a", FeedGroup("kite"), a)
    await hub.subscribe({**OPTION, "strike": 25100}, "b", FeedGroup("kite"), b)
    adapter.deliveries[first.key].put_nowait({"type": "tick", "right": "CE", "time": 1, "close": 100})
    assert a.get_nowait()["strike"] == 25000
    assert b.empty()
    hub.shutdown()


@pytest.mark.parametrize("source,real,expected", [
    ("kite", False, ("kite", "breeze")), ("kite", True, ("kite",)),
    ("kotak", False, ("kotak", "kite", "breeze")), ("kotak", True, ("kotak", "kite")),
    ("breeze", False, ("breeze", "kite")), ("fyers", True, ("fyers", "breeze", "kite")),
])
def test_fallback_policy(source, real, expected):
    assert fallback_sources(source, real) == expected


@pytest.mark.asyncio
async def test_initial_fallback_and_transactional_group_handover():
    adapter = FakeAdapter()
    adapter.failed.add("kite")
    hub = MarketDataHub(adapter)
    group = FeedGroup("kite")
    first = await hub.subscribe(EQUITY, "engine", group, asyncio.Queue())
    second = await hub.subscribe(OPTION, "chart", group, asyncio.Queue())
    assert group.actual == "breeze"
    adapter.failed.clear()
    await hub.rebind(group, target="kite")
    assert first.key[0] == second.key[0] == group.actual == "kite"
    assert group.generation == 2
    assert len(adapter.closed) == 2
    first.close()
    second.close()
    assert not hub.feeds


@pytest.mark.asyncio
async def test_overflow_reports_gap_without_affecting_other_consumer():
    hub = MarketDataHub(FakeAdapter())
    full, healthy = asyncio.Queue(maxsize=1), asyncio.Queue()
    full.put_nowait({"old": True})
    a = await hub.subscribe(EQUITY, "slow", FeedGroup("kite"), full)
    await hub.subscribe(EQUITY, "healthy", FeedGroup("kite"), healthy)
    hub.deliver(a.key, {"type": "tick", "time": 10, "close": 100})
    assert full.get_nowait()["stream_gap"]
    assert healthy.get_nowait()["close"] == 100
    hub.shutdown()


def test_kite_flushes_quiet_second_once_without_empty_candles():
    broadcaster = KiteBroadcaster()
    queue = asyncio.Queue()
    loop = SimpleNamespace(call_soon_threadsafe=lambda callback, *args: callback(*args))
    broadcaster._token_sessions[1]["test"] = (queue, None, loop)
    broadcaster._accumulators[1].update(100, 1000)
    broadcaster._accumulators[1].update(105, 1000)
    broadcaster.flush_completed(1001)
    tick = queue.get_nowait()
    assert tick["time"] == 1000 and tick["high"] == 105
    broadcaster.flush_completed(1002)
    assert queue.empty()


@pytest.mark.asyncio
async def test_reconnected_socket_without_night_quotes_does_not_fallback(monkeypatch):
    from unittest.mock import AsyncMock
    adapter = FakeAdapter()
    adapter.connected = lambda source: True
    hub = MarketDataHub(adapter)
    group = FeedGroup("kite")
    handle = await hub.subscribe(EQUITY, "night", group, asyncio.Queue())
    hub.deliver(handle.key, {"type": "broker_error", "message": "reconnecting"})
    task = hub.recovery_tasks[id(group)]
    monkeypatch.setattr("app.services.market_data.asyncio.sleep", AsyncMock())
    await task
    assert group.connection == "connected"
    assert group.actual == "kite"
    assert len(adapter.opened) == 1
    hub.shutdown()


def test_real_history_is_presentation_and_never_sends_broker_orders():
    from unittest.mock import patch
    from app.services.simulation import _emit_tick_and_check_orders_real
    session = SimpleNamespace(session_id="history", queue=asyncio.Queue(), market_feed_group=FeedGroup("kite"))
    tick = {"type": "tick", "time": 1000, "open": 100, "high": 100, "low": 100, "close": 100}
    with patch("app.services.order_service.check_orders") as check, patch("app.services.kotak_service.get_service") as broker:
        assert _emit_tick_and_check_orders_real(session, tick, None, None) == []
    check.assert_not_called()
    broker.assert_not_called()
    assert session._history_watermarks[(None, None, None)] == 1000


@pytest.mark.asyncio
async def test_old_sdk_callbacks_cannot_deliver_into_reopened_feed():
    adapter = FakeAdapter()
    hub = MarketDataHub(adapter)
    first = await hub.subscribe(EQUITY, "old", FeedGroup("kite"), asyncio.Queue())
    delivery = adapter.deliveries[first.key]
    first.close()
    queue = asyncio.Queue()
    second = await hub.subscribe(EQUITY, "new", FeedGroup("kite"), queue)
    delivery.put_nowait({"type": "tick", "time": 100, "close": 42})
    delivery.update_quote({"time": 100, "close": 42})
    assert queue.empty() and second.key not in hub.quotes
    second.close()


@pytest.mark.asyncio
async def test_consumer_closed_during_handover_is_not_resurrected():
    class PausedAdapter(FakeAdapter):
        def __init__(self):
            super().__init__()
            self.entered, self.resume = asyncio.Event(), asyncio.Event()

        async def open(self, source, instrument, delivery, loop):
            if source == "breeze":
                self.entered.set()
                await self.resume.wait()
            return await super().open(source, instrument, delivery, loop)

    adapter = PausedAdapter()
    hub = MarketDataHub(adapter)
    group = FeedGroup("kite")
    handle = await hub.subscribe(EQUITY, "closing", group, asyncio.Queue())
    handover = asyncio.create_task(hub.rebind(group, target="breeze"))
    await adapter.entered.wait()
    handle.close()
    adapter.resume.set()
    await handover
    assert handle.closed and not hub.feeds
    assert len(adapter.opened) == len(adapter.closed) == 2


@pytest.mark.asyncio
async def test_last_consumer_close_cancels_pending_recovery():
    hub = MarketDataHub(FakeAdapter())
    group = FeedGroup("kite")
    handle = await hub.subscribe(EQUITY, "closing", group, asyncio.Queue())
    hub.deliver(handle.key, {"type": "broker_error", "message": "disconnected"})
    task = hub.recovery_tasks[id(group)]
    handle.close()
    await asyncio.gather(task, return_exceptions=True)
    assert task.cancelled() and not hub.recovery_tasks and not hub.feeds


@pytest.mark.asyncio
async def test_initial_engine_bundle_falls_back_when_only_option_fails(monkeypatch):
    from app.services import market_data
    class PartialAdapter(FakeAdapter):
        async def open(self, source, instrument, delivery, loop):
            if source == "kite" and instrument.get("right"):
                raise RuntimeError("Kite option unavailable")
            return await super().open(source, instrument, delivery, loop)
    adapter = PartialAdapter()
    hub = MarketDataHub(adapter)
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    session = SimpleNamespace(session_id="engine", symbol="NIFTY", instrument_type="options", expiry=OPTION["expiry"], strike=25000, right="CE", paper_tick_queue=asyncio.Queue())
    group = FeedGroup("kite")
    feed = market_data.SessionFeed(session, group)
    await feed.start()
    assert group.actual == "breeze"
    assert len(feed.handles) == 2 and all(h.key[0] == "breeze" for h in feed.handles)
    assert len(adapter.closed) == 1
    feed.stop()
    assert not hub.feeds


@pytest.mark.asyncio
async def test_new_subscription_does_not_mask_reconnecting_group():
    adapter = FakeAdapter()
    hub = MarketDataHub(adapter)
    group = FeedGroup("kite")
    handle = await hub.subscribe(EQUITY, "a", group, asyncio.Queue())
    adapter.deliveries[handle.key].put_nowait({"type": "broker_error", "message": "disconnected"})
    await hub.subscribe(OPTION, "b", group, asyncio.Queue())
    assert group.connection == "reconnecting"
    assert group.reason == "disconnected"
    hub.shutdown()


@pytest.mark.asyncio
async def test_removed_tile_cannot_commit_late_subscription(monkeypatch):
    from app.services import desktop_live_service as live, market_data
    opened, resume = asyncio.Event(), asyncio.Event()
    class PausedAdapter(FakeAdapter):
        async def open(self, *args):
            opened.set()
            await resume.wait()
            return await super().open(*args)
    adapter = PausedAdapter()
    hub = MarketDataHub(adapter)
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    monkeypatch.setattr(market_data, "selected_provider", lambda: "kite")
    tile = {"tile_id": "removed", "instrument": OPTION.copy(), "availability": "pending_subscription"}
    stream = live.start("user", [tile])
    task = asyncio.create_task(live.activate(stream))
    await opened.wait()
    await live.remove_tile(stream, "removed")
    resume.set()
    await task
    assert not stream.feed_handles and not hub.feeds and not stream.tile_tasks
    live.stop("user", stream.stream_id)


@pytest.mark.asyncio
async def test_handover_keeps_history_but_requires_current_quote(monkeypatch):
    from app.services import desktop_live_service as live, market_data
    hub = MarketDataHub(FakeAdapter())
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    tile = {"tile_id": "option", "instrument": OPTION.copy(), "subscribed": True,
            "latest_tick": {"timestamp": 1, "open": 40, "high": 40, "low": 40, "close": 40}}
    stream = live.start("user", [tile])
    group = FeedGroup("kite")
    handle = await hub.subscribe(OPTION, "desktop", group, asyncio.Queue())
    stream.feed_handles["option"] = handle
    await hub.rebind(group, target="breeze")
    args = ("user", stream.stream_id, "NIFTY", OPTION["expiry"], 25000, "CE")
    assert live.option_quote(*args) is None
    assert tile["latest_tick"]["close"] == 40
    hub.deliver(handle.key, {"type": "tick", "right": "CE", "time": 2, "open": 41, "high": 41, "low": 41, "close": 41})
    assert live.option_quote(*args)["price"] == 41
    live.stop("user", stream.stream_id)


@pytest.mark.asyncio
async def test_reset_cursor_cannot_skip_event_arriving_after_reset_yield(monkeypatch):
    from app.routers import stream
    from app.services.simulation import ReplayEventQueue
    queue = ReplayEventQueue(maxsize=2)
    for number in (1, 2, 3):
        queue.put_nowait(str(number))
    monkeypatch.setattr(stream.sim_svc, "get_session", lambda _: SimpleNamespace(queue=queue, state="running"))
    generator = stream._event_generator("test", 0)
    reset = await anext(generator)
    assert reset.startswith('id: 3\n')
    queue.put_nowait('4')
    next_event = await asyncio.wait_for(anext(generator), 1)
    assert next_event.startswith('id: 4\n')
    await generator.aclose()


@pytest.mark.asyncio
async def test_failed_bundle_cannot_deliver_candidate_ticks_to_engine(monkeypatch):
    from app.services import market_data
    class EmittingAdapter(FakeAdapter):
        async def open(self, source, instrument, delivery, loop):
            if source == "kite" and instrument.get("right"):
                for key, callback in self.deliveries.items():
                    if key[0] == "kite":
                        callback.put_nowait({"type": "tick", "time": 1, "close": 999})
                raise RuntimeError("option unavailable after underlying tick")
            return await super().open(source, instrument, delivery, loop)
    hub = MarketDataHub(EmittingAdapter())
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    queue = asyncio.Queue()
    session = SimpleNamespace(session_id="engine", symbol="NIFTY", instrument_type="options", expiry=OPTION["expiry"], strike=25000, right="CE", paper_tick_queue=queue)
    feed = market_data.SessionFeed(session, FeedGroup("kite"))
    await feed.start()
    assert queue.empty()
    handle = feed.handles[0]
    hub.deliver(handle.key, {"type": "tick", "time": 2, "close": 100})
    assert queue.get_nowait()["provider"] == "breeze"
    feed.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["breeze", "kite", "fyers", "kotak"])
@pytest.mark.parametrize("identity", [
    {}, {"right": "PE"}, {"right": "CE", "strike": 25001},
    {"right": "CE", "strike": "invalid"}, {"right": "CE", "strike": None},
    {"right": "CE", "expiry": "2026-10-13"}, {"right": "CE", "expiry": None},
])
async def test_invalid_option_identity_never_updates_quote_status_or_consumers(source, identity):
    hub, queue = MarketDataHub(FakeAdapter()), asyncio.Queue()
    group = FeedGroup(source)
    handle = await hub.subscribe(OPTION, "engine", group, queue)
    group.connection, group.reason = "reconnecting", "waiting for valid data"
    before = group.status().copy()
    hub.deliver(handle.key, {"type": "tick", "time": 1, "close": 72500, **identity})
    assert queue.empty() and handle.key not in hub.quotes
    assert not hub.feeds[handle.key]["first_tick"]
    assert group.status() == before
    hub.shutdown()


@pytest.mark.asyncio
async def test_underlying_rejects_option_candle_and_control_messages_still_flow():
    hub, queue = MarketDataHub(FakeAdapter()), asyncio.Queue()
    handle = await hub.subscribe(EQUITY, "engine", FeedGroup("breeze"), queue)
    hub.deliver(handle.key, {"type": "tick", "right": "PE", "time": 1, "close": 40})
    assert queue.empty() and handle.key not in hub.quotes
    hub.deliver(handle.key, {"type": "feed_status", "connection": "connected"})
    assert queue.get_nowait()["type"] == "feed_status"
    hub.shutdown()


@pytest.mark.asyncio
async def test_valid_large_option_price_is_accepted_without_price_heuristics():
    hub, queue = MarketDataHub(FakeAdapter()), asyncio.Queue()
    handle = await hub.subscribe(OPTION, "engine", FeedGroup("breeze"), queue)
    hub.deliver(handle.key, {"type": "tick", "right": "CE", "strike": "25000.0",
                             "expiry": OPTION["expiry"], "time": 1, "close": 72500})
    assert queue.get_nowait()["close"] == 72500
    assert hub.quotes[handle.key]["close"] == 72500
    hub.shutdown()


@pytest.mark.asyncio
async def test_identity_rejection_warning_is_throttled_per_feed(monkeypatch, caplog):
    from app.services import market_data
    hub = MarketDataHub(FakeAdapter())
    handle = await hub.subscribe(OPTION, "engine", FeedGroup("breeze"), asyncio.Queue())
    now = [100.0]
    monkeypatch.setattr(market_data.time, "monotonic", lambda: now[0])
    for _ in range(100):
        hub.deliver(handle.key, {"type": "tick", "time": 1, "close": 72500})
    assert sum("market_data_identity_rejected" in record.message for record in caplog.records) == 1
    now[0] += 60
    hub.deliver(handle.key, {"type": "tick", "time": 1, "close": 72500})
    assert sum("market_data_identity_rejected" in record.message for record in caplog.records) == 2
    assert hub.feeds[handle.key]["rejected_ticks"] == 101
    hub.shutdown()


@pytest.mark.asyncio
async def test_startup_and_handover_stage_only_valid_instrument_candles(monkeypatch):
    from app.services import market_data, simulation
    class EmittingAdapter(FakeAdapter):
        def __init__(self):
            super().__init__()
            self.emitted = set()
        async def open(self, source, instrument, delivery, loop):
            close = await super().open(source, instrument, delivery, loop)
            for key, feed in list(hub.feeds.items()):
                if key[0] != source or key in self.emitted:
                    continue
                self.emitted.add(key)
                right = feed["instrument"].get("right")
                bad = {"right": "CE"} if not right else {}
                hub.deliver(key, {"type": "tick", "time": 1, "close": 999, **bad})
                hub.deliver(key, {"type": "tick", "time": 2, "close": 40 if right else 72500, "right": right})
            return close
    hub = MarketDataHub(EmittingAdapter())
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    s = simulation.SimulationSession(session_id="staged", symbol="BSESEN", date="2026-10-01",
        start_time="09:15:00", speed=1, session_type="paper", instrument_type="options",
        strike=72900, strike_ce=72900, strike_pe=71900, expiry="2026-10-01")
    feed = market_data.SessionFeed(s, FeedGroup("breeze"))
    await feed.start()
    for handover in (False, True):
        if handover:
            await hub.rebind(feed.group, target="kite")
        events = []
        while not s.paper_tick_queue.empty():
            events.append(s.paper_tick_queue.get_nowait())
        ticks = [event for event in events if event["type"] == "tick"]
        assert {(event.get("right"), event["close"]) for event in ticks} == {(None, 72500), ("CE", 40)}
        assert all(event["provider"] == ("kite" if handover else "breeze") for event in ticks)
        assert all(event["feed_generation"] == feed.group.generation for event in ticks)
        assert all(quote["close"] != 999 for quote in hub.quotes.values())
    feed.stop()
