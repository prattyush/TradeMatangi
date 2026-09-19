from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import OrderType, SimulationState, TradeSide
from app.services import order_service, simulation as sim_svc, trading as trading_service

client = TestClient(app)
HEADERS = {"X-User-Id": "desktop-user"}


def _session():
    session = sim_svc.SimulationSession(
        session_id="desktop-stepwise-test",
        symbol="NIFTY",
        date="2026-05-06",
        start_time="09:15:00",
        speed=1,
        user_id="desktop-user",
        instrument_type="options",
        strike=24000,
        strike_ce=24000,
        strike_pe=24000,
        expiry="2026-05-07",
        session_type="stepwise",
        stepwise=True,
        wallet_ledger_id="sim:2026-05-06",
    )
    session.state = SimulationState.RUNNING
    session.current_time = "1778058900"
    session.last_price = 24000
    session.last_price_ce = 100
    session.last_price_pe = 120
    session.session_capital = 150000
    sim_svc._sessions[session.session_id] = session
    return session


def _clear(session_id="desktop-stepwise-test"):
    sim_svc._sessions.pop(session_id, None)
    order_service.clear_session(session_id)
    trading_service.clear_session(session_id)


def test_desktop_bulk_convert_uses_clicked_price_for_closing_orders(no_db):
    _clear()
    session = _session()
    trading_service.record_trade(
        session_id=session.session_id,
        side=TradeSide.BUY,
        price=100,
        timestamp=1778058900,
        quantity=65,
        symbol="NIFTY",
        instrument_type="options",
        strike=24000,
        expiry="2026-05-07",
        right="CE",
        user_id="desktop-user",
        session_type="stepwise",
    )
    order = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=90,
        right="CE",
        strike=24000,
        user_id="desktop-user",
    )

    response = client.patch(
        f"/api/desktop/v1/trading/{session.session_id}/orders/bulk-convert",
        headers=HEADERS,
        json={"new_order_type": "LIMIT", "right": "CE", "price": 96.5},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["converted"] == 1
    updated = order_service.get_order(session.session_id, order.order_id)
    assert updated.order_type == OrderType.LIMIT
    assert updated.limit_price == 96.5
    assert updated.is_stoploss is False
    _clear()


def test_desktop_convert_rejects_other_user_session(no_db):
    _clear()
    session = _session()
    order = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=90,
        right="CE",
        strike=24000,
        user_id="desktop-user",
    )

    response = client.post(
        f"/api/desktop/v1/trading/{session.session_id}/orders/{order.order_id}/convert",
        headers={"X-User-Id": "someone-else"},
        json={"session_id": session.session_id, "new_order_type": "LIMIT", "price": 95},
    )

    assert response.status_code == 404
    _clear()


def test_desktop_attach_contract_rejects_different_symbol(no_db, monkeypatch):
    _clear()
    session = _session()
    monkeypatch.setattr("app.routers.desktop_trading.simulation_router._ensure_options_data", lambda *args, **kwargs: None)

    response = client.post(
        f"/api/desktop/v1/trading/{session.session_id}/contracts",
        headers=HEADERS,
        json={"symbol": "BANKNIFTY", "expiry": "2026-05-07", "strike": 52000, "right": "CE"},
    )

    assert response.status_code == 400
    assert "locked to NIFTY" in response.json()["detail"]
    _clear()


def test_desktop_order_requires_attached_option_contract(no_db):
    _clear()
    session = _session()

    response = client.post(
        f"/api/desktop/v1/trading/{session.session_id}/orders",
        headers=HEADERS,
        json={
            "session_id": session.session_id,
            "side": "SELL",
            "order_type": "STOPLOSS",
            "quantity": 65,
            "trigger_price": 91,
            "right": "CE",
            "strike": 24100,
            "expiry": "2026-05-07",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Option contract is not attached to this Stepwise session"
    _clear()


def test_desktop_attached_contract_order_is_contract_scoped(no_db, monkeypatch):
    _clear()
    session = _session()
    monkeypatch.setattr("app.routers.desktop_trading.simulation_router._ensure_options_data", lambda *args, **kwargs: None)

    attach = client.post(
        f"/api/desktop/v1/trading/{session.session_id}/contracts",
        headers=HEADERS,
        json={"symbol": "NIFTY", "expiry": "2026-05-07", "strike": 24100, "right": "CE"},
    )
    assert attach.status_code == 200

    response = client.post(
        f"/api/desktop/v1/trading/{session.session_id}/orders",
        headers=HEADERS,
        json={
            "session_id": session.session_id,
            "side": "SELL",
            "order_type": "STOPLOSS",
            "quantity": 65,
            "trigger_price": 91,
            "right": "CE",
            "strike": 24100,
            "expiry": "2026-05-07",
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["strike"] == 24100
    assert data["expiry"] == "2026-05-07"
    assert data["source"] == "desktop_stepwise"
    _clear()
