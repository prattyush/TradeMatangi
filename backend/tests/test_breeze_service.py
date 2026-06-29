"""
Tests for breeze_service: _OHLCAccumulator, BreezeStreamManager.
"""
import asyncio
from unittest.mock import MagicMock, patch

import pytest

from app.services.breeze_service import BreezeStreamManager, _OHLCAccumulator


# ── _OHLCAccumulator ──────────────────────────────────────────────────────────

class TestOHLCAccumulator:
    def test_first_tick_opens_candle_no_output(self):
        acc = _OHLCAccumulator()
        result = acc.update(100.0, 1000)
        assert result is None

    def test_same_second_updates_ohlc_no_output(self):
        acc = _OHLCAccumulator()
        acc.update(100.0, 1000)
        acc.update(102.0, 1000)
        acc.update(98.0, 1000)
        acc.update(101.0, 1000)
        assert acc.open == 100.0
        assert acc.high == 102.0
        assert acc.low == 98.0
        assert acc.close == 101.0

    def test_new_second_returns_completed_candle_and_starts_new(self):
        acc = _OHLCAccumulator()
        acc.update(100.0, 1000)  # first tick opens candle at 1000
        acc.update(102.0, 1000)  # high goes to 102
        completed = acc.update(101.0, 1001)  # new second → flush
        assert completed is not None
        assert completed["time"] == 1000
        assert completed["open"] == 100.0
        assert completed["high"] == 102.0
        assert completed["low"] == 100.0
        assert completed["close"] == 102.0  # last price in second 1000
        # New second candle started with price from the tick that triggered flush
        assert acc.current_second == 1001
        assert acc.open == 101.0


# ── BreezeStreamManager ───────────────────────────────────────────────────────

class TestBreezeStreamManagerInit:
    def test_initial_state(self):
        mgr = BreezeStreamManager()
        assert mgr._breeze is None
        assert mgr._queue is None
        assert mgr._loop is None
        assert mgr._instruments == []


class TestBreezeStreamManagerStart:

    @pytest.mark.asyncio
    async def test_on_ticks_assigned_as_callable_not_list(self):
        """
        The Breeze SDK calls breeze.on_ticks(data) — it expects a single
        callable, NOT a list. This test verifies that on_ticks is set as
        a function reference, not appended to a list.
        """
        mgr = BreezeStreamManager()
        mock_breeze = MagicMock()
        mock_breeze.on_ticks = None  # simulate SDK default

        with patch(
            "app.services.broker_service._get_breeze", return_value=mock_breeze
        ):
            mgr.start(asyncio.Queue(), asyncio.get_running_loop(), [])

        # on_ticks must be a callable (the _on_ticks method), not a list
        assert callable(mock_breeze.on_ticks), (
            f"on_ticks must be callable, got {type(mock_breeze.on_ticks)}"
        )
        assert not isinstance(mock_breeze.on_ticks, list), (
            "on_ticks must NOT be a list — SDK calls on_ticks(data) directly"
        )

    @pytest.mark.asyncio
    async def test_ws_connect_called(self):
        mgr = BreezeStreamManager()
        mock_breeze = MagicMock()
        mock_breeze.on_ticks = None

        with patch(
            "app.services.broker_service._get_breeze", return_value=mock_breeze
        ):
            mgr.start(asyncio.Queue(), asyncio.get_running_loop(), [])

        mock_breeze.ws_connect.assert_called_once()

    @pytest.mark.asyncio
    async def test_subscribes_equity_feed(self):
        mgr = BreezeStreamManager()
        mock_breeze = MagicMock()
        mock_breeze.on_ticks = None

        instruments = [{
            "exchange_code": "NSE",
            "stock_code": "NIFTY",
            "product_type": "cash",
        }]

        with patch(
            "app.services.broker_service._get_breeze", return_value=mock_breeze
        ):
            mgr.start(asyncio.Queue(), asyncio.get_running_loop(), instruments)

        mock_breeze.subscribe_feeds.assert_called_once_with(
            exchange_code="NSE",
            stock_code="NIFTY",
            product_type="cash",
            expiry_date="",
            strike_price="",
            right="",
            get_exchange_quotes=True,
            get_market_depth=False,
        )

    @pytest.mark.asyncio
    async def test_subscribes_options_feeds(self):
        mgr = BreezeStreamManager()
        mock_breeze = MagicMock()
        mock_breeze.on_ticks = None

        instruments = [
            {"exchange_code": "NSE", "stock_code": "NIFTY", "product_type": "cash"},
            {
                "exchange_code": "NFO", "stock_code": "NIFTY",
                "product_type": "options", "expiry_date": "2026-06-25T06:00:00.000Z",
                "strike_price": "24000", "right": "call",
            },
            {
                "exchange_code": "NFO", "stock_code": "NIFTY",
                "product_type": "options", "expiry_date": "2026-06-25T06:00:00.000Z",
                "strike_price": "24000", "right": "put",
            },
        ]

        with patch(
            "app.services.broker_service._get_breeze", return_value=mock_breeze
        ):
            mgr.start(asyncio.Queue(), asyncio.get_running_loop(), instruments)

        assert mock_breeze.subscribe_feeds.call_count == 3


class TestBreezeStreamManagerStop:

    @pytest.mark.asyncio
    async def test_stop_unsubscribes_and_disconnects(self):
        mgr = BreezeStreamManager()
        mock_breeze = MagicMock()
        mock_breeze.on_ticks = None

        instruments = [{
            "exchange_code": "NSE",
            "stock_code": "NIFTY",
            "product_type": "cash",
        }]

        with patch(
            "app.services.broker_service._get_breeze", return_value=mock_breeze
        ):
            mgr.start(asyncio.Queue(), asyncio.get_running_loop(), instruments)

        mgr.stop()

        mock_breeze.unsubscribe_feeds.assert_called_once_with(
            exchange_code="NSE",
            stock_code="NIFTY",
            product_type="cash",
            expiry_date="",
            strike_price="",
            right="",
        )
        mock_breeze.ws_disconnect.assert_called_once()

    def test_stop_when_not_started_is_noop(self):
        mgr = BreezeStreamManager()
        mgr.stop()  # should not raise


class TestBreezeStreamManagerOnTicks:

    @pytest.mark.asyncio
    async def test_on_ticks_accumulates_and_pushes_candle(self):
        mgr = BreezeStreamManager()
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()

        # Manually wire up internals (bypass ws_connect)
        mgr._breeze = True  # non-None so _on_ticks runs
        mgr._queue = queue
        mgr._loop = loop

        # Seed the accumulator for "NIFTY_EQ" with a "previous" second
        from app.services.breeze_service import _OHLCAccumulator
        acc = _OHLCAccumulator()
        acc.current_second = 1000
        acc.open = 24200.0
        acc.high = 24205.0
        acc.low = 24199.0
        acc.close = 24204.0
        mgr._accumulators["NIFTY_EQ"] = acc

        # Send a tick in a new second (1001) — should flush candle for second 1000
        mgr._on_ticks([{"stock_code": "NIFTY", "last": "24210.00", "right": ""}])

        # call_soon_threadsafe schedules on the event loop; yield to let it run
        await asyncio.sleep(0)

        assert queue.qsize() == 1
        candle = queue.get_nowait()
        assert candle["type"] == "tick"
        assert candle["time"] == 1000
        assert candle["open"] == 24200.0
        assert candle["high"] == 24205.0
        assert candle["low"] == 24199.0
        assert candle["close"] == 24204.0

    def test_on_ticks_skips_when_not_started(self):
        mgr = BreezeStreamManager()
        # _breeze, _queue, _loop all None → should return immediately
        mgr._on_ticks([{"stock_code": "NIFTY", "last": "24200.50"}])
        # No exception = pass
