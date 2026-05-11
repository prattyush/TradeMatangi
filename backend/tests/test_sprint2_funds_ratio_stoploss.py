"""
Sprint 2 tests: FundsRatio quantity computation and Stoploss order mechanics.
"""
import pytest
from unittest.mock import patch, MagicMock
from app.services import order_service as svc
from app.services.order_service import compute_funds_ratio_quantity
from app.services.wallet_service import InsufficientFundsError
from app.models.schemas import OrderType, TradeSide, OrderStatus

SESSION = "sprint2-test-session"
DATE = "2026-05-06"


@pytest.fixture(autouse=True)
def clean():
    svc.clear_session(SESSION)
    yield
    svc.clear_session(SESSION)


@pytest.fixture(autouse=True)
def no_db():
    with patch("app.services.order_service._write_order_to_db"):
        yield


# ── FundsRatio quantity computation ─────────────────────────────────────────

class TestComputeFundsRatioQuantity:
    """Tests for compute_funds_ratio_quantity helper (lot_size=1 for equity)."""

    def test_equity_l_ratio(self):
        # session_capital=150000, ratio=3%, price=100 => spend=4500 => qty=45
        qty = compute_funds_ratio_quantity("TATPOW", 100.0, 150_000, 0.03, 150_000, lot_size=1)
        assert qty == 45

    def test_equity_m_ratio(self):
        # session_capital=150000, ratio=6%, price=200 => spend=9000 => qty=45
        qty = compute_funds_ratio_quantity("TATPOW", 200.0, 150_000, 0.06, 150_000, lot_size=1)
        assert qty == 45

    def test_equity_h_ratio(self):
        # session_capital=150000, ratio=12%, price=500 => spend=18000 => qty=36
        qty = compute_funds_ratio_quantity("TATPOW", 500.0, 150_000, 0.12, 150_000, lot_size=1)
        assert qty == 36

    def test_equity_truncates_fractional(self):
        # spend=3000, price=70 => 42.85 -> 42
        qty = compute_funds_ratio_quantity("TATPOW", 70.0, 100_000, 0.03, 100_000, lot_size=1)
        assert qty == 42

    def test_equity_1unit_fallback_when_ratio_spend_too_small(self):
        # spend=0.03*100=3, price=100 => qty=0, wallet=200 >= 100 => fallback 1
        qty = compute_funds_ratio_quantity("TATPOW", 100.0, 100.0, 0.03, 200.0, lot_size=1)
        assert qty == 1

    def test_equity_error_when_wallet_cannot_afford_1unit(self):
        # price=500, wallet=200 < 500 => error
        with pytest.raises(InsufficientFundsError):
            compute_funds_ratio_quantity("TATPOW", 500.0, 100.0, 0.03, 200.0, lot_size=1)

    def test_nifty_options_1lot(self):
        # price=50, lot_size=75, unit_cost=3750
        # spend=4500 => lots=1 (floor(4500/3750)=1)
        qty = compute_funds_ratio_quantity("NIFTY", 50.0, 150_000, 0.03, 50_000, lot_size=75)
        assert qty == 75  # 1 lot = 75 units

    def test_nifty_options_2lots(self):
        # price=50, lot_size=75, unit_cost=3750
        # session_capital=500000, ratio=6% => spend=30000 => lots=8
        qty = compute_funds_ratio_quantity("NIFTY", 50.0, 500_000, 0.06, 100_000, lot_size=75)
        assert qty == 600  # 8 lots * 75

    def test_lot_fallback_when_spend_too_small_but_wallet_affordable(self):
        # price=30, lot_size=75, unit_cost=2250
        # spend=0.01*1000=10 < 2250 => lots=0, wallet=5000 >= 2250 => fallback 1 lot
        qty = compute_funds_ratio_quantity("NIFTY", 30.0, 1_000.0, 0.01, 5_000.0, lot_size=75)
        assert qty == 75

    def test_lot_fallback_error_when_wallet_insufficient(self):
        # price=30, lot_size=75, unit_cost=2250, wallet=1000 < 2250 => error
        with pytest.raises(InsufficientFundsError):
            compute_funds_ratio_quantity("NIFTY", 30.0, 100.0, 0.01, 1_000.0, lot_size=75)

    def test_high_price_nifty_equity_path_unaffordable(self):
        # Equity NIFTY (lot_size=1), price=24000, wallet=100 < 24000 => error
        with pytest.raises(InsufficientFundsError):
            compute_funds_ratio_quantity("NIFTY", 24000.0, 150_000, 0.06, 100.0, lot_size=1)


# ── Stoploss placement — no wallet debit ───────────────────────────────────

class TestStoplossPlacement:
    def _place_sl(self, side: TradeSide, trigger: float, qty: int = 1):
        return svc.place_order(
            SESSION, "NIFTY", side, OrderType.STOPLOSS, qty, 1, DATE,
            trigger_price=trigger, is_stoploss=True,
        )

    def test_sl_buy_no_wallet_debit(self):
        debit_mock = MagicMock()
        with patch("app.services.wallet_service.debit", debit_mock):
            self._place_sl(TradeSide.BUY, 24000.0)
        debit_mock.assert_not_called()

    def test_sl_sell_no_wallet_debit(self):
        debit_mock = MagicMock()
        with patch("app.services.wallet_service.debit", debit_mock):
            self._place_sl(TradeSide.SELL, 24000.0)
        debit_mock.assert_not_called()

    def test_sl_reserved_amount_is_zero(self):
        order = self._place_sl(TradeSide.BUY, 24000.0)
        assert order.reserved_amount == 0.0

    def test_sl_is_stoploss_flag_set(self):
        order = self._place_sl(TradeSide.BUY, 24000.0)
        assert order.is_stoploss is True

    def test_sl_order_type_is_stoploss(self):
        order = self._place_sl(TradeSide.SELL, 24000.0)
        assert order.order_type == OrderType.STOPLOSS

    def test_sl_limit_price_equals_trigger(self):
        # No 1% deviation for SL (unlike TARGET)
        order = self._place_sl(TradeSide.BUY, 24000.0)
        assert order.limit_price == 24000.0
        assert order.trigger_price == 24000.0

    def test_sl_requires_trigger_price(self):
        with pytest.raises(ValueError, match="trigger_price is required"):
            svc.place_order(SESSION, "NIFTY", TradeSide.BUY, OrderType.STOPLOSS, 1, 1, DATE)


# ── Stoploss trigger logic ──────────────────────────────────────────────────

class TestStoplossTriggerLogic:
    def _place_sl(self, side: TradeSide, trigger: float, qty: int = 1):
        return svc.place_order(
            SESSION, "NIFTY", side, OrderType.STOPLOSS, qty, 1, DATE,
            trigger_price=trigger, is_stoploss=True,
        )

    def test_sell_sl_triggers_when_price_at_trigger(self):
        # LONG position SL: SELL when price drops to trigger
        self._place_sl(TradeSide.SELL, 24000.0)
        filled = svc.check_orders(SESSION, 24000.0, 100, DATE)
        assert len(filled) == 1
        assert filled[0].status == OrderStatus.FILLED

    def test_sell_sl_triggers_when_price_below_trigger(self):
        self._place_sl(TradeSide.SELL, 24000.0)
        filled = svc.check_orders(SESSION, 23950.0, 100, DATE)
        assert len(filled) == 1

    def test_sell_sl_does_not_trigger_above_trigger(self):
        self._place_sl(TradeSide.SELL, 24000.0)
        filled = svc.check_orders(SESSION, 24001.0, 100, DATE)
        assert filled == []

    def test_buy_sl_triggers_when_price_at_trigger(self):
        # SHORT position SL: BUY when price rises to trigger
        self._place_sl(TradeSide.BUY, 24100.0)
        filled = svc.check_orders(SESSION, 24100.0, 100, DATE)
        assert len(filled) == 1

    def test_buy_sl_triggers_when_price_above_trigger(self):
        self._place_sl(TradeSide.BUY, 24100.0)
        filled = svc.check_orders(SESSION, 24150.0, 100, DATE)
        assert len(filled) == 1

    def test_buy_sl_does_not_trigger_below_trigger(self):
        self._place_sl(TradeSide.BUY, 24100.0)
        filled = svc.check_orders(SESSION, 24099.0, 100, DATE)
        assert filled == []


# ── Stoploss fill — no wallet credit ───────────────────────────────────────

class TestStoplossWalletOnFill:
    def _place_sl(self, side: TradeSide, trigger: float):
        return svc.place_order(
            SESSION, "NIFTY", side, OrderType.STOPLOSS, 1, 1, DATE,
            trigger_price=trigger, is_stoploss=True,
        )

    def test_sell_sl_fill_does_not_credit_wallet(self):
        self._place_sl(TradeSide.SELL, 24000.0)
        credit_mock = MagicMock()
        with patch("app.services.wallet_service.credit", credit_mock):
            svc.check_orders(SESSION, 23999.0, 100, DATE)
        credit_mock.assert_not_called()

    def test_regular_sell_fill_does_credit_wallet(self):
        """Confirm regular SELL fill still credits — SL exclusion is targeted."""
        svc.place_order(SESSION, "NIFTY", TradeSide.SELL, OrderType.TARGET, 1, 1, DATE, trigger_price=24000.0)
        credit_mock = MagicMock()
        with patch("app.services.wallet_service.credit", credit_mock):
            svc.check_orders(SESSION, 24000.0, 100, DATE)
        credit_mock.assert_called_once()


# ── Cancel SL — no wallet credit back ──────────────────────────────────────

class TestStoplossCancel:
    def test_cancel_buy_sl_does_not_credit_wallet(self):
        order = svc.place_order(
            SESSION, "NIFTY", TradeSide.BUY, OrderType.STOPLOSS, 1, 1, DATE,
            trigger_price=24000.0, is_stoploss=True,
        )
        credit_mock = MagicMock()
        with patch("app.services.wallet_service.credit", credit_mock):
            svc.cancel_order(SESSION, order.order_id, DATE)
        credit_mock.assert_not_called()
