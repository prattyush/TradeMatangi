"""Manually-requested, broker-bound order actions must wait through a brief
refresh barrier instead of being hard-rejected -- software-governed new
entry placement keeps the instant reject. See docs/bugs.md."""
import asyncio
from unittest.mock import AsyncMock, MagicMock
import pytest
from fastapi import HTTPException
from app.models.schemas import OrderType, TradeSide, Position, PlaceOrderRequest, ConvertOrderRequest, UpdateOrderRequest
from app.services import real_broker_state, simulation, order_service, trading
from app.routers import orders
from app.services import emergency_exit as exits
from app.routers import trading as trade_routes
from tests.test_phase19_real_exit_orders import env, local, confirm_limit_modify
from tests.test_execution_gaps import real as direct_market_env
from tests.test_emergency_exit import book as emergency_exit_env, order


async def _open_then_close(session, delay=0.01):
    session.broker_refresh_events = []
    await asyncio.sleep(delay)
    events, session.broker_refresh_events = session.broker_refresh_events, None
    for callback, args in events or []:
        callback(*args)


@pytest.mark.asyncio
async def test_await_refresh_barrier_returns_true_once_closed():
    session = MagicMock()
    session.broker_refresh_events = []
    task = asyncio.create_task(_open_then_close(session))
    assert await real_broker_state.await_refresh_barrier(session, timeout=1.0, poll=0.01)
    await task


@pytest.mark.asyncio
async def test_await_refresh_barrier_times_out_while_still_open():
    session = MagicMock()
    session.broker_refresh_events = []
    assert not await real_broker_state.await_refresh_barrier(session, timeout=0.05, poll=0.01)
    assert session.broker_refresh_events == []


@pytest.mark.asyncio
async def test_new_stoploss_exit_waits_through_refresh_and_succeeds(env):
    s, broker, position = env
    o = local(s, OrderType.LIMIT)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    position.return_value = Position(symbol=s.symbol, side="LONG", quantity=10, avg_entry_price=100)
    asyncio.get_running_loop().call_later(0.01, lambda: setattr(s, "broker_refresh_events", None))
    s.broker_refresh_events = []
    order = await orders.place_order(PlaceOrderRequest(session_id=s.session_id, side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS, quantity=1, trigger_price=90, is_stoploss=True))
    assert order.kotak_order_id == "broker-sl"


@pytest.mark.asyncio
async def test_market_new_position_order_waits_through_refresh_and_succeeds(env):
    s, broker, position = env
    s.last_price = 100
    position.return_value = Position(symbol=s.symbol, side="FLAT", quantity=0, avg_entry_price=0)
    asyncio.get_running_loop().call_later(0.01, lambda: setattr(s, "broker_refresh_events", None))
    s.broker_refresh_events = []
    order = await orders.place_order(PlaceOrderRequest(session_id=s.session_id, side=TradeSide.BUY,
        order_type=OrderType.LIMIT, quantity=1, limit_price=100, market_order=True, execute_immediately=True))
    assert order.kotak_order_id == "broker-limit"


@pytest.mark.asyncio
async def test_plain_new_position_limit_order_still_hard_fails_during_refresh(env):
    s, broker, position = env
    position.return_value = Position(symbol=s.symbol, side="FLAT", quantity=0, avg_entry_price=0)
    s.broker_refresh_events = []
    with pytest.raises(HTTPException, match="refresh is in progress"):
        await orders.place_order(PlaceOrderRequest(session_id=s.session_id, side=TradeSide.BUY,
            order_type=OrderType.LIMIT, quantity=1, limit_price=100))
    s.broker_refresh_events = None


@pytest.mark.asyncio
async def test_cancelling_open_exit_waits_through_refresh_and_succeeds(env):
    s, broker, position = env
    o = local(s, OrderType.LIMIT)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    position.return_value = Position(symbol=s.symbol, side="LONG", quantity=10, avg_entry_price=100)
    asyncio.get_running_loop().call_later(0.01, lambda: setattr(s, "broker_refresh_events", None))
    s.broker_refresh_events = []
    cancelled = await orders.cancel_order(o.order_id, session_id=s.session_id)
    assert cancelled.status.value == "CANCELLED"


@pytest.mark.asyncio
async def test_cancelling_pending_new_position_order_still_hard_fails_during_refresh(env):
    s, broker, position = env
    position.return_value = Position(symbol=s.symbol, side="FLAT", quantity=0, avg_entry_price=0)
    o = local(s, OrderType.LIMIT, TradeSide.BUY)
    s.broker_refresh_events = []
    with pytest.raises(HTTPException, match="refresh is in progress"):
        await orders.cancel_order(o.order_id, session_id=s.session_id)
    s.broker_refresh_events = None


@pytest.mark.asyncio
async def test_updating_open_exit_waits_through_refresh_and_succeeds(env):
    s, broker, position = env
    o = local(s, OrderType.STOPLOSS)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    position.return_value = Position(symbol=s.symbol, side="LONG", quantity=10, avg_entry_price=100)
    asyncio.get_running_loop().call_later(0.01, lambda: setattr(s, "broker_refresh_events", None))
    s.broker_refresh_events = []
    updated = await orders.update_order(o.order_id, UpdateOrderRequest(trigger_price=92), session_id=s.session_id)
    assert updated.trigger_price == 92


@pytest.mark.asyncio
async def test_exit_conversion_waits_through_refresh_and_succeeds(env):
    s, broker, position = env
    confirm_limit_modify(broker)
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    asyncio.get_running_loop().call_later(0.01, lambda: setattr(s, "broker_refresh_events", None))
    s.broker_refresh_events = []
    converted = await orders.convert_order(o.order_id, ConvertOrderRequest(session_id=s.session_id,
        new_order_type=OrderType.LIMIT, price=95))
    assert converted.order_type == OrderType.LIMIT


def test_direct_market_buy_waits_through_refresh_and_succeeds(direct_market_env):
    session, broker, settings = direct_market_env
    async def run():
        loop = asyncio.get_running_loop()
        loop.call_later(0.01, lambda: setattr(session, "broker_refresh_events", None))
        session.broker_refresh_events = []
        await trade_routes._place_kotak_direct(session, TradeSide.SELL, 100, 1, None)
    asyncio.run(run())
    broker.place_limit_order.assert_called_once()


@pytest.mark.asyncio
async def test_exit_all_waits_through_refresh_and_succeeds(emergency_exit_env):
    session, qty, broker = emergency_exit_env
    session.session_type = "real"
    order(session)
    asyncio.get_running_loop().call_later(0.01, lambda: setattr(session, "broker_refresh_events", None))
    session.broker_refresh_events = []
    result = await exits.exit_all(session)
    assert result


@pytest.mark.asyncio
async def test_exit_all_still_hard_fails_once_barrier_times_out(emergency_exit_env, monkeypatch):
    session, qty, broker = emergency_exit_env
    session.session_type = "real"
    monkeypatch.setattr(real_broker_state, "await_refresh_barrier", AsyncMock(return_value=False))
    session.broker_refresh_events = []
    with pytest.raises(HTTPException, match="refresh is in progress"):
        await exits.exit_all(session)
