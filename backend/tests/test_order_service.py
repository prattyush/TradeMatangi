"""
Unit tests for order_service. DynamoDB writes are patched out.
"""
import pytest
from unittest.mock import patch
from app.services import order_service as svc
from app.models.schemas import TradeSide, OrderStatus

SESSION = "order-test-session"


@pytest.fixture(autouse=True)
def clean():
    svc.clear_session(SESSION)
    yield
    svc.clear_session(SESSION)


@pytest.fixture(autouse=True)
def no_db(autouse=True):
    with patch("app.services.order_service._write_order_to_db"):
        yield


class TestPlaceOrder:
    def test_returns_pending_order(self):
        order = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 24300.0, 1, 1000)
        assert order.status == OrderStatus.PENDING
        assert order.side == TradeSide.BUY
        assert order.trigger_price == 24300.0
        assert order.session_id == SESSION

    def test_buy_limit_is_1pct_above_trigger(self):
        order = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 24000.0, 1, 1000)
        assert order.limit_price == pytest.approx(24240.0)

    def test_sell_limit_is_1pct_below_trigger(self):
        order = svc.place_order(SESSION, "NIFTY", TradeSide.SELL, 24000.0, 1, 1000)
        assert order.limit_price == pytest.approx(23760.0)

    def test_order_ids_are_unique(self):
        o1 = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        o2 = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 2)
        assert o1.order_id != o2.order_id


class TestGetOrders:
    def test_get_open_orders_empty_initially(self):
        assert svc.get_open_orders(SESSION) == []

    def test_returns_pending_orders(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        svc.place_order(SESSION, "NIFTY", TradeSide.SELL, 200.0, 1, 2)
        assert len(svc.get_open_orders(SESSION)) == 2

    def test_filled_orders_not_in_open(self):
        order = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        svc.check_orders(SESSION, 100.0, 2)
        assert svc.get_open_orders(SESSION) == []
        # but visible in get_all_orders
        all_orders = svc.get_all_orders(SESSION)
        assert any(o.order_id == order.order_id for o in all_orders)


class TestCancelOrder:
    def test_cancel_sets_cancelled(self):
        order = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        cancelled = svc.cancel_order(SESSION, order.order_id)
        assert cancelled is not None
        assert cancelled.status == OrderStatus.CANCELLED

    def test_cancel_removes_from_open(self):
        order = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        svc.cancel_order(SESSION, order.order_id)
        assert svc.get_open_orders(SESSION) == []

    def test_cancel_nonexistent_returns_none(self):
        assert svc.cancel_order(SESSION, "no-such-id") is None

    def test_cancel_filled_returns_none(self):
        order = svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        svc.check_orders(SESSION, 100.0, 2)
        assert svc.cancel_order(SESSION, order.order_id) is None


class TestCheckOrders:
    def test_buy_triggers_when_price_reaches_trigger(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 24300.0, 1, 1)
        filled = svc.check_orders(SESSION, 24300.0, 100)
        assert len(filled) == 1
        assert filled[0].status == OrderStatus.FILLED
        assert filled[0].filled_price == 24300.0
        assert filled[0].filled_at == 100

    def test_buy_triggers_when_price_above_trigger(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 24300.0, 1, 1)
        filled = svc.check_orders(SESSION, 24350.0, 100)
        assert len(filled) == 1

    def test_buy_does_not_trigger_below_trigger(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 24300.0, 1, 1)
        filled = svc.check_orders(SESSION, 24299.0, 100)
        assert filled == []

    def test_sell_triggers_when_price_reaches_trigger(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.SELL, 24100.0, 1, 1)
        filled = svc.check_orders(SESSION, 24100.0, 100)
        assert len(filled) == 1

    def test_sell_triggers_when_price_below_trigger(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.SELL, 24100.0, 1, 1)
        filled = svc.check_orders(SESSION, 24050.0, 100)
        assert len(filled) == 1

    def test_sell_does_not_trigger_above_trigger(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.SELL, 24100.0, 1, 1)
        filled = svc.check_orders(SESSION, 24101.0, 100)
        assert filled == []

    def test_already_filled_order_not_filled_twice(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        svc.check_orders(SESSION, 100.0, 10)
        filled_again = svc.check_orders(SESSION, 100.0, 20)
        assert filled_again == []

    def test_multiple_orders_can_fill_in_one_tick(self):
        svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 1, 1)
        svc.place_order(SESSION, "NIFTY", TradeSide.BUY, 100.0, 2, 2)
        filled = svc.check_orders(SESSION, 100.0, 10)
        assert len(filled) == 2
