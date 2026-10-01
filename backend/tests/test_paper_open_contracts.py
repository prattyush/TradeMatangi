"""Website paper resume must distinguish positions at different option strikes."""

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.models.schemas import Trade, TradeSide
from app.routers import trading as route, simulation as simulation_route
from app.services import trading as service
from app.models.schemas import UpdatePaneStrikeRequest


SESSION = "paper-contract-resume-test"
USER = "paper-user"
EXPIRY = "2026-10-01"


def trade(right: str, strike: int, side: TradeSide, timestamp: int) -> Trade:
    return Trade(user_id=USER, symbol="NIFTY", side=side, quantity=65, price=26.2,
                 timestamp=timestamp, session_id=SESSION, instrument_type="options",
                 right=right, strike=strike, expiry=EXPIRY, session_type="paper")


@pytest.mark.asyncio
async def test_open_contracts_do_not_net_different_pe_strikes():
    session = SimpleNamespace(session_id=SESSION, user_id=USER, symbol="NIFTY",
                              session_type="paper", instrument_type="options", desktop_origin=None)
    service._trades[SESSION] = [
        trade("PE", 24000, TradeSide.BUY, 100),
        trade("PE", 24100, TradeSide.SELL, 200),
        trade("CE", 24200, TradeSide.BUY, 300),
        trade("CE", 24200, TradeSide.SELL, 400),
    ]
    try:
        # The legacy right-only position is flat; both PE contracts remain open.
        assert service.get_position(SESSION, symbol="NIFTY", right="PE").side == "FLAT"
        with patch.object(route.sim_svc, "get_session", return_value=session):
            contracts = await route.get_open_option_contracts(SESSION, USER)
        assert [(item["right"], item["strike"], item["position"]["side"])
                for item in contracts] == [("PE", 24000, "LONG"), ("PE", 24100, "SHORT")]
        assert contracts[-1]["last_opened_at"] == 200
    finally:
        service.clear_session(SESSION)


@pytest.mark.asyncio
async def test_closed_older_contract_is_not_restored():
    session = SimpleNamespace(session_id=SESSION, user_id=USER, symbol="NIFTY",
                              session_type="paper", instrument_type="options", desktop_origin=None)
    service._trades[SESSION] = [
        trade("PE", 24000, TradeSide.BUY, 100),
        trade("PE", 24000, TradeSide.SELL, 150),
        trade("PE", 24100, TradeSide.BUY, 200),
    ]
    try:
        with patch.object(route.sim_svc, "get_session", return_value=session):
            contracts = await route.get_open_option_contracts(SESSION, USER)
        assert [(item["right"], item["strike"]) for item in contracts] == [("PE", 24100)]
    finally:
        service.clear_session(SESSION)


@pytest.mark.asyncio
async def test_paper_strike_change_persists_and_discards_previous_quote():
    session = SimpleNamespace(session_id=SESSION, user_id=USER, symbol="NIFTY",
                              session_type="paper", instrument_type="options", desktop_origin=None,
                              expiry=EXPIRY, strike_ce=24200, strike_pe=24000,
                              last_price_ce=42.0, last_price_pe=26.2,
                              fyers_streaming=False, breeze_streaming=False,
                              kotak_streaming=False, paper_base_contracts={"PE": {"strike": 24000, "expiry": EXPIRY}}, paper_tick_queue=object())
    loop = asyncio.get_running_loop()
    def run_immediately(_executor, fn):
        future = loop.create_future()
        try:
            future.set_result(fn())
        except Exception as exc:
            future.set_exception(exc)
        return future

    with patch.object(loop, "run_in_executor", side_effect=run_immediately), \
         patch.object(simulation_route.sim_svc, "get_session", return_value=session), \
         patch.object(simulation_route, "_ensure_options_data"), \
         patch("app.services.kite_service.fetch_options_instrument_token", return_value=12345), \
         patch("app.services.kite_service.get_broadcaster") as broadcaster, \
         patch.object(simulation_route.sim_svc, "_upsert_session_to_db") as persist:
        await asyncio.wait_for(simulation_route.update_pane_strike(SESSION, UpdatePaneStrikeRequest(right="PE", strike=24100)), timeout=3)
    assert session.strike_pe == 24100
    assert session.last_price_pe == 0
    assert session.last_price_ce == 42.0
    assert session.paper_base_contracts["PE"] == {"strike": 24100, "expiry": EXPIRY}
    broadcaster.return_value.update_session_right.assert_called_once()
    persist.assert_called_once_with(session)


@pytest.mark.parametrize("open_right", [None, "CE", "PE"])
def test_resume_uses_open_position_per_side_and_preserves_pending_contracts(open_right):
    from app.services import simulation, order_service, strategy_service
    from app.models.schemas import Order, OrderType
    s = simulation.SimulationSession(session_id=SESSION, user_id=USER, symbol="NIFTY", date="2026-10-01",
        start_time="09:15:00", speed=1, session_type="paper", instrument_type="options",
        strike=24200, strike_ce=24200, strike_pe=24300, expiry=EXPIRY)
    s.guardrail_ban_active = True
    s.session_capital = 100000
    originals = [trade(open_right, 24000, TradeSide.BUY, 100)] if open_right else []
    # A closed older contract must not dictate either chart's selection.
    originals += [trade("CE", 23900, TradeSide.BUY, 10), trade("CE", 23900, TradeSide.SELL, 20)]
    service._trades[SESSION] = originals
    pending = Order(order_id="keep-order", session_id=SESSION, user_id=USER, symbol="NIFTY", side=TradeSide.BUY,
        quantity=65, order_type=OrderType.LIMIT, trigger_price=20, limit_price=20, created_at=30,
        right="PE", strike=23800, expiry=EXPIRY, reserved_amount=1300)
    order_service._orders[SESSION] = {pending.order_id: pending}
    strategy_service._registry[SESSION] = [SimpleNamespace(strategy_id="keep-strategy", metadata={"progress": 2})]
    try:
        with patch.object(simulation, "_upsert_session_to_db") as persist:
            simulation.resolve_website_paper_resume_contracts(s)
        assert s.strike_ce == (24000 if open_right == "CE" else 24200)
        assert s.strike_pe == (24000 if open_right == "PE" else 24300)
        assert service.get_trades(SESSION) is originals
        assert order_service.get_order(SESSION, pending.order_id) is pending
        assert pending.strike == 23800 and pending.reserved_amount == 1300
        assert strategy_service._registry[SESSION][0].metadata == {"progress": 2}
        assert s.session_capital == 100000 and s.guardrail_ban_active
        assert any(item["strike"] == 23800 for item in s.desktop_contracts)
        persist.assert_called_once_with(s)
    finally:
        service.clear_session(SESSION)
        order_service.clear_session(SESSION)
        strategy_service.clear_session(SESSION)


def test_resume_newest_open_contract_wins_and_tracks_all_other_positions():
    from app.services import simulation, order_service
    s = simulation.SimulationSession(session_id=SESSION, symbol="NIFTY", date="2026-10-01", start_time="09:15:00", speed=1,
        session_type="paper", instrument_type="options", strike_ce=24200, strike_pe=24300, expiry=EXPIRY)
    service._trades[SESSION] = [trade("PE", 24000, TradeSide.BUY, 100), trade("PE", 24100, TradeSide.SELL, 200)]
    order_service._orders[SESSION] = {}
    try:
        with patch.object(simulation, "_upsert_session_to_db"):
            simulation.resolve_website_paper_resume_contracts(s)
        assert s.strike_pe == 24100 and s.strike_ce == 24200
        assert {item["strike"] for item in s.desktop_contracts} == {24000, 24100}
    finally:
        service.clear_session(SESSION)
        order_service.clear_session(SESSION)
