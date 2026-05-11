"""
Integration tests for /api/orders endpoints.
DynamoDB writes and simulation sessions are stubbed.
"""
import pytest
from unittest.mock import patch, MagicMock
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.models.schemas import SimulationState
from app.services import order_service


SESSION = "api-order-session"


def _make_session(session_id: str = SESSION):
    session = MagicMock()
    session.session_id = session_id
    session.symbol = "NIFTY"
    session.date = "2026-05-06"
    session.current_time = "1746518100"
    session.state = SimulationState.RUNNING
    return session


@pytest.fixture(autouse=True)
def clean():
    order_service.clear_session(SESSION)
    yield
    order_service.clear_session(SESSION)


@pytest.fixture(autouse=True)
def no_db():
    with patch("app.services.order_service._write_order_to_db"), \
         patch("app.services.wallet_service.debit"), \
         patch("app.services.wallet_service.credit"):
        yield


@pytest.mark.asyncio
class TestPlaceTargetOrderEndpoint:
    async def test_place_buy_target(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "BUY",
                    "order_type": "TARGET",
                    "trigger_price": 24300.0,
                    "quantity": 1,
                })
        assert resp.status_code == 200
        data = resp.json()
        assert data["side"] == "BUY"
        assert data["order_type"] == "TARGET"
        assert data["trigger_price"] == 24300.0
        assert data["status"] == "PENDING"
        assert data["limit_price"] == pytest.approx(24543.0)  # 24300 * 1.01

    async def test_place_sell_target(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "SELL",
                    "order_type": "TARGET",
                    "trigger_price": 24000.0,
                    "quantity": 2,
                })
        assert resp.status_code == 200
        data = resp.json()
        assert data["side"] == "SELL"
        assert data["quantity"] == 2
        assert data["limit_price"] == pytest.approx(23760.0)  # 24000 * 0.99

    async def test_missing_trigger_price_returns_400(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "BUY",
                    "order_type": "TARGET",
                    "quantity": 1,
                })
        assert resp.status_code == 400

    async def test_invalid_trigger_price_returns_400(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "BUY",
                    "order_type": "TARGET",
                    "trigger_price": -5.0,
                    "quantity": 1,
                })
        assert resp.status_code == 400


@pytest.mark.asyncio
class TestPlaceLimitOrderEndpoint:
    async def test_place_buy_limit(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "BUY",
                    "order_type": "LIMIT",
                    "limit_price": 24000.0,
                    "quantity": 1,
                })
        assert resp.status_code == 200
        data = resp.json()
        assert data["order_type"] == "LIMIT"
        assert data["limit_price"] == 24000.0
        assert data["status"] == "PENDING"

    async def test_place_sell_limit(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "SELL",
                    "order_type": "LIMIT",
                    "limit_price": 24500.0,
                    "quantity": 2,
                })
        assert resp.status_code == 200
        data = resp.json()
        assert data["order_type"] == "LIMIT"
        assert data["limit_price"] == 24500.0

    async def test_missing_limit_price_returns_400(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "BUY",
                    "order_type": "LIMIT",
                    "quantity": 1,
                })
        assert resp.status_code == 400


@pytest.mark.asyncio
class TestCommonEndpointErrors:
    async def test_session_not_found_returns_404(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=None):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": "no-such-session",
                    "side": "BUY",
                    "order_type": "TARGET",
                    "trigger_price": 100.0,
                    "quantity": 1,
                })
        assert resp.status_code == 404

    async def test_simulation_not_started_returns_400(self):
        session = _make_session()
        session.current_time = None
        with patch("app.routers.orders.sim_svc.get_session", return_value=session):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await client.post("/api/orders", json={
                    "session_id": SESSION,
                    "side": "BUY",
                    "order_type": "TARGET",
                    "trigger_price": 100.0,
                    "quantity": 1,
                })
        assert resp.status_code == 400


@pytest.mark.asyncio
class TestGetOrdersEndpoint:
    async def test_returns_open_orders(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                await client.post("/api/orders", json={
                    "session_id": SESSION, "side": "BUY", "order_type": "TARGET",
                    "trigger_price": 100.0, "quantity": 1,
                })
                resp = await client.get(f"/api/orders?session_id={SESSION}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    async def test_open_only_false_returns_all(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                place_resp = await client.post("/api/orders", json={
                    "session_id": SESSION, "side": "BUY", "order_type": "TARGET",
                    "trigger_price": 100.0, "quantity": 1,
                })
                order_id = place_resp.json()["order_id"]
                await client.delete(f"/api/orders/{order_id}?session_id={SESSION}")
                open_resp = await client.get(f"/api/orders?session_id={SESSION}&open_only=true")
                all_resp = await client.get(f"/api/orders?session_id={SESSION}&open_only=false")
        assert len(open_resp.json()) == 0
        assert len(all_resp.json()) == 1


@pytest.mark.asyncio
class TestCancelOrderEndpoint:
    async def test_cancel_pending_order(self):
        with patch("app.routers.orders.sim_svc.get_session", return_value=_make_session()):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                place_resp = await client.post("/api/orders", json={
                    "session_id": SESSION, "side": "BUY", "order_type": "TARGET",
                    "trigger_price": 100.0, "quantity": 1,
                })
                order_id = place_resp.json()["order_id"]
                cancel_resp = await client.delete(f"/api/orders/{order_id}?session_id={SESSION}")
        assert cancel_resp.status_code == 200
        assert cancel_resp.json()["status"] == "CANCELLED"

    async def test_cancel_nonexistent_order_returns_404(self):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.delete(f"/api/orders/no-such-id?session_id={SESSION}")
        assert resp.status_code == 404
