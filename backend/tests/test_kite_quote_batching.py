from unittest.mock import Mock
import asyncio

import pytest

from app.services import kite_service, performance_diagnostics as diagnostics
from app.services.kite_service import KiteBroadcaster
from app.services.market_data import MarketDataHub, _Delivery


class Loop:
    def __init__(self):
        self.ready, self.timers = [], []
        self.closed = False
        self.scheduled = 0

    def is_closed(self):
        return self.closed

    def call_soon_threadsafe(self, callback, *args):
        if self.closed:
            raise RuntimeError("closed")
        self.scheduled += 1
        self.ready.append((callback, args))

    def call_later(self, delay, callback, *args):
        assert delay == .1
        self.timers.append((callback, args))

    def arm(self):
        ready, self.ready = self.ready, []
        for callback, args in ready:
            callback(*args)

    def drain(self):
        self.arm()
        timers, self.timers = self.timers, []
        for callback, args in timers:
            callback(*args)


@pytest.fixture
def feed(monkeypatch):
    monkeypatch.setattr(kite_service._time, "time", lambda: 1000.)
    monkeypatch.setattr(diagnostics, "ENABLED", False)
    bc, loop, queue = KiteBroadcaster(), Loop(), Mock()
    bc._ticker = object()
    bc._token_sessions[1]["website"] = (queue, None, loop)
    return bc, loop, queue


def ticks(bc, prices, token=1):
    bc._on_ticks(bc._ticker, [{"instrument_token": token, "last_price": p} for p in prices])


def test_burst_one_callback_latest_quote_all_ohlc_prices(feed):
    bc, loop, queue = feed
    ticks(bc, [100, 150, 50] + list(range(100, 10100)))
    assert loop.scheduled == 1
    assert len(bc._quote_batches[loop]["pending"]) == 1
    loop.arm()
    assert len(loop.timers) == 1
    queue.update_quote.assert_not_called()
    ticks(bc, [10100])
    assert loop.scheduled == 1
    loop.drain()
    quote = queue.update_quote.call_args.args[0]
    assert quote["close"] == 10100 and quote["received_at"] == 1000
    assert bc._accumulators[1].open == 100
    assert bc._accumulators[1].high == 10100
    assert bc._accumulators[1].low == 50
    assert not bc._quote_batches


def test_shared_loop_many_clients_and_tokens(feed):
    bc, loop, website = feed
    desktop, paper = Mock(), Mock()
    bc._token_sessions[1]["desktop"] = (desktop, None, loop)
    bc._token_sessions[2]["paper"] = (paper, "CE", loop)
    ticks(bc, [100, 110])
    ticks(bc, [200, 210], token=2)
    assert loop.scheduled == 1
    assert len(bc._quote_batches[loop]["pending"]) == 3
    loop.drain()
    assert website.update_quote.call_args.args[0]["close"] == 110
    assert desktop.update_quote.call_args.args[0]["close"] == 110
    assert paper.update_quote.call_args.args[0]["provider_token"] == "2"


def test_distinct_owner_loops(feed):
    bc, loop, _ = feed
    other, queue = Loop(), Mock()
    bc._token_sessions[1]["other"] = (queue, None, other)
    ticks(bc, [100])
    assert loop.scheduled == other.scheduled == 1
    loop.drain()
    queue.update_quote.assert_not_called()
    other.drain()
    queue.update_quote.assert_called_once()


@pytest.mark.parametrize("change", ["unsubscribe", "replace", "socket"])
def test_stale_pending_delivery_cannot_revive_subscription(feed, change):
    bc, loop, queue = feed
    ticks(bc, [100])
    if change == "unsubscribe":
        bc._token_sessions[1].clear()
    elif change == "replace":
        bc._token_sessions[1]["website"] = (Mock(), None, loop)
    else:
        bc._ticker = object()
    loop.drain()
    queue.update_quote.assert_not_called()
    assert not bc._quote_batches


def test_failed_consumer_does_not_block_another(feed):
    bc, loop, queue = feed
    queue.update_quote.side_effect = ValueError("failed")
    second = Mock()
    bc._token_sessions[1]["desktop"] = (second, None, loop)
    ticks(bc, [100])
    loop.drain()
    second.update_quote.assert_called_once()


def test_closed_loop_does_not_accumulate(feed):
    bc, loop, queue = feed
    loop.closed = True
    ticks(bc, [100])
    assert not bc._quote_batches
    queue.update_quote.assert_not_called()


def test_candles_do_not_wait_for_quote_timer(feed, monkeypatch):
    bc, loop, queue = feed
    ticks(bc, [100, 150, 50, 120])
    monkeypatch.setattr(kite_service._time, "time", lambda: 1001.)
    ticks(bc, [130])
    loop.arm()  # completed candle is immediate; quote timer still pending
    candle = queue.put_nowait.call_args.args[0]
    assert {k: candle[k] for k in ("open", "high", "low", "close")} == dict(open=100, high=150, low=50, close=120)
    queue.update_quote.assert_not_called()
    loop.drain()
    assert queue.update_quote.call_args.args[0]["close"] == 130


def test_original_receipt_age_and_reopened_delivery(feed, monkeypatch):
    bc, loop, _ = feed
    hub = MarketDataHub()
    key = ("kite", "test")
    delivery = _Delivery(hub, key)
    hub.feeds[key] = {"delivery": delivery}
    bc._token_sessions[1]["website"] = (delivery, None, loop)
    ticks(bc, [100])
    monkeypatch.setattr(kite_service._time, "time", lambda: 1005.)
    loop.drain()
    assert hub.quotes[key]["received_at"] == 1000
    ticks(bc, [110])
    hub.feeds[key] = {"delivery": _Delivery(hub, key)}
    hub.quotes.clear()
    loop.drain()
    assert key not in hub.quotes


def test_diagnostic_metadata_is_sampled_and_does_not_mutate_stored_event(monkeypatch):
    monkeypatch.setattr(diagnostics, "ENABLED", True)
    diagnostics._stream_samples.clear()
    event = '{"type":"tick","close":100}'
    sampled = diagnostics.sample_sse(event, 42, "website:test")
    assert '"event_id": 42' in sampled
    assert diagnostics.sample_sse(event, 43, "website:test") == event
    monkeypatch.setattr(diagnostics, "ENABLED", False)
    assert diagnostics.sample_sse(event, 44, "other") == event


@pytest.mark.asyncio
async def test_timing_preserves_return_and_exception(monkeypatch):
    monkeypatch.setattr(diagnostics, "ENABLED", True)
    diagnostics.snapshot()
    @diagnostics.timed("test_operation")
    async def work(fail=False):
        await asyncio.sleep(0)
        if fail:
            raise ValueError("original")
        return 42
    assert await work() == 42
    with pytest.raises(ValueError, match="original"):
        await work(True)
    result = diagnostics.snapshot()
    assert result["test_operation_calls"] == 2
    assert result["test_operation_ms"] >= 0


def test_quotes_arriving_during_drain_get_one_next_timer(feed):
    bc, loop, queue = feed
    queue.update_quote.side_effect = lambda _: ticks(bc, [200])
    ticks(bc, [100])
    loop.drain()
    assert loop.scheduled == 2
    assert len(bc._quote_batches[loop]["pending"]) == 1
    queue.update_quote.side_effect = None
    loop.drain()
    assert queue.update_quote.call_args.args[0]["close"] == 200


def test_same_socket_reconnect_invalidates_pending_quotes(feed):
    bc, loop, queue = feed
    bc._notify_sessions_error = Mock()
    ticks(bc, [100])
    bc._on_reconnect(bc._ticker, 1)
    loop.drain()
    queue.update_quote.assert_not_called()
    ticks(bc, [200])
    loop.drain()
    assert queue.update_quote.call_args.args[0]["close"] == 200


@pytest.mark.asyncio
async def test_disabled_monitor_does_not_sleep_or_start_reactor(monkeypatch):
    monkeypatch.setattr(diagnostics, "ENABLED", False)
    sleeper = Mock(side_effect=AssertionError("unexpected monitoring task"))
    monkeypatch.setattr(diagnostics.asyncio, "sleep", sleeper)
    await diagnostics.monitor_loop_lag()
    sleeper.assert_not_called()


@pytest.mark.asyncio
async def test_stalled_reactor_has_only_one_outstanding_probe(monkeypatch, caplog):
    from types import SimpleNamespace
    import twisted.internet
    clock = [100.]
    reactor = SimpleNamespace(running=True, callFromThread=Mock())
    broadcaster = SimpleNamespace(_connected=True, _token_sessions={1: {}}, _ticker=object())
    monkeypatch.setattr(diagnostics, "ENABLED", True)
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(kite_service, "get_broadcaster", lambda: broadcaster)
    monkeypatch.setattr(twisted.internet, "reactor", reactor, raising=False)
    monkeypatch.setattr(diagnostics, "_last_batch", 100.)
    monkeypatch.setattr(diagnostics, "_measuring_feed", False)
    async def sleep(_):
        clock[0] += 1
        if clock[0] > 132:
            raise asyncio.CancelledError
    monkeypatch.setattr(diagnostics.asyncio, "sleep", sleep)
    diagnostics.snapshot()
    with pytest.raises(asyncio.CancelledError):
        await diagnostics.monitor_loop_lag()
    reactor.callFromThread.assert_called_once()
    assert 'category=kite_reactor_lag_ms' in caplog.text


def test_arrival_gap_peak_survives_recovery_between_monitor_samples(monkeypatch):
    monkeypatch.setattr(diagnostics, "ENABLED", True)
    monkeypatch.setattr(diagnostics, "_measuring_feed", True)
    monkeypatch.setattr(diagnostics, "_last_batch", 100.)
    monkeypatch.setattr(diagnostics.time, "monotonic", lambda: 102.15)
    diagnostics.snapshot()
    diagnostics.kite_batch(3)
    assert diagnostics.snapshot()["kite_arrival_gap_ms"] == pytest.approx(2150)


def test_strike_changes_prune_pending_mailbox_while_loop_waits(feed, monkeypatch):
    bc, loop, queue = feed
    bc._ticker = Mock()
    bc._session_tokens["website"].add(1)
    bc._subscribe_more = Mock()
    monkeypatch.setattr(kite_service, "_reactor_call", lambda *args: None)
    ticks(bc, [100])
    for token in range(2, 102):
        bc.update_session_right("website", "CE", token, queue, loop)
        ticks(bc, [token], token=token)
        assert len(bc._quote_batches[loop]["pending"]) <= 2
    loop.drain()
    assert queue.update_quote.call_args.args[0]["provider_token"] == "101"


def test_unregister_clears_pending_state_before_scheduled_arm(feed, monkeypatch):
    bc, loop, queue = feed
    bc._ticker = Mock()
    bc._session_tokens["website"].add(1)
    monkeypatch.setattr(kite_service, "_reactor_call", lambda *args: None)
    ticks(bc, [100])
    bc.unregister("website")
    assert not bc._quote_batches
    loop.drain()
    assert not loop.timers
    queue.update_quote.assert_not_called()
