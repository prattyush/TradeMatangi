"""
Unit tests for strategy_service.
DynamoDB writes and wallet operations are patched out.
Order placement calls are real (against the in-memory order store), but wallet is mocked.
"""
import pytest
from unittest.mock import patch, MagicMock
from dataclasses import dataclass, field
import asyncio

from app.services import strategy_service as svc
from app.services import order_service
from app.services.strategy_service import StrategyStatus
from app.models.schemas import OrderType, TradeSide, OrderStatus, Position

# ── Constants ─────────────────────────────────────────────────────────────────

SESSION = "strat-test-session"
USER_ID = "test-user-001"
SYMBOL = "NIFTY"
DATE = "2026-05-14"
INTERVAL = 180  # 3-minute bars

# Base timestamp aligned to a 3-min slot boundary: 09:15:00 IST-as-UTC
# 09:15:00 = 9*3600 + 15*60 = 33300; align: (33300 // 180)*180 = 33300
T0 = 33300   # slot start of bar-1
T1 = T0 + 180  # start of bar-2 (triggers bar-1 close)
T2 = T1 + 180  # start of bar-3


# ── Mock session ──────────────────────────────────────────────────────────────

@dataclass
class MockSession:
    session_id: str = SESSION
    user_id: str = USER_ID
    symbol: str = SYMBOL
    date: str = DATE
    instrument_type: str = "equity"
    session_capital: float = 150_000.0
    strategy_interval_secs: int = INTERVAL


def _session():
    return MockSession()


def _tick(ts: int, o=100.0, h=110.0, l=95.0, c=105.0, right=None):
    t = {"type": "tick", "time": ts, "open": o, "high": h, "low": l, "close": c}
    if right:
        t["right"] = right
    return t


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def clean_registry():
    """Clear strategy registry, order store, and trade store before each test."""
    from app.services import trading
    svc._registry.pop(SESSION, None)
    order_service.clear_session(SESSION)
    trading.clear_session(SESSION)
    yield
    svc._registry.pop(SESSION, None)
    order_service.clear_session(SESSION)
    trading.clear_session(SESSION)


@pytest.fixture(autouse=True)
def no_db():
    """Patch DynamoDB writes and wallet operations."""
    with patch("app.services.strategy_service._write_strategy_to_db"), \
         patch("app.services.order_service._write_order_to_db"), \
         patch("app.services.wallet_service.debit"), \
         patch("app.services.wallet_service.credit"):
        yield


# ── AutoStop — bar mode ───────────────────────────────────────────────────────

class TestAutoStopBarMode:
    def test_buy_places_target_at_bar_high(self):
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })

        # Feed bar-1 ticks
        svc.on_tick(session, _tick(T0, h=120.0, c=108.0), None)
        svc.on_tick(session, _tick(T0 + 60, h=125.0, c=110.0), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        # Bar-2 first tick → bar-1 closes
        svc.on_tick(session, _tick(T1, h=115.0, c=112.0), None)

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        o = orders[0]
        assert o.order_type == OrderType.TARGET
        assert o.side == TradeSide.BUY
        assert o.trigger_price == pytest.approx(125.0)  # bar-1 high

    def test_sell_places_target_at_bar_low(self):
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "SELL", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })

        svc.on_tick(session, _tick(T0, l=90.0, c=105.0), None)
        svc.on_tick(session, _tick(T1, c=106.0), None)  # bar-1 closes

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.SELL
        assert orders[0].trigger_price == pytest.approx(90.0)  # bar-1 low


class TestAutoStopDeviationMode:
    def test_buy_places_target_at_close_plus_deviation(self):
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "deviation", "autostop_deviation_pct": 2.0,
        })

        svc.on_tick(session, _tick(T0, c=100.0), None)
        svc.on_tick(session, _tick(T1, c=105.0), None)  # bar closes; close was 100.0

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        # trigger = close * (1 + 2/100) = 102.0
        assert orders[0].trigger_price == pytest.approx(102.0)

    def test_sell_places_target_at_close_minus_deviation(self):
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "SELL", "quantity": 1,
            "autostop_trigger_type": "deviation", "autostop_deviation_pct": 2.0,
        })

        svc.on_tick(session, _tick(T0, c=100.0), None)
        svc.on_tick(session, _tick(T1, c=95.0), None)

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].trigger_price == pytest.approx(98.0)  # 100 * (1 - 2/100)


# ── BreakEven ─────────────────────────────────────────────────────────────────

class TestBreakEven:
    def _add_long_position(self):
        """Simulate a LONG position by placing and filling a BUY order."""
        from app.services.trading import record_trade
        record_trade(
            session_id=SESSION, side=TradeSide.BUY, price=100.0,
            timestamp=T0, quantity=10, symbol=SYMBOL, user_id=USER_ID,
        )

    def test_long_places_target_sl_at_breakeven_when_no_exit_order(self):
        session = _session()
        self._add_long_position()  # avg_entry = 100.0, qty = 10

        svc.start_strategy(session, "BreakEven", None, {})

        # Price below entry — no order
        svc.on_tick(session, _tick(T0, c=95.0), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        # Price at entry — no existing exit order → place SELL TARGET at avg_entry
        svc.on_tick(session, _tick(T0 + 1, c=100.0), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.SELL
        assert orders[0].order_type == OrderType.TARGET
        assert orders[0].trigger_price == pytest.approx(100.0)

    def test_long_moves_existing_exit_order_to_breakeven(self):
        session = _session()
        self._add_long_position()  # avg_entry = 100.0, qty = 10

        # User has an existing SELL STOPLOSS at 80 (quantity matches position)
        existing_sl = order_service.place_order(
            session_id=SESSION, symbol=SYMBOL, side=TradeSide.SELL,
            order_type=OrderType.STOPLOSS, quantity=10, created_at=T0,
            trading_date=DATE, trigger_price=80.0, is_stoploss=True, user_id=USER_ID,
        )

        svc.start_strategy(session, "BreakEven", None, {})

        # Price at avg_entry — should move existing SL to 100.0
        svc.on_tick(session, _tick(T0 + 1, c=100.0), None)

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1  # no new order created
        assert orders[0].order_id == existing_sl.order_id
        assert orders[0].trigger_price == pytest.approx(100.0)

    def test_strategy_marked_completed_after_exit(self):
        session = _session()
        self._add_long_position()

        svc.start_strategy(session, "BreakEven", None, {})
        svc.on_tick(session, _tick(T0, c=100.0), None)  # exits

        # Strategy should have been pruned from registry
        assert svc.list_running(SESSION) == []

    def test_flat_position_completes_strategy(self):
        session = _session()
        # No trades — position is FLAT
        svc.start_strategy(session, "BreakEven", None, {})
        svc.on_tick(session, _tick(T0, c=100.0), None)

        # Strategy completed, no orders placed
        assert svc.list_running(SESSION) == []
        assert order_service.get_open_orders(SESSION) == []


# ── AggressiveStoploss ────────────────────────────────────────────────────────

class TestAggressiveStoploss:
    def _add_long_position(self):
        from app.services.trading import record_trade
        record_trade(
            session_id=SESSION, side=TradeSide.BUY, price=100.0,
            timestamp=T0, quantity=10, symbol=SYMBOL, user_id=USER_ID,
        )

    def test_creates_target_sl_order_when_none_exists(self):
        session = _session()
        self._add_long_position()  # qty=10

        svc.start_strategy(session, "AggressiveStoploss", None, {})

        # Feed bar-1, then trigger bar close
        svc.on_tick(session, _tick(T0, c=110.0), None)
        svc.on_tick(session, _tick(T1, c=112.0), None)  # bar closes at c=110.0

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        sl = orders[0]
        assert sl.order_type == OrderType.TARGET
        assert sl.is_stoploss is False
        assert sl.side == TradeSide.SELL  # exit LONG
        assert sl.trigger_price == pytest.approx(110.0 * 0.99)

    def test_updates_existing_sl_order(self):
        session = _session()
        self._add_long_position()  # qty=10

        # Existing SELL STOPLOSS with matching quantity
        existing_sl = order_service.place_order(
            session_id=SESSION, symbol=SYMBOL, side=TradeSide.SELL,
            order_type=OrderType.STOPLOSS, quantity=10, created_at=T0,
            trading_date=DATE, trigger_price=90.0, is_stoploss=True, user_id=USER_ID,
        )

        svc.start_strategy(session, "AggressiveStoploss", None, {})

        svc.on_tick(session, _tick(T0, c=110.0), None)
        svc.on_tick(session, _tick(T1, c=112.0), None)  # bar closes

        # Existing order updated; no new order created
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].order_id == existing_sl.order_id
        assert orders[0].trigger_price == pytest.approx(110.0 * 0.99)

    def test_updates_non_stoploss_exit_order(self):
        """AggressiveStoploss updates any exit-direction order, not just is_stoploss ones."""
        session = _session()
        self._add_long_position()  # qty=10

        # Existing SELL TARGET (not flagged as stoploss) with matching quantity
        existing_tgt = order_service.place_order(
            session_id=SESSION, symbol=SYMBOL, side=TradeSide.SELL,
            order_type=OrderType.TARGET, quantity=10, created_at=T0,
            trading_date=DATE, trigger_price=85.0, user_id=USER_ID,
        )

        svc.start_strategy(session, "AggressiveStoploss", None, {})

        svc.on_tick(session, _tick(T0, c=110.0), None)
        svc.on_tick(session, _tick(T1, c=112.0), None)

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].order_id == existing_tgt.order_id
        assert orders[0].trigger_price == pytest.approx(110.0 * 0.99)


# ── Cancel All ────────────────────────────────────────────────────────────────

class TestCancelAll:
    def test_cancel_all_stops_autostop_from_firing(self):
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })

        # Cancel before bar close
        svc.cancel_all(SESSION)
        assert svc.list_running(SESSION) == []

        # Even if a bar closes now, no order should be placed
        svc.on_tick(session, _tick(T0, h=120.0, c=108.0), None)
        svc.on_tick(session, _tick(T1, c=112.0), None)  # would trigger bar close

        assert order_service.get_open_orders(SESSION) == []

    def test_cancel_all_returns_count(self):
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "SELL", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })
        count = svc.cancel_all(SESSION)
        assert count == 2

    def test_cancel_all_writes_cancelled_status_to_db(self):
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })

        with patch("app.services.strategy_service._write_strategy_to_db") as mock_write:
            svc.cancel_all(SESSION)
            assert mock_write.called
            call_args = mock_write.call_args[0][0]
            assert call_args.status == StrategyStatus.CANCELLED
