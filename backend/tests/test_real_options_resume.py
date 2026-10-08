"""Real option restarts select charts from reconciled, exact-contract positions."""
from contextlib import ExitStack
from datetime import datetime, timezone
import json
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi import HTTPException

from app.models.schemas import Order, OrderType, SimulationStartRequest, Trade, TradeSide
from app.routers import simulation as route
from app.services import fifo_positions, market_data, order_service, real_broker_state, simulation, trading
from app.services.kotak_service import KotakError


@pytest.fixture
def session():
    s = simulation.SimulationSession(session_id="real-options-resume", user_id="user",
        symbol="NIFTY", date="2026-10-08", start_time="09:15:00", speed=1,
        session_type="real", instrument_type="options", strike=24200,
        strike_ce=24200, strike_pe=24300, expiry="2026-10-13")
    simulation._sessions[s.session_id] = s
    trading._trades[s.session_id] = []
    order_service._orders[s.session_id] = {}
    yield s
    simulation._sessions.pop(s.session_id, None)
    trading.clear_session(s.session_id)
    order_service.clear_session(s.session_id)


def add_position(s, right, strike, timestamp, *, expiry=None, side=TradeSide.BUY):
    trading._trades[s.session_id].append(Trade(user_id=s.user_id, symbol=s.symbol,
        session_id=s.session_id, session_type="real", instrument_type="options",
        right=right, strike=strike, expiry=expiry or s.expiry, side=side,
        quantity=65, price=40, timestamp=timestamp))


@pytest.mark.asyncio
@pytest.mark.parametrize("rights", [("CE",), ("PE",), ("CE", "PE"), ()])
async def test_resume_selects_fresh_positions_before_response_and_feed(session, rights):
    s = session
    broker = Mock()
    stop = Order(order_id="stop", user_id=s.user_id, session_id=s.session_id,
        symbol=s.symbol, right="CE", strike=24000, expiry=s.expiry,
        side=TradeSide.SELL, quantity=65, order_type=OrderType.STOPLOSS,
        trigger_price=32, limit_price=31.5, created_at=100, kotak_order_id="broker-stop", execution_role="exit")
    order_service._orders[s.session_id][stop.order_id] = stop
    # Stale pre-stop state must not determine restart selection.
    add_position(s, "CE", 23900, 50)
    async def refresh(current, service):
        assert current is s and service is broker
        trading._trades[s.session_id] = []
        for right in rights:
            add_position(s, right, 24000, 100)
    with patch("app.services.real_broker_state.refresh", side_effect=refresh) as reconcile, \
         patch.object(simulation, "_upsert_session_to_db"):
        await route._prepare_real_options_resume(s, broker)
    reconcile.assert_awaited_once_with(s, broker)
    response = route._session_response(s)
    assert response.strike_ce == (24000 if "CE" in rights else 24200)
    assert response.strike_pe == (24000 if "PE" in rights else 24300)
    instruments = {i["right"]: i for i in market_data.session_instruments(s) if i["kind"] == "option"}
    assert instruments["CE"]["strike"] == response.strike_ce
    assert instruments["PE"]["strike"] == response.strike_pe
    assert all(i["expiry"] == s.expiry for i in instruments.values())
    assert order_service.get_order(s.session_id, "stop") is stop
    assert stop.kotak_order_id == "broker-stop"
    assert broker.mock_calls == []


def test_newest_open_position_wins_with_saved_expiry_and_closed_contracts(session):
    s = session
    add_position(s, "CE", 24000, 100)
    add_position(s, "CE", 24100, 200, side=TradeSide.SELL)
    add_position(s, "CE", 24150, 200)
    add_position(s, "CE", 23900, 300)
    add_position(s, "CE", 23900, 400, side=TradeSide.SELL)
    add_position(s, "CE", 24500, 500, expiry="2026-10-20")
    with patch.object(simulation, "_upsert_session_to_db"):
        simulation.resolve_website_resume_contracts(s)
    assert s.strike_ce == 24150 and s.strike_pe == 24300
    assert s.last_price_ce == s.last_price_pe == 0
    assert {item["strike"] for item in s.desktop_contracts} == {24000, 24100, 24150, 24500}


@pytest.mark.asyncio
async def test_failed_refresh_preserves_trading_state_and_returns_visible_error(session):
    with patch("app.services.real_broker_state.refresh", new=AsyncMock(side_effect=ValueError("incomplete history"))), \
         patch.object(simulation, "stop_session") as stop, \
         patch.object(simulation, "resolve_website_resume_contracts") as select:
        with pytest.raises(HTTPException) as error:
            await route._prepare_real_options_resume(session, Mock())
    assert error.value.status_code == 502
    assert "incomplete history" in error.value.detail
    stop.assert_called_once_with(session, preserve_trading_state=True)
    select.assert_not_called()


def test_real_stop_preserves_broker_orders(session):
    with patch.object(simulation, "_upsert_session_to_db"), \
         patch("app.services.kotak_service.get_service"), \
         patch("app.services.broker_position_events.stop"), \
         patch("app.services.broker_conversion.stop"), \
         patch("app.services.kite_service.get_broadcaster"), \
         patch("app.services.order_service.cancel_all_pending_orders") as cancel:
        simulation.stop_session(session)
    cancel.assert_not_called()
    assert simulation.get_session(session.session_id) is None


@pytest.mark.asyncio
async def test_start_route_reconciles_and_selects_before_starting_engine(session):
    s = session
    req = SimulationStartRequest(symbol=s.symbol, date=s.date, start_time=s.start_time,
        speed=1, session_type="real", instrument_type="options", strike=24200,
        strike_ce=24200, strike_pe=24300, expiry=s.expiry)
    group = {"group_id": "group", "date": s.date, "clock_family": "live",
        "strategy_interval_secs": 180, "member_session_ids": [], "state": "running"}
    broker = Mock()
    async def refresh(current, service):
        add_position(current, "PE", 24000, 100)
    def start(current):
        assert current.strike_pe == 24000
    patches = {
        "app.services.real_trading_day.state": Mock(return_value={"state": "active"}),
        "app.services.session_group_service.get_active_group": Mock(return_value=None),
        "app.services.session_group_service.create_group": Mock(return_value=group),
        "app.services.session_group_service.add_member": Mock(),
        "app.services.user_service.get_user_info": Mock(return_value={"is_admin": True}),
        "app.services.kotak_service.get_service": Mock(return_value=broker),
        "app.services.real_accounting.refresh": AsyncMock(return_value={"session_capital": 100000}),
        "app.services.real_broker_state.refresh": AsyncMock(side_effect=refresh),
        "app.services.simulation.find_session_by_context": Mock(return_value={"session_id": s.session_id}),
        "app.services.simulation.get_session": Mock(return_value=None),
        "app.services.simulation.rebuild_session_from_db": Mock(return_value=s),
        "app.services.simulation._upsert_session_to_db": Mock(),
        "app.services.simulation.start_session": Mock(side_effect=start),
        "app.routers.simulation._normalise_option_contract_request": Mock(),
        "app.routers.simulation._soft_ensure": Mock(),
    }
    with ExitStack() as stack:
        for target, replacement in patches.items():
            stack.enter_context(patch(target, new=replacement))
        result = await route._start_simulation_impl(req, s.user_id)
    assert result.strike_pe == 24000 and result.strike_ce == 24200
    patches["app.services.real_broker_state.refresh"].assert_awaited_once_with(s, broker)
    patches["app.services.simulation.start_session"].assert_called_once_with(s)
    patches["app.services.simulation.rebuild_session_from_db"].assert_called_once()
    assert not broker.place_options_sl_order.called
    assert not broker.modify_sl_order.called
    assert not broker.cancel_order.called


def saved_snapshot(s):
    timestamp = int(datetime.fromisoformat(f"{s.date}T10:00:00").replace(tzinfo=timezone.utc).timestamp())
    s._fifo_executions = [{"symbol": "NIFTY26O1324000PE", "exchange": "nse_fo",
        "product": "MIS", "side": "BUY", "quantity": 65, "price": 40,
        "timestamp": timestamp, "execution_id": "execution", "kotak_order_id": "entry"}]
    s.broker_positions = fifo_positions.positions(s, s._fifo_executions)
    s.broker_projection_id = real_broker_state.projection_id(s, "account")
    add_position(s, "PE", 24000, timestamp)


@pytest.mark.asyncio
async def test_timeout_resumes_verified_saved_contract_with_warning(session):
    s = session
    saved_snapshot(s)
    broker = Mock()
    broker.account_identity.return_value = "account"
    timeout = KotakError("Kotak positions: Kotak SDK/transport failure: (0)\nReason: Request timeout after 30 seconds")
    with patch("app.services.real_broker_state.refresh", new=AsyncMock(side_effect=timeout)), \
         patch.object(simulation, "_upsert_session_to_db"), \
         patch.object(simulation, "stop_session") as stop:
        await route._prepare_real_options_resume(s, broker)
    assert s.strike_pe == 24000 and s.strike_ce == 24200
    assert s.broker_positions[0]["quantity"] == 65
    stop.assert_not_called()
    warning = json.loads(s.queue.get_nowait())
    assert warning["type"] == "broker_error"
    assert "Trade History Refresh" in warning["message"]
    assert "saved" in warning["message"]
    assert not broker.place_options_sl_order.called
    assert not broker.modify_sl_order.called
    assert not broker.cancel_order.called


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["missing", "unverified", "account", "mismatch", "not_timeout"])
async def test_timeout_fallback_requires_verified_snapshot_for_same_account(session, invalid):
    s = session
    saved_snapshot(s)
    broker = Mock()
    broker.account_identity.return_value = "account"
    if invalid == "missing":
        s.broker_positions = None
    elif invalid == "unverified":
        s._fifo_executions = None
    elif invalid == "account":
        broker.account_identity.return_value = "other-account"
    elif invalid == "mismatch":
        s.broker_positions[0]["quantity"] = 130
    error = KotakError("Malformed Kotak positions response" if invalid == "not_timeout" else "Request timeout after 30 seconds")
    with patch("app.services.real_broker_state.refresh", new=AsyncMock(side_effect=error)), \
         patch.object(simulation, "stop_session") as stop:
        with pytest.raises(HTTPException) as caught:
            await route._prepare_real_options_resume(s, broker)
    assert caught.value.status_code == 502
    stop.assert_called_once_with(s, preserve_trading_state=True)
    assert s.queue.empty()
