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


# ── Real / paper sessions, swing and paused sessions ─────────────────────────

@pytest.mark.asyncio
async def test_paused_session_can_reselect_and_swing_cannot():
    result, _ = await call(make_session(state=SimulationState.PAUSED), right="CE", mode="otm", otm_offset=6)
    assert result["changed"] is True
    with pytest.raises(HTTPException) as exc:
        await call(make_session(trading_style="swing"), right="CE", mode="otm")
    assert exc.value.status_code == 409 and "Swing" in exc.value.detail


@pytest.mark.parametrize("session_type", ["paper", "real"])
def test_live_sessions_scan_strikes_at_the_wall_clock(session_type):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    ist = ZoneInfo("Asia/Kolkata")
    with patch.object(route, "datetime", SimpleNamespace(now=lambda tz: datetime(2026, 11, 5, 10, 31, 7, tzinfo=tz))):
        assert route._reselect_reference(make_session(session_type=session_type)) == (session_type, "2026-11-05", "10:31:07")
    assert ist  # IST wall clock, not the replay clock stored on the session


@pytest.mark.parametrize("session_type", ["paper", "real"])
@pytest.mark.asyncio
async def test_max_price_on_live_sessions_uses_live_history_mode(session_type):
    session = make_session(session_type=session_type)
    prepared = {"panes": [{"availability": "available", "reason": None, "pane": {"strike": "24350"}}]}
    run = AsyncMock(return_value=prepared)
    with patch("app.services.history_workers.run_history", new=run):
        result, apply = await call(session, right="CE", mode="max_price", max_price=50)
    assert run.await_args.args[1] == session_type and result["strike"] == 24350
    apply.assert_awaited_once_with(session, "CE", 24350)


def test_open_position_on_the_old_strike_blocks_even_after_the_chart_moved_on():
    # A real position is tracked per right, so a PE bought at 24100 still blocks the PE side whatever strike is shown.
    add_trade("PE", 24100)
    assert "position" in route._side_open_risk(make_session(strike_pe=23900), "PE")
    assert route._side_open_risk(make_session(strike_pe=23900), "CE") is None


# ── The guard looks at each contract on the side, not the side's net position ─

def test_two_open_contracts_that_net_to_zero_still_block_the_side():
    # Long 24000 PE + short 24100 PE nets to FLAT per right, but both contracts are open.
    add_trade("PE", 24000, TradeSide.BUY)
    add_trade("PE", 24100, TradeSide.SELL)
    assert trading_service.get_position(SESSION, "NIFTY", right="PE").side == "FLAT"
    reason = route._side_open_risk(make_session(), "PE")
    assert reason and "position" in reason and "24000" in reason
    assert route._side_open_risk(make_session(), "CE") is None


def test_a_closed_contract_beside_an_open_one_blocks_and_all_closed_does_not():
    add_trade("PE", 24000, TradeSide.BUY)
    add_trade("PE", 24000, TradeSide.SELL)   # 24000 closed
    assert route._side_open_risk(make_session(), "PE") is None
    add_trade("PE", 24100, TradeSide.BUY)    # 24100 open
    assert "24100" in route._side_open_risk(make_session(), "PE")


def test_same_strike_different_expiry_are_separate_contracts():
    add_trade("PE", 24000, TradeSide.BUY)
    trading_service._trades[SESSION].append(
        Trade(user_id=USER, symbol="NIFTY", side=TradeSide.SELL, quantity=65, price=20, timestamp=101,
              session_id=SESSION, instrument_type="options", right="PE", strike=24000,
              expiry="2026-11-12", session_type="sim"))
    assert route._side_open_risk(make_session(), "PE") is not None


def test_broker_only_positions_on_two_strikes_block_the_side():
    session = make_session(session_type="real", broker_positions=[
        {"right": "PE", "strike": 24000, "expiry": EXPIRY, "side": "LONG", "quantity": 65, "avg_entry_price": 20},
        {"right": "PE", "strike": 24100, "expiry": EXPIRY, "side": "SHORT", "quantity": 65, "avg_entry_price": 25},
    ])
    with patch.object(route.sim_svc, "get_session", return_value=session):
        assert route._side_open_risk(session, "PE") is not None
    assert route._side_open_risk(session, "CE") is None


@pytest.mark.asyncio
async def test_reselect_endpoint_refuses_when_two_contracts_net_flat():
    add_trade("PE", 24000, TradeSide.BUY)
    add_trade("PE", 24100, TradeSide.SELL)
    with pytest.raises(HTTPException) as exc:
        await call(make_session(), right="PE", mode="otm", otm_offset=6)
    assert exc.value.status_code == 409


# ── A failed live-feed switch must not leave the session on the new strike ───

def feed_session(session_type="real", **over):
    feed = SimpleNamespace(replace_right=AsyncMock())
    return make_session(session_type=session_type, desktop_origin=None, stream_manager=feed,
                        last_price_ce=42.0, last_price_pe=26.2, **over)


async def switch(session, right, strike):
    with patch.object(route, "_ensure_options_data"):
        await route._apply_session_strike(session, right, strike)


@pytest.mark.parametrize("right,strike_attr,price_attr,old_strike,old_price", [
    ("PE", "strike_pe", "last_price_pe", 24100, 26.2),
    ("CE", "strike_ce", "last_price_ce", 24300, 42.0),
])
@pytest.mark.asyncio
async def test_failed_feed_switch_on_a_real_session_rolls_the_strike_back(right, strike_attr, price_attr, old_strike, old_price):
    session = feed_session("real")
    session.stream_manager.replace_right.side_effect = RuntimeError("Live data unavailable: provider down")
    with pytest.raises(HTTPException) as exc:
        await switch(session, right, 24500)
    assert exc.value.status_code == 502
    assert getattr(session, strike_attr) == old_strike and getattr(session, price_attr) == old_price
    other = "strike_ce" if strike_attr == "strike_pe" else "strike_pe"
    assert getattr(session, other) == (24300 if other == "strike_ce" else 24100), "the other side is untouched"
    session.stream_manager.replace_right.assert_awaited_once_with(right)


@pytest.mark.asyncio
async def test_successful_feed_switch_on_a_real_session_keeps_the_new_strike():
    session = feed_session("real")
    await switch(session, "PE", 23900)
    assert session.strike_pe == 23900 and session.strike_ce == 24300
    session.stream_manager.replace_right.assert_awaited_once_with("PE")


@pytest.mark.asyncio
async def test_reselect_on_a_real_session_reports_502_and_keeps_the_old_strike():
    session = feed_session("real")
    session.stream_manager.replace_right.side_effect = RuntimeError("Live data unavailable")
    with patch.object(route.sim_svc, "get_session", return_value=session), patch.object(route, "_ensure_options_data"):
        with pytest.raises(HTTPException) as exc:
            await route.reselect_strike(SESSION, ReselectStrikeRequest(right="PE", mode="otm", otm_offset=6), USER)
    assert exc.value.status_code == 502 and "stream" in exc.value.detail
    assert session.strike_pe == 24100 and session.last_price_pe == 26.2
    # The user can simply try again once the provider is back.
    session.stream_manager.replace_right.side_effect = None
    with patch.object(route.sim_svc, "get_session", return_value=session), patch.object(route, "_ensure_options_data"):
        result = await route.reselect_strike(SESSION, ReselectStrikeRequest(right="PE", mode="otm", otm_offset=6), USER)
    assert result["changed"] is True and session.strike_pe == 23900


@pytest.mark.asyncio
async def test_the_add_pane_endpoint_rolls_back_on_a_failed_feed_switch_too():
    session = feed_session("real")
    session.stream_manager.replace_right.side_effect = RuntimeError("Live data unavailable")
    with patch.object(route.sim_svc, "get_session", return_value=session), patch.object(route, "_ensure_options_data"):
        with pytest.raises(HTTPException) as exc:
            await route.update_pane_strike(SESSION, route.UpdatePaneStrikeRequest(right="CE", strike=24500))
    assert exc.value.status_code == 502 and session.strike_ce == 24300
