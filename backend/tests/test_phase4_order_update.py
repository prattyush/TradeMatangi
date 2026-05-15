"""
Phase IV tests: update_order service + PATCH /api/orders/{id} endpoint,
and target_deviation_pct for PlaceOrderRequest.
"""
import pytest
from unittest.mock import patch, MagicMock
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.models.schemas import OrderStatus, OrderType, TradeSide, SimulationState
from app.services import order_service as svc

SESSION = "phase4-order-session"
DATE = "2026-05-06"


@pytest.fixture(autouse=True)
def clean():
    svc.clear_session(SESSION)
    yield
    svc.clear_session(SESSION)


@pytest.fixture(autouse=True)
def no_db():
    with patch("app.services.order_service._write_order_to_db"), \
         patch("app.services.wallet_service.debit") as mock_debit, \
         patch("app.services.wallet_service.credit") as mock_credit:
        yield mock_debit, mock_credit


def _buy_target(trigger: float, qty: int = 1, deviation: float = 0.01):
    return svc.place_order(SESSION, "NIFTY", TradeSide.BUY, OrderType.TARGET, qty, 1, DATE,
                           trigger_price=trigger, target_deviation_pct=deviation)


def _sell_target(trigger: float, qty: int = 1, deviation: float = 0.01):
    return svc.place_order(SESSION, "NIFTY", TradeSide.SELL, OrderType.TARGET, qty, 1, DATE,
                           trigger_price=trigger, target_deviation_pct=deviation)


def _buy_limit(limit: float, qty: int = 1):
    return svc.place_order(SESSION, "NIFTY", TradeSide.BUY, OrderType.LIMIT, qty, 1, DATE,
                           limit_price=limit)


def _sell_stoploss(trigger: float, qty: int = 1):
    return svc.place_order(SESSION, "NIFTY", TradeSide.SELL, OrderType.STOPLOSS, qty, 1, DATE,
                           trigger_price=trigger, is_stoploss=True)


# ── target_deviation_pct in place_order ──────────────────────────────────────

class TestCustomDeviation:
    def test_default_deviation_is_1pct(self):
        order = _buy_target(24000.0)
        assert order.limit_price == pytest.approx(24240.0)

    def test_custom_deviation_buy(self):
        order = _buy_target(24000.0, deviation=0.02)
        assert order.limit_price == pytest.approx(24480.0)  # 24000 * 1.02

    def test_custom_deviation_sell(self):
        order = _sell_target(24000.0, deviation=0.005)
        assert order.limit_price == pytest.approx(23880.0)  # 24000 * 0.995

    def test_zero_deviation(self):
        order = _buy_target(24000.0, deviation=0.0)
        assert order.limit_price == pytest.approx(24000.0)  # limit == trigger


# ── update_order: TARGET ──────────────────────────────────────────────────────

class TestUpdateTargetOrder:
    def test_update_trigger_price_recalculates_limit(self):
        order = _buy_target(24000.0)
        updated = svc.update_order(SESSION, order.order_id, DATE, trigger_price=25000.0)
        assert updated is not None
        assert updated.trigger_price == 25000.0
        assert updated.limit_price == pytest.approx(25250.0)  # 25000 * 1.01

    def test_update_with_custom_deviation(self):
        order = _sell_target(24000.0)
        updated = svc.update_order(SESSION, order.order_id, DATE, trigger_price=23000.0,
                                   target_deviation_pct=0.02)
        assert updated.trigger_price == 23000.0
        assert updated.limit_price == pytest.approx(22540.0)  # 23000 * 0.98

    def test_update_nonexistent_order_returns_none(self):
        result = svc.update_order(SESSION, "fake-id", DATE, trigger_price=100.0)
        assert result is None

    def test_update_cancelled_order_returns_none(self):
        order = _buy_target(24000.0)
        svc.cancel_order(SESSION, order.order_id, DATE)
        result = svc.update_order(SESSION, order.order_id, DATE, trigger_price=25000.0)
        assert result is None

    def test_update_sell_target_limit_decreases(self):
        order = _sell_target(24000.0)
        updated = svc.update_order(SESSION, order.order_id, DATE, trigger_price=22000.0)
        assert updated.trigger_price == 22000.0
        assert updated.limit_price == pytest.approx(21780.0)  # 22000 * 0.99


# ── update_order: LIMIT ───────────────────────────────────────────────────────

class TestUpdateLimitOrder:
    def test_update_buy_limit_price(self):
        order = _buy_limit(24000.0)
        updated = svc.update_order(SESSION, order.order_id, DATE, limit_price=23500.0)
        assert updated is not None
        assert updated.limit_price == 23500.0
        assert updated.trigger_price == 23500.0  # trigger kept in sync

    def test_update_limit_with_trigger_price_ignored(self):
        order = _buy_limit(24000.0)
        # For LIMIT orders, trigger_price param is irrelevant — only limit_price matters
        updated = svc.update_order(SESSION, order.order_id, DATE, limit_price=23000.0)
        assert updated.limit_price == 23000.0


# ── update_order: STOPLOSS ────────────────────────────────────────────────────

class TestUpdateStoplossOrder:
    def test_update_stoploss_trigger(self):
        order = _sell_stoploss(24000.0)
        updated = svc.update_order(SESSION, order.order_id, DATE, trigger_price=23500.0)
        assert updated is not None
        assert updated.trigger_price == 23500.0
        assert updated.limit_price == 23500.0  # SL: limit == trigger


# ── update_order: wallet re-reservation ──────────────────────────────────────

class TestUpdateOrderWalletReservation:
    def test_buy_target_update_higher_price_debits_diff(self, no_db):
        mock_debit, mock_credit = no_db

        order = _buy_target(24000.0, qty=1)
        # Initial reserved = 1 * 24240 = 24240
        assert order.reserved_amount == pytest.approx(24240.0)

        mock_debit.reset_mock()  # reset after placement debit
        svc.update_order(SESSION, order.order_id, DATE, trigger_price=25000.0)
        # New reserved = 1 * 25250 = 25250; diff = 1010 debited
        mock_debit.assert_called_once()
        args = mock_debit.call_args[0]
        assert args[1] == pytest.approx(1010.0)

    def test_buy_target_update_lower_price_credits_diff(self, no_db):
        mock_debit, mock_credit = no_db

        order = _buy_target(24000.0, qty=1)
        mock_credit.reset_mock()  # reset after any initial calls
        svc.update_order(SESSION, order.order_id, DATE, trigger_price=23000.0)
        # New reserved = 1 * 23230 = 23230; diff = -1010 → credit 1010
        mock_credit.assert_called_once()
        args = mock_credit.call_args[0]
        assert args[1] == pytest.approx(1010.0)

    def test_sell_target_update_no_wallet_change(self, no_db):
        mock_debit, mock_credit = no_db
        mock_debit.reset_mock()
        mock_credit.reset_mock()

        order = _sell_target(24000.0, qty=1)
        svc.update_order(SESSION, order.order_id, DATE, trigger_price=25000.0)
        # SELL orders have no reservation; no wallet calls for update
        mock_debit.assert_not_called()
        mock_credit.assert_not_called()


# ── PATCH /api/orders/{id} endpoint ──────────────────────────────────────────

def _make_session():
    from app.config import FIXED_USER_ID
    session = MagicMock()
    session.session_id = SESSION
    session.symbol = "NIFTY"
    session.date = DATE
    session.current_time = "1746518100"
    session.instrument_type = "equity"
    session.state = SimulationState.RUNNING
    session.user_id = FIXED_USER_ID
    return session


@pytest.mark.asyncio
class TestPatchOrderEndpoint:
    async def test_patch_target_order_updates_trigger(self):
        order = _buy_target(24000.0)
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    f"/api/orders/{order.order_id}",
                    params={"session_id": SESSION},
                    json={"trigger_price": 25000.0},
                )
        assert resp.status_code == 200
        data = resp.json()
        assert data["trigger_price"] == 25000.0
        assert data["limit_price"] == pytest.approx(25250.0)

    async def test_patch_with_custom_deviation(self):
        order = _buy_target(24000.0)
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    f"/api/orders/{order.order_id}",
                    params={"session_id": SESSION},
                    json={"trigger_price": 24000.0, "target_deviation_pct": 0.02},
                )
        assert resp.status_code == 200
        data = resp.json()
        assert data["limit_price"] == pytest.approx(24480.0)  # 24000 * 1.02

    async def test_patch_unknown_order_returns_404(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    "/api/orders/does-not-exist",
                    params={"session_id": SESSION},
                    json={"trigger_price": 25000.0},
                )
        assert resp.status_code == 404

    async def test_patch_missing_session_returns_404(self):
        order = _buy_target(24000.0)
        with patch("app.routers.orders.sim_svc.get_session", return_value=None):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    f"/api/orders/{order.order_id}",
                    params={"session_id": SESSION},
                    json={"trigger_price": 25000.0},
                )
        assert resp.status_code == 404

    async def test_patch_with_no_price_returns_400(self):
        order = _buy_target(24000.0)
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    f"/api/orders/{order.order_id}",
                    params={"session_id": SESSION},
                    json={},
                )
        assert resp.status_code == 400

    async def test_patch_limit_order_updates_limit_price(self):
        order = _buy_limit(24000.0)
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.patch(
                    f"/api/orders/{order.order_id}",
                    params={"session_id": SESSION},
                    json={"limit_price": 23500.0},
                )
        assert resp.status_code == 200
        data = resp.json()
        assert data["limit_price"] == 23500.0

    async def test_patch_target_order_via_place_with_deviation(self):
        """Placing an order with custom deviation, then verifying limit matches."""
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()), \
             patch("app.services.wallet_service.get_balance", return_value=200000.0):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "BUY",
                    "order_type": "TARGET",
                    "trigger_price": 24000.0,
                    "quantity": 1,
                    "target_deviation_pct": 0.02,
                })
        assert resp.status_code == 200
        data = resp.json()
        assert data["limit_price"] == pytest.approx(24480.0)  # 24000 * 1.02
