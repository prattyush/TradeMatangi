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
    brokerage_per_order: float = 0.0
    current_time: int = T0
    # Guardrail defaults — no guardrails active
    guardrail_ban_active: bool = False
    guardrail_block_until_bar: int = 0
    guardrail_block_bars: int = 3


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

    def test_autostop_is_one_shot_fires_only_on_first_bar_close(self):
        """AutoStop must mark itself COMPLETED after placing the order — it must not fire again."""
        session = _session()
        svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })

        svc.on_tick(session, _tick(T0, h=120.0, c=110.0), None)
        # Bar-1 closes → places order
        svc.on_tick(session, _tick(T1, h=115.0, c=112.0), None)
        assert len(order_service.get_open_orders(SESSION)) == 1

        # Bar-2 closes → strategy should NOT fire again
        svc.on_tick(session, _tick(T2, h=130.0, c=125.0), None)
        assert len(order_service.get_open_orders(SESSION)) == 1  # still only 1 order

    def test_autostop_completed_after_firing(self):
        """Strategy instance status must be COMPLETED once the order is placed."""
        session = _session()
        strat = svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })

        svc.on_tick(session, _tick(T0, h=120.0, c=110.0), None)
        assert strat.status == StrategyStatus.RUNNING
        svc.on_tick(session, _tick(T1, h=115.0, c=112.0), None)
        assert strat.status == StrategyStatus.COMPLETED


    def test_autostop_skipped_when_guardrail_blocked(self):
        """AutoStop must not place an order when the BLOCK guardrail is active."""
        session = _session()
        # Simulate a BLOCK guardrail: block_until_bar set to a bar that covers the close event
        session.guardrail_block_until_bar = T1  # current_slot at T1 <= until_bar → blocked
        session.guardrail_ban_active = False
        session.guardrail_block_bars = 3
        session.current_time = T1  # used by _current_bar_slot inside check_guardrails

        svc.start_strategy(session, "AutoStop", None, {
            "direction": "BUY", "quantity": 1,
            "autostop_trigger_type": "bar", "autostop_deviation_pct": 1.0,
        })

        svc.on_tick(session, _tick(T0, h=120.0, c=108.0), None)
        # Bar-1 closes at T1 — guardrail should prevent order placement
        svc.on_tick(session, _tick(T1, h=115.0, c=112.0), None)

        assert len(order_service.get_open_orders(SESSION)) == 0


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

    def test_long_places_target_sl_at_breakeven_plus_buffer_when_no_exit_order(self):
        """shift_sl mode: places TARGET at avg_entry + buffer once price passes trigger threshold."""
        session = _session()
        self._add_long_position()  # avg_entry = 100.0, qty = 10
        # expected: main_buffer(100) = ceil(max(0.15, 0.25)) = 0.25
        # new_sl_price = 100.25; trigger_buffer(100) = ceil(0.30) = 0.30
        # shift_sl trigger threshold: 100.25 + 0.30 = 100.55

        svc.start_strategy(session, "BreakEven", None, {"breakeven_mode": "shift_sl"})

        # Price below trigger threshold — no order
        svc.on_tick(session, _tick(T0, c=100.0), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        # Price at trigger threshold → place SELL TARGET at new_sl_price
        svc.on_tick(session, _tick(T0 + 1, c=100.55), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.SELL
        assert orders[0].order_type == OrderType.TARGET
        assert orders[0].trigger_price == pytest.approx(100.25)

    def test_long_moves_existing_exit_order_to_breakeven_plus_buffer(self):
        """shift_sl mode: moves existing SL to avg_entry + buffer when threshold is reached."""
        session = _session()
        self._add_long_position()  # avg_entry = 100.0, qty = 10

        existing_sl = order_service.place_order(
            session_id=SESSION, symbol=SYMBOL, side=TradeSide.SELL,
            order_type=OrderType.STOPLOSS, quantity=10, created_at=T0,
            trading_date=DATE, trigger_price=80.0, is_stoploss=True, user_id=USER_ID,
        )

        svc.start_strategy(session, "BreakEven", None, {"breakeven_mode": "shift_sl"})

        # Price at trigger threshold — should move existing SL to new_sl_price=100.25
        svc.on_tick(session, _tick(T0 + 1, c=100.6), None)

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].order_id == existing_sl.order_id
        assert orders[0].trigger_price == pytest.approx(100.25)

    def test_strategy_marked_completed_after_exit(self):
        session = _session()
        self._add_long_position()

        svc.start_strategy(session, "BreakEven", None, {"breakeven_mode": "shift_sl"})
        svc.on_tick(session, _tick(T0, c=100.6), None)  # above trigger threshold → exits

        # Strategy should have been pruned from registry
        assert svc.list_running(SESSION) == []

    def _add_short_position(self):
        from app.services.trading import record_trade
        record_trade(
            session_id=SESSION, side=TradeSide.SELL, price=100.0,
            timestamp=T0, quantity=10, symbol=SYMBOL, user_id=USER_ID,
        )

    def test_breakeven_shift_sl_with_commission_long(self):
        """Commission inflates true_breakeven, raising new_sl_price and trigger threshold."""
        session = MockSession(brokerage_per_order=10.0)  # 2×10/10 = 2.0 per share
        self._add_long_position()  # avg_entry=100.0, qty=10
        # true_breakeven = 102.0
        # main_buffer(102.0) = ceil(max(0.15, 0.255)) = ceil(5.1)*0.05 = 0.30
        # new_sl_price = ceil(102.30) = 102.30
        # trigger_buffer(102.0) = ceil(0.306/0.05)*0.05 = ceil(6.12)*0.05 = 0.35
        # shift_sl threshold = 102.30 + 0.35 = 102.65

        svc.start_strategy(session, "BreakEven", None, {"breakeven_mode": "shift_sl"})

        svc.on_tick(session, _tick(T0, c=102.64), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        svc.on_tick(session, _tick(T0 + 1, c=102.65), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.SELL
        assert orders[0].order_type == OrderType.TARGET
        assert orders[0].trigger_price == pytest.approx(102.30)

    def test_breakeven_shift_sl_short(self):
        """shift_sl SHORT: trigger when price falls to new_sl_price - trigger_buffer."""
        session = _session()
        self._add_short_position()  # avg_entry=100.0, qty=10 SHORT
        # true_breakeven=100.0; new_sl_price=100.25; trigger_buffer=0.30
        # threshold: price <= 100.25 - 0.30 = 99.95

        svc.start_strategy(session, "BreakEven", None, {"breakeven_mode": "shift_sl"})

        svc.on_tick(session, _tick(T0, c=99.96), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        svc.on_tick(session, _tick(T0 + 1, c=99.95), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.BUY
        assert orders[0].order_type == OrderType.TARGET
        assert orders[0].trigger_price == pytest.approx(100.25)

    def test_breakeven_limit_order_mode_long(self):
        """limit_order mode LONG: triggers at new_sl_price, places LIMIT (not TARGET)."""
        session = _session()
        self._add_long_position()  # avg_entry=100.0, qty=10
        # new_sl_price=100.25 is the trigger threshold in limit_order mode

        svc.start_strategy(session, "BreakEven", None, {"breakeven_mode": "limit_order"})

        svc.on_tick(session, _tick(T0, c=100.24), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        svc.on_tick(session, _tick(T0 + 1, c=100.25), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.SELL
        assert orders[0].order_type == OrderType.LIMIT
        assert orders[0].limit_price == pytest.approx(100.25)
        assert svc.list_running(SESSION) == []

    def test_breakeven_limit_order_mode_short(self):
        """limit_order mode SHORT: triggers at true_breakeven, places BUY LIMIT at new_sl_price."""
        session = _session()
        self._add_short_position()  # avg_entry=100.0, qty=10 SHORT
        # true_breakeven=100.0 is trigger; limit placed at new_sl_price=100.25

        svc.start_strategy(session, "BreakEven", None, {"breakeven_mode": "limit_order"})

        svc.on_tick(session, _tick(T0, c=100.1), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        svc.on_tick(session, _tick(T0 + 1, c=100.0), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.BUY
        assert orders[0].order_type == OrderType.LIMIT
        assert orders[0].limit_price == pytest.approx(100.25)
        assert svc.list_running(SESSION) == []

    def test_flat_position_completes_strategy(self):
        session = _session()
        # No trades — position is FLAT
        svc.start_strategy(session, "BreakEven", None, {})
        svc.on_tick(session, _tick(T0, c=100.0), None)

        # Strategy completed, no orders placed
        assert svc.list_running(SESSION) == []
        assert order_service.get_open_orders(SESSION) == []


# ── TargetProfit ──────────────────────────────────────────────────────────────

class TestTargetProfit:
    def _add_long_position(self, qty=10, avg_price=100.0):
        from app.services.trading import record_trade
        record_trade(
            session_id=SESSION, side=TradeSide.BUY, price=avg_price,
            timestamp=T0, quantity=qty, symbol=SYMBOL, user_id=USER_ID,
        )

    def _add_short_position(self, qty=10, avg_price=100.0):
        from app.services.trading import record_trade
        record_trade(
            session_id=SESSION, side=TradeSide.SELL, price=avg_price,
            timestamp=T0, quantity=qty, symbol=SYMBOL, user_id=USER_ID,
        )

    def test_long_absolute_price(self):
        """LONG: triggers at target+buffer_ticks, places SELL LIMIT at target_price."""
        session = _session()
        self._add_long_position(qty=10, avg_price=100.0)
        # target_price=105.0; tick_buffer=3×0.05=0.15; threshold=105.15

        svc.start_strategy(session, "TargetProfit", None, {
            "target_profit_value": 105.0,
            "target_profit_is_pct": False,
            "target_profit_buffer_ticks": 3,
        })

        svc.on_tick(session, _tick(T0, c=105.14), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        svc.on_tick(session, _tick(T0 + 1, c=105.15), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.SELL
        assert orders[0].order_type == OrderType.LIMIT
        assert orders[0].limit_price == pytest.approx(105.0)
        assert svc.list_running(SESSION) == []

    def test_long_pct_of_capital(self):
        """% mode: target_price computed from session_capital."""
        session = _session()  # session_capital=150_000
        self._add_long_position(qty=100, avg_price=100.0)
        # target_pnl = (2.0/100)*150_000 = 3000; target_price = ceil(100+30) = 130.0
        # threshold = 130.0 + 3×0.05 = 130.15

        svc.start_strategy(session, "TargetProfit", None, {
            "target_profit_value": 2.0,
            "target_profit_is_pct": True,
            "target_profit_buffer_ticks": 3,
        })

        svc.on_tick(session, _tick(T0, c=130.14), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        svc.on_tick(session, _tick(T0 + 1, c=130.15), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.SELL
        assert orders[0].order_type == OrderType.LIMIT
        assert orders[0].limit_price == pytest.approx(130.0)

    def test_short_absolute_price(self):
        """SHORT: triggers at target-buffer_ticks, places BUY LIMIT at target_price."""
        session = _session()
        self._add_short_position(qty=10, avg_price=100.0)
        # target_price=95.0; tick_buffer=0.15; threshold=95.0-0.15=94.85

        svc.start_strategy(session, "TargetProfit", None, {
            "target_profit_value": 95.0,
            "target_profit_is_pct": False,
            "target_profit_buffer_ticks": 3,
        })

        svc.on_tick(session, _tick(T0, c=94.86), None)
        assert len(order_service.get_open_orders(SESSION)) == 0

        svc.on_tick(session, _tick(T0 + 1, c=94.85), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].side == TradeSide.BUY
        assert orders[0].order_type == OrderType.LIMIT
        assert orders[0].limit_price == pytest.approx(95.0)
        assert svc.list_running(SESSION) == []

    def test_no_existing_sl_creates_limit_directly(self):
        """No prior exit order — places new LIMIT order immediately when target is hit."""
        session = _session()
        self._add_long_position(qty=10, avg_price=100.0)

        svc.start_strategy(session, "TargetProfit", None, {
            "target_profit_value": 110.0,
            "target_profit_is_pct": False,
            "target_profit_buffer_ticks": 3,
        })

        svc.on_tick(session, _tick(T0, c=110.15), None)
        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
        assert orders[0].order_type == OrderType.LIMIT
        assert orders[0].limit_price == pytest.approx(110.0)
        assert svc.list_running(SESSION) == []

    def test_converts_existing_sl_to_limit(self):
        """Existing TARGET exit order is cancelled and replaced by LIMIT at target_price."""
        session = _session()
        self._add_long_position(qty=10, avg_price=100.0)

        existing_sl = order_service.place_order(
            session_id=SESSION, symbol=SYMBOL, side=TradeSide.SELL,
            order_type=OrderType.TARGET, quantity=10, created_at=T0,
            trading_date=DATE, trigger_price=90.0, is_stoploss=True, user_id=USER_ID,
        )

        svc.start_strategy(session, "TargetProfit", None, {
            "target_profit_value": 110.0,
            "target_profit_is_pct": False,
            "target_profit_buffer_ticks": 3,
        })

        svc.on_tick(session, _tick(T0, c=110.15), None)
        open_orders = order_service.get_open_orders(SESSION)
        assert len(open_orders) == 1
        assert open_orders[0].order_type == OrderType.LIMIT
        assert open_orders[0].limit_price == pytest.approx(110.0)

        all_orders = order_service.get_all_orders(SESSION)
        old = next(o for o in all_orders if o.order_id == existing_sl.order_id)
        assert old.status == OrderStatus.CANCELLED
        assert svc.list_running(SESSION) == []


def test_ceil_tick():
    """_ceil_tick always rounds UP to the nearest ₹0.05 tick."""
    from app.services.strategy_service import _ceil_tick
    assert _ceil_tick(100.0) == 100.0
    assert _ceil_tick(100.01) == pytest.approx(100.05)
    assert _ceil_tick(100.049) == pytest.approx(100.05)
    assert _ceil_tick(100.05) == pytest.approx(100.05)
    assert _ceil_tick(100.051) == pytest.approx(100.10)
    assert _ceil_tick(0.0) == 0.0
    assert _ceil_tick(0.001) == pytest.approx(0.05)


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

    def test_only_in_profit_skips_when_close_below_entry(self):
        """SL must NOT be placed when bar closes below avg_entry with only_in_profit=True."""
        session = _session()
        self._add_long_position()  # avg_entry = 100.0

        svc.start_strategy(session, "AggressiveStoploss", None, {"only_in_profit": True})

        # Bar closes at 95 (below entry 100) → should skip
        svc.on_tick(session, _tick(T0, c=95.0), None)
        svc.on_tick(session, _tick(T1, c=97.0), None)

        assert len(order_service.get_open_orders(SESSION)) == 0

    def test_only_in_profit_places_sl_when_close_above_entry(self):
        """SL must be placed when bar closes above avg_entry with only_in_profit=True."""
        session = _session()
        self._add_long_position()  # avg_entry = 100.0

        svc.start_strategy(session, "AggressiveStoploss", None, {"only_in_profit": True})

        # Bar closes at 110 (above entry 100) → should place SL
        svc.on_tick(session, _tick(T0, c=110.0), None)
        svc.on_tick(session, _tick(T1, c=112.0), None)

        orders = order_service.get_open_orders(SESSION)
        assert len(orders) == 1
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
