"""Owned Paper portfolio controls and contract-scoped idempotent order actions."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from app.routers import swing
from app.services import swing_portfolio_service as service
from tests.test_swing_paper_runtime import db  # noqa: F401 — Shared moto setup; no external services.


@pytest.fixture
def client(db, monkeypatch):
    attach = service.attach_context
    ensure = service.ensure

    def without_feed(*args, **kwargs):
        return attach(*args, **{**kwargs, "subscribe": False})

    async def without_subscription(*args, **kwargs):
        return await ensure(*args, **{**kwargs, "subscribe": False})

    monkeypatch.setattr(service, "attach_context", without_feed)
    monkeypatch.setattr(service, "ensure", without_subscription)
    app = FastAPI()
    app.include_router(swing.router, prefix="/api")
    with TestClient(app) as client:
        yield client


def start(client):
    response = client.post(
        "/api/swing/portfolios", json={"capital": 100000}, headers={"X-User-Id": "u"}
    )
    assert response.status_code == 200, response.text
    return "/api/swing/portfolios/" + response.json()["portfolio"]["session_id"]


def test_auth_ownership_and_single_active_portfolio(client):
    assert client.get("/api/swing/portfolios/active").status_code == 401
    path = start(client)
    assert client.get(path, headers={"X-User-Id": "other"}).status_code == 404
    assert (
        client.post(
            "/api/swing/portfolios",
            json={"capital": 100000},
            headers={"X-User-Id": "u"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/swing/portfolios",
            json={"capital": 100000, "mode": "real"},
            headers={"X-User-Id": "u"},
        ).status_code
        == 422
    )


def test_order_retry_pause_and_detach_semantics(client):
    path = start(client)
    headers = {"X-User-Id": "u"}
    order = {
        "symbol": "HDFCBANK",
        "side": "BUY",
        "order_type": "LIMIT",
        "quantity": 10,
        "price": 100,
        "request_id": "purchase",
    }
    placed = client.post(path + "/orders", json=order, headers=headers)
    assert placed.status_code == 200, placed.text
    first = placed.json()
    retry = client.post(path + "/orders", json=order, headers=headers)
    assert retry.status_code == 200
    assert retry.json()["order_id"] == first["order_id"]
    assert retry.json()["wallet_balance"] == first["wallet_balance"]
    assert (
        client.post(
            path + "/orders", json={**order, "quantity": 20}, headers=headers
        ).status_code
        == 409
    )
    assert (
        client.post(path + "/pause", json={"paused": True}, headers=headers).status_code
        == 200
    )
    assert (
        client.post(
            path + "/orders", json={**order, "request_id": "second"}, headers=headers
        ).status_code
        == 403
    )
    assert (
        client.post(
            path + "/orders",
            json={**order, "side": "SELL", "request_id": "short"},
            headers=headers,
        ).status_code
        == 400
    )
    # Reading/reconnecting a screen neither resumes entries nor ends the book.
    current = client.get(path, headers=headers).json()
    assert current["portfolio"]["state"] == "running"
    assert current["portfolio"]["entries_paused"]
    assert (
        client.post(path + "/close", headers=headers).json()["portfolio"]["state"]
        == "ended"
    )
    assert (
        client.get("/api/swing/portfolios/active", headers=headers).json()["portfolio"]
        is None
    )


def test_contract_validation_and_cross_context_request_identity(client):
    path = start(client)
    headers = {"X-User-Id": "u"}
    order = {
        "symbol": "HDFCBANK",
        "side": "BUY",
        "order_type": "LIMIT",
        "quantity": 10,
        "price": 100,
        "request_id": "purchase",
    }
    first = client.post(path + "/orders", json=order, headers=headers).json()
    second = client.post(
        path + "/orders", json={**order, "symbol": "INFY"}, headers=headers
    )
    assert second.status_code == 200, second.text
    assert second.json()["order_id"] != first["order_id"]
    assert len(second.json()["open_orders"]) == 2
    assert second.json()["wallet_balance"] == 98000
    assert (
        client.post(
            path + "/contexts", json={"symbol": "NIFTY"}, headers=headers
        ).status_code
        == 422
    )
    assert (
        client.post(
            path + "/contexts",
            json={"symbol": "HDFCBANK", "strike": 100},
            headers=headers,
        ).status_code
        == 422
    )
    assert (
        client.post(
            path + "/contexts",
            json={
                "symbol": "CANBK",
                "instrument_type": "options",
                "right": "CE",
                "strike": 125.5,
                "expiry": "invalid",
            },
            headers=headers,
        ).status_code
        == 422
    )


def test_capital_reset_keeps_cash_and_manual_pause(client):
    path = start(client)
    headers = {"X-User-Id": "u"}
    client.post(path + "/pause", json={"paused": True}, headers=headers)
    reset = client.post(path + "/capital", json={"capital": 80000}, headers=headers)
    assert reset.status_code == 200, reset.text
    assert reset.json()["wallet_balance"] == 100000
    assert reset.json()["portfolio"]["session_capital"] == 80000
    assert reset.json()["portfolio"]["entries_paused"]
    assert reset.json()["portfolio"]["guardrail_epoch"] == 1


def test_legacy_session_controls_cannot_end_or_pause_a_portfolio_child(client):
    from app.routers import simulation, trading

    client.app.include_router(simulation.router)
    client.app.include_router(trading.router)
    path = start(client)
    attached = client.post(
        path + "/contexts", json={"symbol": "HDFCBANK"}, headers={"X-User-Id": "u"}
    ).json()
    sid = attached["session_id"]
    for action in ("pause", "resume", "stop"):
        response = client.post(
            "/api/simulation/" + action,
            json={"session_id": sid},
            headers={"X-User-Id": "u"},
        )
        assert response.status_code == 409, response.text
    for action in ("buy", "sell"):
        response = client.post(
            "/api/trades/" + action,
            json={"session_id": sid, "funds_ratio_pct": 0.1},
            headers={"X-User-Id": "u"},
        )
        assert response.status_code == 409, response.text
    assert (
        client.get(path, headers={"X-User-Id": "u"}).json()["portfolio"]["state"]
        == "running"
    )
