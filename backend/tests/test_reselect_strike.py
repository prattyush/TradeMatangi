"""Per-pane 'Re-select strike' endpoint: rule reuse, open-risk block, ownership."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.models.schemas import (
    Order, OrderType, ReselectStrikeRequest, SimulationState, Trade, TradeSide,
)
from app.routers import simulation as route
from app.services import order_service, strategy_service, trading as trading_service

SESSION = "reselect-test"
USER = "reselect-user"
EXPIRY = "2026-11-05"


def make_session(**over):
    base = dict(
        session_id=SESSION, user_id=USER, symbol="NIFTY", session_type="sim",
        instrument_type="options", expiry=EXPIRY, state=SimulationState.RUNNING,
        strike_ce=24300, strike_pe=24100, last_price=24203.0, date="2026-11-03",
        start_time="09:15:00", current_time=None,
    )
    base.update(over)
    return SimpleNamespace(**base)


@pytest.fixture(autouse=True)
def clean():
    yield
    trading_service.clear_session(SESSION)
    order_service.clear_session(SESSION)
    strategy_service.clear_session(SESSION)


async def call(session, **body):
    with patch.object(route.sim_svc, "get_session", return_value=session), \
         patch.object(route, "_apply_session_strike", new=AsyncMock()) as apply:
        result = await route.reselect_strike(SESSION, ReselectStrikeRequest(**body), USER)
    return result, apply


@pytest.mark.asyncio
async def test_otm_ce_goes_up_pe_goes_down_from_current_price():
    session = make_session()
    ce, apply_ce = await call(session, right="CE", mode="otm", otm_offset=6)
    pe, apply_pe = await call(session, right="PE", mode="otm", otm_offset=6)
    # ATM(24203) = 24200 ; interval 50
    assert ce["strike"] == 24500 and ce["changed"] is True
    assert pe["strike"] == 23900 and pe["changed"] is True
    apply_ce.assert_awaited_once_with(session, "CE", 24500)
    apply_pe.assert_awaited_once_with(session, "PE", 23900)


@pytest.mark.asyncio
async def test_unchanged_strike_is_not_applied():
    session = make_session(strike_ce=24500)
    result, apply = await call(session, right="CE", mode="otm", otm_offset=6)
    assert result["changed"] is False and result["strike"] == 24500
    apply.assert_not_awaited()


@pytest.mark.asyncio
async def test_max_price_uses_prepare_result_and_session_clock():
    session = make_session(current_time=str(10 * 3600 + 30 * 60))  # 10:30:00 IST-as-UTC
    prepared = {"panes": [{"availability": "available", "reason": None,
                           "pane": {"strike": "24350"}}]}
    run = AsyncMock(return_value=prepared)
    with patch("app.services.history_workers.run_history", new=run):
        result, apply = await call(session, right="CE", mode="max_price", max_price=50)
    assert result["strike"] == 24350 and result["changed"] is True
    args = run.await_args.args
    assert args[1:4] == ("replay", "2026-11-03", "10:30:00")
    assert args[4][0]["max_price"] == 50 and args[4][0]["right"] == "CE"
    apply.assert_awaited_once_with(session, "CE", 24350)


@pytest.mark.asyncio
async def test_max_price_failure_is_422():
    prepared = {"panes": [{"availability": "error", "reason": "No observed premium at or below the cap within 30 strikes",
                           "pane": {}}]}
    with patch("app.services.history_workers.run_history", new=AsyncMock(return_value=prepared)):
        with pytest.raises(HTTPException) as exc:
            await call(make_session(), right="PE", mode="max_price", max_price=5)
    assert exc.value.status_code == 422


@pytest.mark.asyncio
async def test_max_price_rejected_for_stocks_and_missing_cap():
    with pytest.raises(HTTPException) as exc:
        await call(make_session(symbol="RELIND"), right="CE", mode="max_price", max_price=20)
    assert exc.value.status_code == 422
    with pytest.raises(HTTPException) as exc:
        await call(make_session(), right="CE", mode="max_price")
    assert exc.value.status_code == 422


def add_trade(right, strike, side=TradeSide.BUY):
    trading_service._trades.setdefault(SESSION, []).append(
        Trade(user_id=USER, symbol="NIFTY", side=side, quantity=65, price=20, timestamp=100,
              session_id=SESSION, instrument_type="options", right=right, strike=strike,
              expiry=EXPIRY, session_type="sim"))


@pytest.mark.asyncio
async def test_open_position_blocks_only_that_side():
    add_trade("CE", 24300)
    with pytest.raises(HTTPException) as exc:
        await call(make_session(), right="CE", mode="otm", otm_offset=6)
    assert exc.value.status_code == 409 and "position" in exc.value.detail
    result, _ = await call(make_session(), right="PE", mode="otm", otm_offset=6)
    assert result["changed"] is True


@pytest.mark.asyncio
async def test_open_order_blocks_that_side():
    order = Order(order_id="o1", session_id=SESSION, user_id=USER, symbol="NIFTY", side=TradeSide.SELL,
                  quantity=65, order_type=OrderType.LIMIT, trigger_price=30, limit_price=30, created_at=1,
                  right="PE", strike=24100, expiry=EXPIRY, reserved_amount=0)
    order_service._orders[SESSION] = {order.order_id: order}
    with pytest.raises(HTTPException) as exc:
        await call(make_session(), right="PE", mode="otm", otm_offset=6)
    assert exc.value.status_code == 409 and "order" in exc.value.detail
    result, _ = await call(make_session(), right="CE", mode="otm", otm_offset=6)
    assert result["changed"] is True


@pytest.mark.asyncio
async def test_running_strategy_blocks_that_side():
    strategy_service._registry[SESSION] = [SimpleNamespace(
        right="CE", status=strategy_service.StrategyStatus.RUNNING, metadata={})]
    with pytest.raises(HTTPException) as exc:
        await call(make_session(), right="CE", mode="otm", otm_offset=6)
    assert exc.value.status_code == 409 and "strategy" in exc.value.detail


@pytest.mark.asyncio
async def test_wrong_user_not_options_ended_and_no_price():
    with pytest.raises(HTTPException) as exc:
        await call(make_session(user_id="someone-else"), right="CE", mode="otm")
    assert exc.value.status_code == 403
    with pytest.raises(HTTPException) as exc:
        await call(make_session(instrument_type="equity"), right="CE", mode="otm")
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException) as exc:
        await call(make_session(state=SimulationState.ENDED), right="CE", mode="otm")
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException) as exc:
        await call(make_session(last_price=0.0), right="CE", mode="otm")
    assert exc.value.status_code == 409
