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
        == 403
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


def test_exact_contract_lot_validation_and_invalid_master_do_not_create_context(
    client, monkeypatch
):
    path = start(client)
    headers = {"X-User-Id": "u"}

    def invalid(*a):
        raise ValueError("Contract is not listed")

    monkeypatch.setattr("app.services.breeze_master.listed_option_contract", invalid)
    option = {
        "symbol": "CANBK",
        "instrument_type": "options",
        "right": "CE",
        "strike": 125.5,
        "expiry": "2026-11-03",
    }
    response = client.post(path + "/contexts", json=option, headers=headers)
    assert response.status_code == 422, response.text
    assert client.get(path, headers=headers).json()["contexts"] == []
    monkeypatch.setattr(
        "app.services.breeze_master.listed_option_contract",
        lambda *a: {
            "strike": 125.5,
            "expiry": "2026-11-03",
            "right": "CE",
            "lot_size": 10,
        },
    )
    order = {
        **option,
        "side": "BUY",
        "order_type": "LIMIT",
        "quantity": 11,
        "price": 10,
        "request_id": "lot-check",
    }
    assert client.post(path + "/orders", json=order, headers=headers).status_code == 422
    accepted = client.post(
        path + "/orders", json={**order, "quantity": 10}, headers=headers
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["open_orders"][0]["strike"] == 125.5


def test_decimal_price_retry_uses_original_instructions_after_order_kind_changes(client):
    from app.services import order_service
    from app.models.schemas import OrderType
    path = start(client)
    headers = {'X-User-Id': 'u'}
    request = {'symbol': 'HDFCBANK', 'side': 'BUY', 'quantity': 1, 'price': 100.05, 'request_id': 'decimal-retry'}
    response = client.post(path + '/orders', json=request, headers=headers)
    assert response.status_code == 200, response.text
    identifier = response.json()['order_id']
    child = service.runtime('u', path.rsplit('/', 1)[-1]).contexts['HDFCBANK:equity']
    order = order_service.get_order(child.session_id, identifier)
    order.order_type = OrderType.TARGET
    order_service._write_order_to_db(order, strict=True)
    retry = client.post(path + '/orders', json=request, headers=headers)
    assert retry.status_code == 200, retry.text
    assert retry.json()['order_id'] == identifier
    assert client.post(path + '/orders', json={**request, 'price': 100.06}, headers=headers).status_code == 409


def test_legacy_order_retry_from_another_surface_does_not_duplicate(client):
    from app.services import order_service

    path = start(client)
    headers = {"X-User-Id": "u"}
    request = {"symbol": "HDFCBANK", "side": "BUY", "quantity": 1,
               "price": 100.05, "request_id": "legacy-surface"}
    placed = client.post(path + "/orders", json=request, headers=headers)
    assert placed.status_code == 200, placed.text
    identifier = placed.json()["order_id"]
    child = service.runtime("u", path.rsplit("/", 1)[-1]).contexts["HDFCBANK:equity"]
    order = order_service.get_order(child.session_id, identifier)
    order.analytics["swing_request"].pop("client", None)
    order_service._write_order_to_db(order, strict=True)
    retry = client.post(path + "/orders", json={**request, "client": "desktop"}, headers=headers)
    assert retry.status_code == 200, retry.text
    assert retry.json()["order_id"] == identifier
    assert retry.json()["wallet_balance"] == placed.json()["wallet_balance"]
    changed = client.post(path + "/orders", json={**request, "client": "desktop", "quantity": 2}, headers=headers)
    assert changed.status_code == 409


@pytest.mark.parametrize("broker", ["kotak", "kite"])
@pytest.mark.parametrize("authenticated", [False, True])
def test_selected_swing_broker_status_is_read_only_and_access_controlled(
    client, monkeypatch, broker, authenticated
):
    from unittest.mock import MagicMock

    from app import dependencies
    from app.services import execution_broker

    paper_path = start(client)
    denied = client.get(
        f"/api/swing/portfolios/broker-status?execution_broker={broker}",
        headers={"X-User-Id": "u"},
    )
    assert denied.status_code == 403
    monkeypatch.setattr(dependencies, "require_real_trading_access", lambda _: None)
    service = MagicMock()
    service.is_authenticated.return_value = authenticated
    resolve = MagicMock(return_value=service)
    monkeypatch.setattr(execution_broker, "get_service", resolve)
    response = client.get(
        f"/api/swing/portfolios/broker-status?execution_broker={broker}",
        headers={"X-User-Id": "u"},
    )
    assert response.status_code == 200 and response.json() == {
        "broker": broker,
        "authenticated": authenticated,
    }
    resolve.assert_called_once_with(broker)
    service.is_authenticated.assert_called_once()
    service.get_funds.assert_not_called()
    service.login_with_totp.assert_not_called()
    paper = client.get(paper_path, headers={"X-User-Id": "u"}).json()
    assert (
        paper["portfolio"]["state"] == "running" and paper["wallet_balance"] == 100000
    )
    assert (
        client.get(
            "/api/swing/portfolios/broker-status?execution_broker=other",
            headers={"X-User-Id": "u"},
        ).status_code
        == 422
    )
    assert (
        client.get(
            f"/api/swing/portfolios/broker-status?execution_broker={broker}"
        ).status_code
        == 401
    )


def test_capital_percentage_preview_is_read_only_and_submission_is_revalidated(client):
    from app.services import swing_portfolio_store as store
    path = start(client)
    headers = {"X-User-Id": "u"}
    body = {"symbol": "HDFCBANK", "side": "BUY", "order_type": "LIMIT", "quantity": 1,
            "price": 100, "request_id": "capital-size", "capital_pct": .1, "capital_revision": 0}
    preview = client.post(path + "/order-preview", json=body, headers=headers)
    assert preview.status_code == 200, preview.text
    sizing = preview.json()
    assert sizing["quantity"] == 99 and sizing["required_funds"] <= 10000
    parent_id = path.rsplit("/", 1)[-1]
    assert store.owned("u", parent_id)["contexts"] == {}
    assert client.get(path, headers=headers).json()["wallet_balance"] == 100000
    assert client.post(path + "/order-preview", json=body, headers={"X-User-Id": "other"}).status_code == 404
    assert client.post(path + "/orders", json=body, headers=headers).status_code == 409
    body["quantity"] = sizing["quantity"]
    first = client.post(path + "/orders", json=body, headers=headers)
    assert first.status_code == 200, first.text
    balance = first.json()["wallet_balance"]
    row = store.owned("u", parent_id)
    store.update("u", parent_id, {"guardrail_epoch": 1, "session_capital": 50000}, row["version"])
    retry = client.post(path + "/orders", json=body, headers=headers)
    assert retry.status_code == 200, retry.text
    assert retry.json()["order_id"] == first.json()["order_id"]
    assert retry.json()["wallet_balance"] == balance
    assert client.post(path + "/orders", json={**body, "request_id": "new"}, headers=headers).status_code == 409
    assert client.post(path + "/order-preview", json=body, headers=headers).status_code == 409


def test_percentage_preview_options_uses_listed_lots_without_creating_context(client, monkeypatch):
    from app.services import swing_portfolio_store as store
    path = start(client)
    headers = {"X-User-Id": "u"}
    monkeypatch.setattr("app.services.breeze_master.listed_option_contract", lambda *a: {"lot_size": 25})
    body = {"symbol": "CANBK", "instrument_type": "options", "right": "CE", "strike": 125.5,
            "expiry": "2026-10-27", "side": "BUY", "quantity": 1, "price": 100,
            "request_id": "preview", "capital_pct": .1, "capital_revision": 0}
    response = client.post(path + "/order-preview", json=body, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["quantity"] == 75
    assert store.owned("u", path.rsplit("/", 1)[-1])["contexts"] == {}
    assert client.post(path + "/order-preview", json={**body, "side": "SELL"}, headers=headers).status_code == 422


def test_futures_discovery_is_authenticated_read_only_and_execution_remains_gated(client, monkeypatch):
    from app.services import futures_risk
    monkeypatch.setattr(futures_risk, "settings", lambda: futures_risk.RiskSettings(paper_enabled=False))
    monkeypatch.setattr("app.services.futures_contracts.listed_contracts", lambda *a: [{"symbol":"NIFTY","instrument_type":"futures","expiry":"2026-10-27","lot_size":65}])
    route = "/api/swing/portfolios/contracts/futures?symbol=NIFTY&provider=kite"
    assert client.get(route).status_code == 401
    response = client.get(route, headers={"X-User-Id":"u"})
    assert response.status_code == 200 and response.json()["execution_enabled"] is False
    path = start(client)
    body = {"symbol":"NIFTY", "instrument_type":"futures", "expiry":"2026-10-27", "side":"BUY", "quantity":65, "price":22000, "request_id":"gated"}
    assert client.post(path + "/orders", json=body, headers={"X-User-Id":"u"}).status_code == 403
