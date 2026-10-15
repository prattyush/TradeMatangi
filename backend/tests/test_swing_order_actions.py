"""Portfolio-scoped edit/cancel, including persisted multi-day Paper exits."""
import asyncio
from unittest.mock import AsyncMock
import pytest
from fastapi import HTTPException
from app.models.schemas import OrderType, OrderStatus
from app.services import order_service, trading, simulation, swing_order_actions as actions
from app.services import swing_portfolio_service as service, swing_portfolio_store as store, swing_paper_recovery as recovery
from tests.test_swing_futures import future_book
from tests.test_swing_paper_runtime import db, tick
from tests.test_swing_paper_recovery import held, exit_order, stamp


@pytest.fixture
def no_subscriptions(monkeypatch):
    original = service.ensure
    async def ensure(user, pid):
        return await original(user, pid, subscribe=False)
    monkeypatch.setattr(service, 'ensure', ensure)


@pytest.mark.asyncio
async def test_multi_day_sell_edit_cancel_after_restart_preserves_attempts_and_long(db, no_subscriptions, monkeypatch):
    parent, child = await held()
    order = exit_order(child)
    child.current_time = str(stamp('2026-11-02T15:03:00'))
    # Simulate the engine having recovered the old valid attempt on a later quote.
    recovery.before_quote(child, tick('2026-11-04', 105), loader=lambda *_: [])
    child.date = '2026-11-04'
    simulation._upsert_session_to_db(child, strict=True)
    service._runtimes.clear()
    simulation._sessions.clear()
    current = await service.ensure('u', parent['session_id'])
    restored = next(iter(current.contexts.values()))
    recovery.before_quote(restored, tick('2026-11-04', 105), loader=lambda *_: [])
    original_attempt = order_service.get_order(restored.session_id, order.order_id).swing_attempts[0].copy()
    result = await actions.act('u', parent['session_id'], order.order_id, price=120, quantity=8)
    amended = order_service.get_order(restored.session_id, order.order_id)
    assert amended.limit_price == 120 and amended.quantity == 8
    assert amended.swing_attempts[0] == original_attempt
    assert result['open_orders'][0]['order_id'] == order.order_id
    await actions.act('u', parent['session_id'], order.order_id, cancel=True)
    assert amended.status == OrderStatus.CANCELLED
    assert trading.get_position(restored.session_id, restored.symbol).quantity == 10
    assert not service.snapshot('u', parent['session_id'])['open_orders']
    saved = db.Table('Orders').get_item(Key={'session_id':restored.session_id, 'order_id':order.order_id})['Item']
    assert saved['status'] == 'CANCELLED'


@pytest.mark.asyncio
@pytest.mark.parametrize('price,quantity', [(0,10),(-1,10),(110.013,10),(110,11),(110,0)])
async def test_invalid_edits_preserve_original_order(db, no_subscriptions, price, quantity):
    parent, child = await held()
    order = exit_order(child)
    with pytest.raises(HTTPException):
        await actions.act('u', parent['session_id'], order.order_id, price=price, quantity=quantity)
    assert order.limit_price == 110 and order.quantity == 10 and order.status == OrderStatus.PENDING


@pytest.mark.asyncio
async def test_owned_scope_and_terminal_order_and_pending_recovery(db, no_subscriptions):
    parent, child = await held()
    order = exit_order(child)
    with pytest.raises(HTTPException): await actions.act('other', parent['session_id'], order.order_id, price=120)
    with pytest.raises(HTTPException): await actions.act('u', parent['session_id'], 'missing', cancel=True)
    order.swing_reconcile_pending = True
    with pytest.raises(HTTPException): await actions.act('u', parent['session_id'], order.order_id, price=120)
    with pytest.raises(HTTPException): await actions.act('u', parent['session_id'], order.order_id, cancel=True)
    assert order.status == OrderStatus.PENDING
    order.swing_reconcile_pending = False
    order.status = OrderStatus.FILLED
    with pytest.raises(HTTPException): await actions.act('u', parent['session_id'], order.order_id, price=120)


@pytest.mark.asyncio
async def test_stoploss_trigger_and_quantity_edit(db, no_subscriptions):
    parent, child = await held()
    order = exit_order(child, OrderType.STOPLOSS)
    await actions.act('u', parent['session_id'], order.order_id, price=94, quantity=5)
    assert order.trigger_price == 94 and order.quantity == 5 and order.order_type == OrderType.STOPLOSS


@pytest.mark.asyncio
async def test_fill_waits_for_same_paper_edit_lock(db, no_subscriptions):
    parent, child = await held()
    from app.routers.orders import _session_edit_lock
    async with _session_edit_lock(child):
        task = asyncio.create_task(service.on_tick(service.runtime('u', parent['session_id']), child, tick('2026-11-02', 100)))
        await asyncio.sleep(0)
        assert not task.done()
    await task


@pytest.mark.asyncio
async def test_real_edit_rejection_retains_confirmed_order_and_cancel_uses_broker_path(db, no_subscriptions, monkeypatch):
    from app.services import broker_order_service, kotak_service
    from app.routers import orders as routes
    parent, child = await held()
    order = exit_order(child)
    child.session_type = 'real'
    order.broker_order_id = 'broker-live'
    order.swing_attempts = []
    monkeypatch.setattr(service, 'ensure', AsyncMock(return_value=service.runtime('u', parent['session_id'])))
    rejected = AsyncMock(side_effect=kotak_service.KotakError('Broker refused edit'))
    monkeypatch.setattr(broker_order_service, 'sync_order_edit_async', rejected)
    with pytest.raises(HTTPException, match='Broker refused edit'):
        await actions.act('u', parent['session_id'], order.order_id, price=120)
    assert order.limit_price == 110 and order.broker_order_id == 'broker-live'
    monkeypatch.setattr(broker_order_service, 'sync_order_edit_async', AsyncMock())
    await actions.act('u', parent['session_id'], order.order_id, price=115)
    assert order.limit_price == 115 and order.broker_order_id == 'broker-live'
    cancel = AsyncMock()
    monkeypatch.setattr(routes, '_cancel_order_locked', cancel)
    await actions.act('u', parent['session_id'], order.order_id, cancel=True)
    cancel.assert_awaited_once_with(order.order_id, child.session_id, child)


@pytest.mark.asyncio
async def test_edit_buy_limit_resizes_reservation_and_rejects_insufficient_cash(db, no_subscriptions):
    from tests.test_swing_paper_runtime import entry
    parent = store.create('u', 'paper', 100000)
    child = service.attach_context('u', parent['session_id'], 'HDFCBANK', subscribe=False)
    order = entry(child, 100)
    await actions.act('u', parent['session_id'], order.order_id, price=105, quantity=20)
    assert order.quantity == 20 and order.reserved_amount == 2100
    before = service.snapshot('u', parent['session_id'])['wallet_balance']
    with pytest.raises(HTTPException) as error:
        await actions.act('u', parent['session_id'], order.order_id, price=110, quantity=1000)
    assert error.value.status_code == 402
    assert order.limit_price == 105 and order.quantity == 20
    assert service.snapshot('u', parent['session_id'])['wallet_balance'] == before
    await actions.act('u', parent['session_id'], order.order_id, cancel=True)
    assert service.snapshot('u', parent['session_id'])['wallet_balance'] == 100000


@pytest.mark.asyncio
async def test_real_fill_racing_edit_preserves_latest_fill_and_real_cancel_rejection(db, no_subscriptions, monkeypatch):
    from app.services import broker_order_service, execution_broker
    from unittest.mock import Mock
    parent, child = await held()
    order = exit_order(child)
    child.session_type = 'real'
    order.broker_order_id = 'broker-live'
    order.swing_attempts = []
    monkeypatch.setattr(service, 'ensure', AsyncMock(return_value=service.runtime('u', parent['session_id'])))
    async def fill_during_ack(*args, **kwargs):
        order.status = OrderStatus.FILLED
        order.broker_filled_quantity = 10
    monkeypatch.setattr(broker_order_service, 'sync_order_edit_async', fill_during_ack)
    await actions.act('u', parent['session_id'], order.order_id, price=120)
    assert order.status == OrderStatus.FILLED and order.limit_price == 110
    order.status = OrderStatus.PENDING
    order.broker_filled_quantity = 0
    broker = Mock()
    broker.cancel_order.side_effect = RuntimeError('Broker cancellation rejected')
    monkeypatch.setattr(execution_broker, 'get_service', lambda *_a, **_k: broker)
    with pytest.raises(HTTPException, match='Broker cancellation rejected'):
        await actions.act('u', parent['session_id'], order.order_id, cancel=True)
    assert order.status == OrderStatus.PENDING
    child.broker_refresh_events = []
    with pytest.raises(HTTPException, match='refresh is in progress'):
        await actions.act('u', parent['session_id'], order.order_id, cancel=True)


@pytest.mark.asyncio
async def test_futures_entries_require_cancel_and_new_preview(future_book, no_subscriptions):
    from app.services import swing_futures
    from tests.test_swing_futures import request
    parent, contract, now = future_book
    await swing_futures.place('u', parent['session_id'], request())
    child = service.runtime('u', parent['session_id']).contexts['NIFTY:futures:2026-10-27']
    order = order_service.get_open_orders(child.session_id)[0]
    with pytest.raises(HTTPException, match='fresh margin preview'):
        await actions.act('u', parent['session_id'], order.order_id, price=105)
    await actions.act('u', parent['session_id'], order.order_id, cancel=True)
    assert order.status == OrderStatus.CANCELLED


@pytest.mark.asyncio
async def test_futures_exit_can_edit_price_but_respects_lots(future_book, no_subscriptions):
    from app.services import swing_futures
    from tests.test_swing_futures import request
    parent, contract, now = future_book
    current = service.runtime('u', parent['session_id'])
    await swing_futures.place('u', parent['session_id'], request())
    child = current.contexts['NIFTY:futures:2026-10-27']
    await swing_futures.on_quote(current, child, {'type':'tick','time':now,'close':100,'expiry':contract['expiry']})
    await swing_futures.place('u', parent['session_id'], request('SELL', 'exit', 110, budget=1))
    order = order_service.get_open_orders(child.session_id)[0]
    await actions.act('u', parent['session_id'], order.order_id, price=115, quantity=5)
    assert order.limit_price == 115
    with pytest.raises(HTTPException):
        await actions.act('u', parent['session_id'], order.order_id, price=116, quantity=4)
