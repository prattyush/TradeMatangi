"""Production queue coverage for the Phase 19 Paper streaming regression."""
import asyncio
import json
from unittest.mock import patch

import pytest

from app.services import market_data, simulation


class Adapter:
    def __init__(self):
        self.opened, self.closed, self.deliveries = [], [], {}
        self.fail = set()

    async def open(self, source, instrument, delivery, loop):
        key = (source, market_data.instrument_key(instrument))
        if source in self.fail:
            raise RuntimeError("provider unavailable")
        self.opened.append(key)
        self.deliveries[key] = delivery
        return lambda: self.closed.append(key)


@pytest.mark.parametrize("preserve", [False, True])
def test_stop_preserves_durable_intent_only_for_failure_cleanup(preserve):
    s = session()
    with patch.object(simulation, "_upsert_session_to_db"), \
         patch("app.services.kite_service.get_broadcaster"), \
         patch("app.services.strategy_service.cancel_all") as cancel_strategies, \
         patch("app.services.strategy_service.clear_session") as clear_strategies, \
         patch("app.services.order_service.cancel_all_pending_orders") as cancel_orders, \
         patch("app.services.order_service.clear_session") as clear_orders:
        simulation.stop_session(s, preserve_trading_state=preserve)
    assert cancel_orders.call_count == int(not preserve)
    assert cancel_strategies.call_count == int(not preserve)
    clear_orders.assert_called_once_with(s.session_id)
    clear_strategies.assert_called_once_with(s.session_id)


def session(resumed=False):
    return simulation.SimulationSession(session_id="paper-production-queue", symbol="BSESEN",
        date="2026-10-01", start_time="09:15:00", speed=1, session_type="paper",
        instrument_type="options", strike=72900, strike_ce=72900, strike_pe=71900,
        expiry="2026-10-01", resumed_from_db=resumed)


def tick(price=100):
    return {"type": "tick", "time": 1790848800, "open": price, "high": price, "low": price, "close": price}


@pytest.mark.asyncio
@pytest.mark.parametrize("resumed", [False, True])
@pytest.mark.parametrize("source", ["breeze", "kite"])
@pytest.mark.parametrize("session_type", ["paper", "real"])
async def test_real_engine_queue_starts_and_delivers_exact_contract(source, resumed, session_type, monkeypatch):
    s, adapter = session(resumed), Adapter()
    s.session_type = session_type
    hub = market_data.MarketDataHub(adapter)
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    feed = market_data.SessionFeed(s, market_data.FeedGroup(source))
    await feed.start()
    assert isinstance(s.paper_tick_queue, simulation.RingQueue)
    assert len(feed.handles) == 3
    ce = next(h for h in feed.handles if hub.feeds[h.key]["instrument"].get("right") == "CE")
    adapter.deliveries[ce.key].put_nowait(tick())
    payload = await asyncio.wait_for(s.paper_tick_queue.get(), 1)
    assert (payload["provider"], payload["right"], payload["strike"], payload["expiry"]) == (source, "CE", 72900, s.expiry)
    feed.stop()
    assert not hub.feeds


@pytest.mark.asyncio
@pytest.mark.parametrize("wrapped", [False, True])
async def test_handover_accepts_engine_and_supplemental_queues(wrapped):
    s, adapter = session(), Adapter()
    hub, group = market_data.MarketDataHub(adapter), market_data.FeedGroup("breeze")
    queue = simulation._ContractTickQueue(s, {"contract_key": "original-contract"}) if wrapped else s.paper_tick_queue
    handle = await hub.subscribe({"kind": "index", "symbol": s.symbol}, "paper", group, queue)
    await hub.rebind(group, target="kite")
    assert group.actual == "kite" and group.connection == "connected"
    adapter.deliveries[handle.key].put_nowait(tick())
    events = []
    while not s.paper_tick_queue.empty():
        events.append(s.paper_tick_queue.get_nowait())
    received = next(event for event in events if event["type"] == "tick")
    assert received["provider"] == "kite"
    if wrapped:
        assert received["contract_key"] == "original-contract"
    handle.close()


@pytest.mark.asyncio
async def test_real_engine_queue_falls_back_and_releases_failed_bundle(monkeypatch):
    s, adapter = session(True), Adapter()
    adapter.fail.add("breeze")
    hub = market_data.MarketDataHub(adapter)
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    feed = market_data.SessionFeed(s, market_data.FeedGroup("breeze"))
    await feed.start()
    assert feed.group.actual == "kite"
    assert all(handle.key[0] == "kite" for handle in feed.handles)
    feed.stop()


def test_staged_delivery_preserves_ring_buffer_drop_oldest_policy():
    hub = market_data.MarketDataHub(Adapter())
    queue = simulation.RingQueue(1)
    handle = market_data.Subscription(hub, market_data.FeedGroup("breeze"), ("breeze", "instrument"), "paper", queue)
    queue.put_nowait(tick(90))
    assert queue.maxsize == 1 and queue.full()
    hub._enqueue(handle, tick(100))
    assert queue.get_nowait()["close"] == 100
    assert queue._dropped == 1
    assert not queue.full()


def test_staged_delivery_marks_overflow_for_bounded_async_queue():
    hub, queue = market_data.MarketDataHub(Adapter()), asyncio.Queue(maxsize=1)
    handle = market_data.Subscription(hub, market_data.FeedGroup("breeze"), ("breeze", "instrument"), "desktop", queue)
    queue.put_nowait(tick(90))
    hub._enqueue(handle, tick(100))
    assert queue.get_nowait()["stream_gap"] is True
    assert handle.dropped == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("resumed", [False, True])
@pytest.mark.parametrize("session_type", ["paper", "real"])
async def test_session_task_reaches_live_phase_and_sse_replay_buffer(resumed, session_type, monkeypatch):
    s, adapter = session(resumed), Adapter()
    s.session_type = session_type
    s.resume_event.set()
    simulation._sessions[s.session_id] = s
    hub = market_data.MarketDataHub(adapter)
    monkeypatch.setattr(market_data, "get_hub", lambda: hub)
    monkeypatch.setattr(market_data, "selected_provider", lambda: "breeze")
    received = asyncio.Event()
    def emit(active, payload, right, *args):
        active.queue.put_nowait(json.dumps(payload))
        received.set()
        return []
    async def inline_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)
    with patch("asyncio.to_thread", side_effect=inline_thread), patch("app.services.broker_service.fetch_historical"), patch("app.services.options_service.fetch_options_historical"), \
         patch("app.services.options_service.options_iter_ticks", return_value=iter(())), \
         patch("app.services.data_loader.iter_ticks", return_value=iter(())), \
         patch.object(simulation, "iter_ticks", return_value=iter(())), \
         patch.object(simulation, "_emit_tick_and_check_orders_real", side_effect=emit), \
         patch.object(simulation, "_emit_tick_and_check_orders", side_effect=emit):
        runner = simulation._run_real_session if session_type == "real" else simulation._run_paper_session
        task = asyncio.create_task(runner(s))
        try:
            async def wait_phase():
                while s.paper_stream_source != "breeze":
                    if task.done():
                        pytest.fail("Session engine ended before live phase")
                    await asyncio.sleep(.001)
            await asyncio.wait_for(wait_phase(), 2)
            assert simulation.get_session(s.session_id) is s
            handle = s.stream_manager.handles[1]
            adapter.deliveries[handle.key].put_nowait(tick())
            await asyncio.wait_for(received.wait(), 1)
            assert not task.done() and s.state == simulation.SimulationState.RUNNING
            assert any(json.loads(payload).get("type") == "tick" for _, payload in s.queue._dq)
            from app.routers.stream import stream_session
            response = await stream_session(s.session_id, user_id=s.user_id,
                request_user_id=s.user_id, last_event_id=0, last_event_id_header=None)
            assert response.status_code == 200
            payloads = [await anext(response.body_iterator) for _ in range(s.queue.latest_id())]
            assert any('"type": "tick"' in payload for payload in payloads)
            await response.body_iterator.aclose()
        finally:
            s.state = simulation.SimulationState.ENDED
            s.paper_tick_queue.close()
            task.cancel()
            await task
            simulation._sessions.pop(s.session_id, None)
            hub.shutdown()
