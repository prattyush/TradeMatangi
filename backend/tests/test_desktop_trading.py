import pytest
import asyncio
from fastapi.testclient import TestClient
from fastapi import HTTPException
from unittest.mock import patch

from app.main import app
from app.models.schemas import ConvertOrderRequest, OrderType, PlaceOrderRequest, SimulationState, TradeSide, WalletResetRequest
from app.routers import desktop_trading
from app.services import order_service, simulation as sim_svc, trading as trading_service, wallet_service

client = TestClient(app)
HEADERS = {"X-User-Id": "desktop-user"}


@pytest.fixture(autouse=True)
def no_db():
    wallet_service._ledgers[("desktop-user", "sim:2026-05-06")] = 150000
    with patch("app.services.order_service._write_order_to_db"), \
         patch("app.services.trading._write_trade_to_db"), \
         patch("app.services.wallet_service.debit"), \
         patch("app.services.wallet_service.credit"), \
         patch("app.services.wallet_service._ensure_ledger_table"), \
         patch("app.services.wallet_service._write_ledger"), \
         patch("app.routers.desktop_trading.get_settings", return_value={
             "desktop_hide_chart_labels": False,
             "desktop_order_size_mode": "quantity",
             "desktop_pnl_display_mode": "currency",
             "desktop_confirm_flatten": True,
             "context_menu_sl_mode": "longOnly",
             "target_deviation_pct": 0.01,
             "funds_ratio_l_pct": 0.03,
             "funds_ratio_m_pct": 0.06,
             "funds_ratio_h_pct": 0.12,
             "risk_ratio_l_pct": 0.01,
             "risk_ratio_m_pct": 0.02,
             "risk_ratio_h_pct": 0.04,
             "default_sl_pct": 0.20,
         }):
        yield
    wallet_service._ledgers.pop(("desktop-user", "sim:2026-05-06"), None)


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
    session.desktop_contracts = [{"symbol": "NIFTY", "expiry": "2026-05-07", "strike": 24000, "right": "CE", "contract_key": "NIFTY:2026-05-07:24000:CE"}]
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

    response = asyncio.run(desktop_trading.bulk_convert(
        session.session_id,
        desktop_trading.BulkChartConvertRequest(new_order_type=OrderType.LIMIT, right="CE", price=96.5),
        user_id="desktop-user",
    ))

    assert response["converted"] == 1
    updated = order_service.get_order(session.session_id, order.order_id)
    assert updated.order_type == OrderType.LIMIT
    assert updated.limit_price == 96.5
    assert updated.is_stoploss is False
    _clear()


def test_desktop_bulk_update_sl_only_updates_stoploss_closing_orders(no_db):
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
    sl = order_service.place_order(
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
        expiry="2026-05-07",
        user_id="desktop-user",
    )
    limit = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.LIMIT,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        limit_price=112,
        right="CE",
        strike=24000,
        expiry="2026-05-07",
        user_id="desktop-user",
    )

    response = asyncio.run(desktop_trading.bulk_update_sl(
        session.session_id,
        desktop_trading.BulkChartUpdateSLRequest(right="CE", strike=24000, expiry="2026-05-07", trigger_price=94.25),
        user_id="desktop-user",
    ))

    assert response["updated"] == 1
    assert order_service.get_order(session.session_id, sl.order_id).trigger_price == 94.25
    assert order_service.get_order(session.session_id, limit.order_id).limit_price == 112
    _clear()


def test_desktop_wallet_reset_updates_session_ledger(no_db):
    _clear()
    session = _session()

    response = asyncio.run(desktop_trading.reset_wallet(session.session_id, WalletResetRequest(amount=123456), user_id="desktop-user"))
    current = asyncio.run(desktop_trading.wallet(session.session_id, user_id="desktop-user"))

    assert response["balance"] == 123456
    assert current["balance"] == 123456
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

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.convert_order(
            session.session_id,
            order.order_id,
            ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.LIMIT, price=95),
            user_id="someone-else",
        ))
    assert exc.value.status_code == 404
    _clear()


def test_desktop_attach_contract_rejects_different_symbol(no_db, monkeypatch):
    _clear()
    session = _session()
    monkeypatch.setattr("app.routers.desktop_trading.simulation_router._ensure_options_data", lambda *args, **kwargs: None)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.attach_contract(
            session.session_id,
            desktop_trading.AttachContractRequest(symbol="BANKNIFTY", expiry="2026-05-07", strike=52000, right="CE"),
            user_id="desktop-user",
        ))
    assert exc.value.status_code == 400
    assert "locked to NIFTY" in exc.value.detail
    _clear()


def test_desktop_order_requires_attached_option_contract(no_db):
    _clear()
    session = _session()

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.place_order(
            session.session_id,
            PlaceOrderRequest(
                session_id=session.session_id,
                side=TradeSide.SELL,
                order_type=OrderType.STOPLOSS,
                quantity=65,
                trigger_price=91,
                right="CE",
                strike=24100,
                expiry="2026-05-07",
            ),
            user_id="desktop-user",
        ))

    assert exc.value.status_code == 400
    assert exc.value.detail == "Option contract is not attached to this Stepwise session"
    _clear()


def test_desktop_attached_contract_order_is_contract_scoped(no_db, monkeypatch):
    _clear()
    session = _session()
    monkeypatch.setattr("app.routers.desktop_trading.simulation_router._ensure_options_data", lambda *args, **kwargs: None)

    asyncio.run(desktop_trading.attach_contract(
        session.session_id,
        desktop_trading.AttachContractRequest(symbol="NIFTY", expiry="2026-05-07", strike=24100, right="CE"),
        user_id="desktop-user",
    ))

    order = asyncio.run(desktop_trading.place_order(
        session.session_id,
        PlaceOrderRequest(
            session_id=session.session_id,
            side=TradeSide.SELL,
            order_type=OrderType.STOPLOSS,
            quantity=65,
            trigger_price=91,
            right="CE",
            strike=24100,
            expiry="2026-05-07",
        ),
        user_id="desktop-user",
    ))

    assert order.strike == 24100
    assert order.expiry == "2026-05-07"
    assert order.source == "desktop_stepwise"
    _clear()
