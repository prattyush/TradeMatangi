"""update-pane-strike must not swap a side's streamed strike away from open risk.

The paper-resume repair swaps the session onto the open position's own contract; that must keep working.
"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.models.schemas import Order, OrderType, Trade, TradeSide, UpdatePaneStrikeRequest
from app.routers import simulation as route
from app.services import order_service, strategy_service, trading as trading_service
from app.services.simulation import SimulationState

SESSION = "pane-guard-test"
USER = "pane-guard-user"
EXPIRY = "2026-11-12"


def make_session(**over):
    base = dict(
        session_id=SESSION, user_id=USER, symbol="NIFTY", session_type="real",
        instrument_type="options", expiry=EXPIRY, state=SimulationState.RUNNING,
        strike_ce=24300, strike_pe=24100, last_price=24203.0, date="2026-11-09",
        start_time="09:15:00", current_time=None, broker_positions=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def clean():
    yield
    trading_service.clear_session(SESSION)
    order_service.clear_session(SESSION)
    strategy_service.clear_session(SESSION)


def add_trade(right, strike, side=TradeSide.BUY):
    trading_service._trades.setdefault(SESSION, []).append(
        Trade(user_id=USER, symbol="NIFTY", side=side, quantity=65, price=20, timestamp=100,
              session_id=SESSION, instrument_type="options", right=right, strike=strike,
              expiry=EXPIRY, session_type="real"))


def add_order(right, strike, order_id=None):
    order = Order(order_id=order_id or f"o-{right}-{strike}", session_id=SESSION, user_id=USER, symbol="NIFTY",
                  side=TradeSide.SELL, quantity=65, order_type=OrderType.LIMIT, trigger_price=30, limit_price=30,
                  created_at=1, right=right, strike=strike, expiry=EXPIRY if strike else None, reserved_amount=0)
    order_service._orders.setdefault(SESSION, {})[order.order_id] = order


async def swap(session, right, strike):
    """Call the endpoint with the heavy part (data fetch + feed switch) stubbed out."""
    with patch.object(route.sim_svc, "get_session", return_value=session), \
         patch.object(route, "_apply_session_strike", new=AsyncMock()) as apply:
        result = await route.update_pane_strike(SESSION, UpdatePaneStrikeRequest(right=right, strike=strike))
    return result, apply


async def refused(session, right, strike, status=409):
    with pytest.raises(HTTPException) as exc:
        _, apply = await swap(session, right, strike)
    assert exc.value.status_code == status
    return exc.value.detail


@pytest.mark.asyncio
@pytest.mark.parametrize("session_type", ["real", "paper", "sim"])
async def test_open_position_on_the_streamed_strike_blocks_a_different_strike(session_type):
    add_trade("PE", 24100)
    detail = await refused(make_session(session_type=session_type), "PE", 24000)
    assert "24100" in detail and "position" in detail and "24000" in detail


@pytest.mark.asyncio
async def test_the_other_side_and_a_flat_side_are_not_affected():
    add_trade("PE", 24100)
    result, apply = await swap(make_session(), "CE", 24400)
    assert result["strike"] == 24400
    apply.assert_awaited_once()
    # PE flat after the position is closed -> allowed
    add_trade("PE", 24100, TradeSide.SELL)
    result, apply = await swap(make_session(), "PE", 24000)
    apply.assert_awaited_once()


@pytest.mark.asyncio
async def test_same_strike_is_a_no_op_for_the_guard_even_with_an_open_position():
    add_trade("PE", 24100)
    result, apply = await swap(make_session(), "PE", 24100)
    apply.assert_awaited_once()


@pytest.mark.asyncio
async def test_resume_repair_onto_the_open_positions_own_contract_is_allowed():
    # The session streams 24100 but the open position is on 24000: moving the stream to 24000 repairs tracking.
    add_trade("PE", 24000)
    result, apply = await swap(make_session(strike_pe=24100), "PE", 24000)
    assert result["strike"] == 24000
    apply.assert_awaited_once()
    # ... but moving to some third strike would not be.
    await refused(make_session(strike_pe=24100), "PE", 23900)


@pytest.mark.asyncio
async def test_two_open_contracts_that_net_flat_block_every_other_strike():
    add_trade("PE", 24000, TradeSide.BUY)
    add_trade("PE", 24100, TradeSide.SELL)
    await refused(make_session(), "PE", 23900)


@pytest.mark.asyncio
async def test_open_order_blocks_unless_it_sits_on_the_target_contract():
    add_order("PE", 24100)
    assert "order" in await refused(make_session(), "PE", 24000)
    result, apply = await swap(make_session(strike_pe=24000), "PE", 24100)
    apply.assert_awaited_once()


@pytest.mark.asyncio
async def test_order_without_a_recorded_strike_counts_as_the_streamed_strike():
    add_order("PE", None, order_id="legacy")
    assert "24100" in await refused(make_session(), "PE", 24000)


@pytest.mark.asyncio
async def test_running_strategy_blocks_unless_a_position_already_sits_on_the_target():
    strategy = SimpleNamespace(right="PE", strategy_id="s1")
    with patch.object(strategy_service, "list_running", return_value=[strategy]):
        assert "strategy" in await refused(make_session(), "PE", 24000)
        add_trade("PE", 24000)   # resume repair: strategy protects the position that is being streamed next
        result, apply = await swap(make_session(strike_pe=24100), "PE", 24000)
        apply.assert_awaited_once()


@pytest.mark.asyncio
async def test_broker_only_position_blocks_the_swap():
    session = make_session(broker_positions=[
        {"right": "PE", "strike": 24100, "expiry": EXPIRY, "side": "LONG", "quantity": 65, "avg_entry_price": 20}])
    assert "24100" in await refused(session, "PE", 24000)


@pytest.mark.asyncio
async def test_a_failing_check_refuses_only_the_swap_and_leaves_the_strike_alone():
    session = make_session()
    with patch.object(route, "_strand_risk", side_effect=RuntimeError("boom")):
        detail = await refused(session, "PE", 24000, status=503)
    assert "not changed" in detail and session.strike_pe == 24100


@pytest.mark.asyncio
async def test_closing_the_position_unblocks_the_swap_so_nobody_is_stuck():
    add_trade("PE", 24100)
    await refused(make_session(), "PE", 24000)
    add_trade("PE", 24100, TradeSide.SELL)   # exit works regardless of the refusal
    result, apply = await swap(make_session(), "PE", 24000)
    apply.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_position_that_appears_while_the_data_loads_still_blocks_the_swap():
    # The endpoint check passed, then an order filled during the (awaited) data fetch.
    session = make_session(session_type="sim")

    def ensure_then_fill(*args, **kwargs):
        add_trade("PE", 24100)

    with patch.object(route, "_ensure_options_data", side_effect=ensure_then_fill):
        with pytest.raises(HTTPException) as exc:
            await route._apply_session_strike(session, "PE", 24000)
    assert exc.value.status_code == 409
    assert session.strike_pe == 24100


def test_reselect_button_still_refuses_any_open_item_on_the_side():
    add_trade("PE", 24000)
    assert "position" in route._side_open_risk(make_session(strike_pe=24100), "PE")
    assert route._side_open_risk(make_session(), "CE") is None
