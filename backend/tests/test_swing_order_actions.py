"""Portfolio-scoped edit/cancel, including persisted multi-day Paper exits."""
import asyncio
from unittest.mock import AsyncMock, Mock
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
async def test_futures_entries_require_fresh_amendment_preview(future_book, no_subscriptions):
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


def amendment_approval(preview):
    return {**preview, 'approved_budget':preview['required_funds']}


async def future_entry(future_book, side='BUY', kind=OrderType.LIMIT):
    from app.services import swing_futures
    from tests.test_swing_futures import request
    parent, _, _ = future_book
    pid = parent['session_id']
    await swing_futures.place('u',pid,request(side).model_copy(update={'order_type':kind}))
    child = service.runtime('u',pid).contexts['NIFTY:futures:2026-10-27']
    return pid, child, order_service.get_open_orders(child.session_id)[0]


@pytest.mark.asyncio
@pytest.mark.parametrize('side', ['BUY', 'SELL'])
@pytest.mark.parametrize('kind', [OrderType.LIMIT, OrderType.TARGET])
async def test_future_entry_amend_reserves_only_delta(future_book, no_subscriptions, side, kind):
    from app.services import swing_cash
    pid, child, order = await future_entry(future_book,side,kind)
    view = service.snapshot('u',pid)['open_orders'][0]
    assert view['instrument_type']=='futures' and view['tick_size']==.05 and view['lot_size']==5
    before = swing_cash.read('u',pid)['current_balance']
    preview = await actions.act('u',pid,order.order_id,price=105,quantity=10,preview=True)
    assert order.quantity == 5 and order.limit_price == 100
    assert swing_cash.read('u',pid)['current_balance'] == before
    assert preview['additional_funds'] == round(preview['required_funds'] - order.reserved_amount,2)
    await actions.act('u',pid,order.order_id,price=105,quantity=10,approval=amendment_approval(preview))
    assert order.quantity == 10 and order.order_type == kind
    assert (order.limit_price if kind == OrderType.LIMIT else order.trigger_price) == 105
    assert order.reserved_amount == preview['required_funds']
    assert swing_cash.read('u',pid)['current_balance'] == round(1000-order.reserved_amount,2)
    assert order_service.get_order(child.session_id,order.order_id) is order
    await actions.act('u',pid,order.order_id,cancel=True)
    assert swing_cash.read('u',pid)['current_balance'] == 1000


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['draft','filled','capital','budget','fees','funds'])
async def test_futures_amend_rejects_stale_approval(future_book, no_subscriptions, change):
    from app.services import swing_cash
    pid, child, order = await future_entry(future_book)
    preview = await actions.act('u',pid,order.order_id,price=105,quantity=10,preview=True)
    approval = amendment_approval(preview)
    price = 106 if change == 'draft' else 105
    if change == 'filled': order.broker_filled_quantity = 5
    if change == 'capital': store.update('u',pid,{'guardrail_epoch':1},store.owned('u',pid)['version'])
    if change == 'budget': approval['approved_budget']=1
    if change == 'fees': approval['fee_hash']='0'*64
    if change == 'funds': swing_cash.move('u',pid,-800,'test-spend')
    before = swing_cash.read('u',pid)['current_balance']
    with pytest.raises(HTTPException):
        await actions.act('u',pid,order.order_id,price=price,quantity=10,approval=approval)
    assert order.quantity == 5 and order.limit_price == 100
    assert swing_cash.read('u',pid)['current_balance'] == before


@pytest.mark.asyncio
@pytest.mark.parametrize('kind', [OrderType.LIMIT, OrderType.TARGET])
async def test_real_future_amend_persists_confirmed_terms(future_book, no_subscriptions, monkeypatch, kind):
    from app.services import broker_order_service, real_funding
    from app.services.db import get_dynamodb_resource
    pid, child, order = await future_entry(future_book,kind=kind)
    child.session_type = 'real'
    order.broker_order_id = 'broker-1' if kind == OrderType.LIMIT else None
    broker = AsyncMock()
    monkeypatch.setattr(broker_order_service,'sync_order_edit_async',broker)
    monkeypatch.setattr(real_funding,'reserve',lambda *a,**k: None)
    preview = await actions.act('u',pid,order.order_id,price=105,preview=True)
    await actions.act('u',pid,order.order_id,price=105,approval=amendment_approval(preview))
    assert (order.limit_price if kind == OrderType.LIMIT else order.trigger_price) == 105
    assert order.broker_order_id == ('broker-1' if kind == OrderType.LIMIT else None)
    saved = get_dynamodb_resource().Table('Orders').get_item(Key={'session_id':child.session_id,'order_id':order.order_id})['Item']
    assert float(saved['limit_price' if kind == OrderType.LIMIT else 'trigger_price']) == 105
    broker.assert_awaited_once()


@pytest.mark.asyncio
async def test_real_future_fill_during_ack_is_not_overwritten(future_book, no_subscriptions, monkeypatch):
    from app.services import broker_order_service, real_funding
    pid, child, order = await future_entry(future_book)
    child.session_type = 'real'; order.broker_order_id = 'broker-1'
    async def fill(*a,**k):
        order.status = OrderStatus.FILLED; order.broker_filled_quantity = 5
    monkeypatch.setattr(broker_order_service,'sync_order_edit_async',fill)
    monkeypatch.setattr(real_funding,'reserve',lambda *a,**k: None)
    preview = await actions.act('u',pid,order.order_id,price=105,preview=True)
    with pytest.raises(HTTPException,match='Order changed'):
        await actions.act('u',pid,order.order_id,price=105,approval=amendment_approval(preview))
    assert order.status == OrderStatus.FILLED and order.broker_filled_quantity == 5 and order.limit_price == 100


@pytest.mark.asyncio
@pytest.mark.parametrize('rejected', [True, False])
async def test_real_future_refusal_and_timeout_keep_confirmed_terms(future_book, no_subscriptions, monkeypatch, rejected):
    from app.services import broker_order_service, real_funding, real_broker_state
    from app.services.kotak_service import KotakOrderRejected
    pid, child, order = await future_entry(future_book)
    child.session_type='real'; order.broker_order_id='broker-1'
    reserve = Mock()
    monkeypatch.setattr(real_funding,'reserve',reserve)
    error = KotakOrderRejected('refused') if rejected else TimeoutError('timeout')
    monkeypatch.setattr(broker_order_service,'sync_order_edit_async',AsyncMock(side_effect=error))
    preview = await actions.act('u',pid,order.order_id,price=105,quantity=10,preview=True)
    old_reserved=order.reserved_amount
    with pytest.raises(HTTPException,match='not confirmed'):
        await actions.act('u',pid,order.order_id,price=105,quantity=10,approval=amendment_approval(preview))
    assert order.limit_price==100 and order.quantity==5 and order.broker_order_id=='broker-1'
    if rejected:
        assert order.recovery_state != 'unknown'
        assert reserve.call_args.args[2]==old_reserved
    else:
        assert order.recovery_state=='unknown' and order.analytics['swing_amendment_pending']
        row={'broker_order_id':'broker-1','status':'open','order_type':'LIMIT','quantity':5,'side':'BUY','limit_price':100,'trigger_price':100,'filled_quantity':0,'filled_price':0,'product':'NRML','exchange':'NFO'}
        restored=real_broker_state.build_orders(child,[row])[order.order_id]
        assert restored.recovery_state is None and 'swing_amendment_pending' not in restored.analytics
        assert restored.limit_price==100 and restored.quantity==5


@pytest.mark.asyncio
async def test_triggered_target_amends_held_limit_without_cancelling(future_book, no_subscriptions, monkeypatch):
    from unittest.mock import Mock
    from app.services import broker_order_service, execution_broker
    pid, child, order = await future_entry(future_book,kind=OrderType.TARGET)
    child.session_type='real';order.broker_order_id='broker-1'
    monkeypatch.setattr(broker_order_service,'require_entry_allowed',lambda *a:None)
    broker=Mock();broker.modify_sl_to_limit_order.return_value=None
    monkeypatch.setattr(execution_broker,'get_service',lambda *a:broker)
    candidate=order.model_copy(deep=True,update={'trigger_price':105})
    await broker_order_service.sync_order_edit_async(child,candidate,OrderType.TARGET)
    broker.modify_sl_to_limit_order.assert_called_once_with('broker-1',candidate.limit_price,5)
    broker.cancel_order.assert_not_called()


@pytest.mark.asyncio
async def test_partial_future_amendment_reserves_only_unfilled_quantity(future_book, no_subscriptions, monkeypatch):
    from app.services import broker_order_service, real_funding, real_broker_state
    from tests.test_swing_futures import request
    from app.services import swing_futures
    parent,_,_=future_book;pid=parent['session_id']
    await swing_futures.place('u',pid,request(quantity=10,budget=400))
    child=service.runtime('u',pid).contexts['NIFTY:futures:2026-10-27']
    order=order_service.get_open_orders(child.session_id)[0]
    child.session_type='real';order.broker_order_id='broker-1';order.broker_filled_quantity=5
    monkeypatch.setattr(real_funding,'reserve',lambda *a,**k:None)
    monkeypatch.setattr(broker_order_service,'sync_order_edit_async',AsyncMock())
    preview=await actions.act('u',pid,order.order_id,price=105,quantity=15,preview=True)
    assert preview['quantity']==10
    await actions.act('u',pid,order.order_id,price=105,quantity=15,approval=amendment_approval(preview))
    assert order.broker_filled_quantity==5 and order.quantity==15
    child.real_funding_period='test'
    real_broker_state.rebuild_reservations(child,{order.order_id:order},[])
    assert order.reserved_amount==preview['required_funds']


def test_amended_future_preview_does_not_rewrite_margin_of_earlier_fills(monkeypatch):
    from types import SimpleNamespace
    from app.models.schemas import Order, Trade, TradeSide
    from app.services import futures_real, futures_risk
    session=SimpleNamespace(session_id='s',execution_broker='kite',broker_account_id='a',user_id='u',symbol='NIFTY',expiry='2026-10-27',portfolio_id='p',future_contract={'exchange':'NFO'})
    prior=Trade(trade_id='kite:a:NFO:first',session_id='s',user_id='u',symbol='NIFTY',side=TradeSide.BUY,quantity=5,price=100,timestamp=1,instrument_type='futures',analytics={'futures':{'entry_margin':100}})
    monkeypatch.setattr(trading,'get_trades',lambda sid:[prior])
    order=Order(order_id='o',session_id='s',user_id='u',symbol='NIFTY',side=TradeSide.BUY,order_type=OrderType.LIMIT,quantity=15,trigger_price=100,limit_price=100,created_at=1,broker_order_id='broker',analytics={'futures':{'margin':450,'amended_entry':True,'fee_profile':futures_risk.FeeProfile().model_dump(mode='json')}})
    rows=[{'broker_order_id':'broker','exchange':'NFO','execution_id':name,'side':'BUY','quantity':5,'price':100,'timestamp':index+1} for index,name in enumerate(['first','second','third'])]
    fills=futures_real.confirmed_trades(session,rows,{'o':order})
    assert [t.analytics['futures']['entry_margin'] for t in fills]==[100,150,150]
