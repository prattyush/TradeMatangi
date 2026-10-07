"""Pending-order splitting conserves lots, cash, contract identity and broker coverage."""
import asyncio
from unittest.mock import AsyncMock, MagicMock
import pytest
from fastapi import HTTPException
from app.models.schemas import Order, OrderType, OrderStatus, SplitOrderRequest, SimulationState, TradeSide
from app.services import order_service, order_split, simulation
from app.routers.orders import split_order

REAL_COMMIT = order_split._commit_pair


@pytest.fixture
def setup(monkeypatch):
    session = simulation.SimulationSession(session_id='split-tests', user_id='split-user', symbol='NIFTY',
        date='2026-10-07', start_time='09:15:00', speed=.01, instrument_type='options')
    session.state = SimulationState.RUNNING
    session.lot_size = 20
    simulation._sessions[session.session_id] = session
    order_service._orders[session.session_id] = {}
    order = Order(session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
        side=TradeSide.BUY, order_type=OrderType.LIMIT, quantity=60, trigger_price=101, limit_price=100,
        reserved_amount=6000, right='CE', strike=25000, expiry='2026-10-08', created_at=1778058900,
        entry_sl_price=90, group_id='entry-group', exit_allocation_id='allocation', exit_position_side='LONG',
        exit_allocation_role='close', analytics={'action_id':'one-action','lot_size':20})
    order_service._orders[session.session_id][order.order_id] = order
    writes = MagicMock()
    monkeypatch.setattr(order_split, '_commit_pair', writes)
    monkeypatch.setattr(order_service, '_write_order_to_db', MagicMock())
    yield session, order, writes
    order_service.clear_session(session.session_id)
    simulation._sessions.pop(session.session_id, None)


@pytest.mark.parametrize('kind,side',[(kind,side) for kind in OrderType for side in TradeSide])
def test_split_preserves_order_and_transfers_reservation(setup, kind, side):
    session, order, writes = setup
    order.order_type, order.side = kind, side
    order.is_stoploss = kind == OrderType.STOPLOSS
    order.reserved_amount = 0 if order.is_stoploss else 6000
    original = order.model_copy(deep=True)
    parts = asyncio.run(split_order(order.order_id, SplitOrderRequest(operation_id='first'), session.session_id, session.user_id))
    assert [o.quantity for o in parts] == [40,20]
    assert sum(o.reserved_amount for o in parts) == original.reserved_amount
    assert parts[0] is order
    for part in parts:
        for field in ('side','order_type','trigger_price','limit_price','right','strike','expiry','is_stoploss',
                      'entry_sl_price','group_id','exit_allocation_id','exit_position_side','exit_allocation_role','analytics'):
            assert getattr(part,field) == getattr(original,field)
        assert part.split_operation['state'] == 'confirmed'
    assert writes.call_count == 1
    assert asyncio.run(split_order(order.order_id, SplitOrderRequest(operation_id='first'), session.session_id, session.user_id)) == parts
    assert writes.call_count == 1  # HTTP retry cannot create a third order.


@pytest.mark.parametrize('qty,lot,expected',[(20,20,None),(1,1,None),(40,20,(20,20)),(60,20,(40,20)),(100,20,(60,40)),(3,1,(2,1))])
def test_quantities(qty,lot,expected):
    assert order_split.quantities(qty,lot) == expected


def test_non_lot_quantity_is_rejected():
    with pytest.raises(HTTPException):
        order_split.quantities(65,20)


def test_one_lot_has_no_side_effects(setup):
    session,order,writes = setup
    order.quantity = 20
    assert asyncio.run(order_split.split(session,order,'small')) == [order]
    assert writes.call_count == 0 and order.split_operation is None


def test_pending_remaining_is_split_not_already_filled_quantity(setup):
    session,order,writes = setup
    order.quantity = 100
    order.broker_filled_quantity = 40
    parts = asyncio.run(order_split.split(session,order,'partial'))
    assert [o.quantity for o in parts] == [80,20]
    assert [o.broker_filled_quantity for o in parts] == [40,0]
    assert sum(o.reserved_amount for o in parts) == 6000


def test_atomic_write_failure_leaves_original_intact(setup):
    session,order,writes = setup
    writes.side_effect = RuntimeError('database unavailable')
    with pytest.raises(HTTPException):
        asyncio.run(order_split.split(session,order,'db-fail'))
    assert order.quantity == 60 and order.reserved_amount == 6000
    assert order.split_operation is None
    assert len(order_service.get_open_orders(session.session_id)) == 1


def test_owner_and_ended_session_guards(setup):
    session,order,writes = setup
    with pytest.raises(HTTPException) as exc:
        asyncio.run(split_order(order.order_id,SplitOrderRequest(operation_id='wrong-owner'),session.session_id,'other-user'))
    assert exc.value.status_code == 404
    session.state = SimulationState.ENDED
    with pytest.raises(HTTPException) as exc:
        asyncio.run(split_order(order.order_id,SplitOrderRequest(operation_id='ended'),session.session_id,session.user_id))
    assert exc.value.status_code == 409
    assert not writes.called


def broker_setup(monkeypatch, setup):
    session,order,writes = setup
    session.session_type='real'
    order.kotak_order_id='broker-parent'
    broker=MagicMock()
    broker._generation=1
    broker.place_options_limit_order.return_value='broker-child'
    broker.place_options_sl_order.return_value='broker-child'
    monkeypatch.setattr('app.services.kotak_service.get_service',lambda:broker)
    monkeypatch.setattr('app.services.real_trading_day.require_entry_allowed',lambda *args:None)
    edit=AsyncMock()
    monkeypatch.setattr('app.services.broker_order_service.sync_order_edit_async',edit)
    monkeypatch.setattr('app.services.broker_order_service.register_callbacks',MagicMock())
    confirmed=AsyncMock()
    monkeypatch.setattr(order_split,'_confirmed',confirmed)
    return session,order,writes,broker,edit,confirmed


@pytest.mark.parametrize('kind',[OrderType.LIMIT,OrderType.STOPLOSS])
def test_real_shrink_confirm_then_submit_child(monkeypatch,setup,kind):
    session,order,writes,broker,edit,confirmed=broker_setup(monkeypatch,setup)
    order.order_type=kind
    parts=asyncio.run(order_split.split(session,order,'broker-success'))
    assert [o.quantity for o in parts]==[40,20]
    assert confirmed.await_count==2
    edit.assert_awaited_once()
    method=broker.place_options_limit_order if kind==OrderType.LIMIT else broker.place_options_sl_order
    assert method.call_args.kwargs['qty']==20
    assert method.call_args.kwargs['strike']==25000
    assert method.call_args.kwargs['expiry']=='2026-10-08'
    assert method.call_args.kwargs['tag'].startswith('split')
    assert parts[1].kotak_order_id=='broker-child'


def test_real_ack_without_confirmation_never_submits_child(monkeypatch,setup):
    session,order,writes,broker,edit,confirmed=broker_setup(monkeypatch,setup)
    confirmed.side_effect=TimeoutError('No broker confirmation')
    with pytest.raises(HTTPException):
        asyncio.run(order_split.split(session,order,'unconfirmed'))
    assert order.quantity==60
    assert order.split_operation['state']=='unknown'
    assert not broker.place_options_limit_order.called and not writes.called
    with pytest.raises(HTTPException):
        asyncio.run(order_split.split(session,order,'unconfirmed'))
    assert edit.await_count==1


def test_real_child_timeout_never_resubmits(monkeypatch,setup):
    session,order,writes,broker,edit,confirmed=broker_setup(monkeypatch,setup)
    broker.place_options_limit_order.side_effect=TimeoutError('Placement acknowledgement lost')
    with pytest.raises(HTTPException):
        asyncio.run(order_split.split(session,order,'child-timeout'))
    assert order.quantity==40
    assert len(order_service.get_open_orders(session.session_id))==2
    assert all(o.split_operation['state']=='unknown' for o in order_service.get_open_orders(session.session_id))
    with pytest.raises(HTTPException):
        asyncio.run(order_split.split(session,order,'child-timeout'))
    assert broker.place_options_limit_order.call_count==1


def test_real_fill_during_edit_transfers_only_remaining_reservation(monkeypatch,setup):
    session,order,writes,broker,edit,confirmed=broker_setup(monkeypatch,setup)
    async def filled(*args, **kwargs):
        order.broker_filled_quantity=20
        order.broker_filled_value=2000
        order.reserved_amount=4000
    edit.side_effect=filled
    parts=asyncio.run(order_split.split(session,order,'fill-race'))
    assert [o.quantity for o in parts]==[40,20]
    assert [o.reserved_amount for o in parts]==[2000,2000]
    assert parts[0].broker_filled_quantity==20


def test_real_full_fill_during_edit_does_not_add_quantity(monkeypatch,setup):
    session,order,writes,broker,edit,confirmed=broker_setup(monkeypatch,setup)
    async def filled(*args, **kwargs):
        order.broker_filled_quantity=60
        order.status=OrderStatus.FILLED
    edit.side_effect=filled
    with pytest.raises(HTTPException):
        asyncio.run(order_split.split(session,order,'full-fill-race'))
    assert not writes.called and not broker.place_options_limit_order.called


def test_local_busy_split_does_not_fill(setup):
    session,order,writes=setup
    order.split_operation={'state':'prepared','operation_id':'pending'}
    assert order_service.check_orders(session.session_id,99,order.created_at,session.date,tick_right='CE',tick_strike=25000,tick_expiry='2026-10-08')==[]
    assert order.status==OrderStatus.PENDING


def test_broker_confirmation_checks_report_quantity_price_type(monkeypatch,setup):
    session,order,writes=setup
    broker=MagicMock()
    broker.get_order_history.side_effect=[
        [dict(kotak_order_id='broker-parent',status='open',quantity=60,limit_price=100,trigger_price=0,order_type='LIMIT')],
        [dict(kotak_order_id='broker-parent',status='open',quantity=40,limit_price=100,trigger_price=0,order_type='LIMIT')],
    ]
    order.quantity=40
    assert asyncio.run(order_split._confirmed(broker,order,'broker-parent'))['quantity']==40
    assert broker.get_order_history.call_count==2


def test_confirmed_receipt_survives_serialization(setup):
    session,order,writes=setup
    parts=asyncio.run(order_split.split(session,order,'persist-receipt'))
    for part in parts:
        assert Order.model_validate(order_service._order_db_item(part)).split_operation['state']=='confirmed'


def test_paper_pair_uses_single_lease_fenced_transaction(monkeypatch,setup):
    session,order,writes=setup
    order.source='desktop_paper'
    order.wallet_ledger_id='paper:'+session.date
    from app.services import paper_wallet
    fence=MagicMock()
    monkeypatch.setattr(paper_wallet,'desktop_write_context',lambda *args:('engine-token',False))
    monkeypatch.setattr(paper_wallet,'fenced_put_many',fence)
    first,child=order.model_copy(deep=True),order.model_copy(deep=True)
    child.order_id='paper-child'
    first.quantity,child.quantity=40,20
    # Invoke the real commit implementation, retained below before fixture patches.
    REAL_COMMIT(session,order,first,child)
    assert fence.call_count==1
    assert len(fence.call_args.args[1])==2
    assert fence.call_args.kwargs['token']=='engine-token'


def test_split_cancellation_refunds_original_reservation_once(monkeypatch,setup):
    session,order,writes=setup
    credits=[]
    monkeypatch.setattr(order_service,'_credit_reservation',lambda o,amount,date,*args:credits.append(amount))
    parts=asyncio.run(order_split.split(session,order,'refund'))
    for part in parts:
        order_service.cancel_order(session.session_id,part.order_id,session.date)
        order_service.cancel_order(session.session_id,part.order_id,session.date)
    assert sorted(credits)==[2000,4000]


def test_unknown_split_refresh_confirms_pair_without_broker_submission(setup):
    session,parent,writes=setup
    parent.quantity=40
    parent.kotak_order_id='parent-broker'
    child=parent.model_copy(deep=True)
    child.quantity=20
    child.order_id='child-local'
    child.kotak_order_id='child-broker'
    job=dict(state='unknown',operation_id='recover',parent_id=parent.order_id,child_id=child.order_id,
        retained_quantity=40,child_quantity=20,original_quantity=60)
    parent.split_operation=child.split_operation=job
    order_split.reconcile_projection({parent.order_id:parent,child.order_id:child},[
        dict(kotak_order_id='parent-broker'),dict(kotak_order_id='child-broker')])
    assert parent.split_operation['state']==child.split_operation['state']=='confirmed'


def test_unknown_split_without_submitted_child_is_explicit_failure(setup):
    session,parent,writes=setup
    parent.quantity=40
    parent.kotak_order_id='parent-broker'
    parent.split_operation=dict(state='unknown',parent_id=parent.order_id,child_id='never-submitted',
        original_quantity=60,retained_quantity=40,child_quantity=20)
    order_split.reconcile_projection({parent.order_id:parent},[dict(kotak_order_id='parent-broker')])
    assert parent.split_operation['state']=='failed'
    assert 'not submitted' in parent.split_operation['message']


def test_refresh_adopts_unknown_child_by_tag_without_duplicate_local_order(monkeypatch,setup):
    from app.services import real_broker_state
    session,parent,writes=setup
    session.session_type='real'
    parent.quantity=40
    parent.kotak_order_id='parent-broker'
    child=parent.model_copy(deep=True)
    child.quantity=20
    child.order_id='child-local'
    child.kotak_order_id=None
    job=dict(state='unknown',parent_id=parent.order_id,child_id=child.order_id,original_quantity=60,
        retained_quantity=40,child_quantity=20,tag='split-unique')
    parent.split_operation=child.split_operation=job
    order_service._orders[session.session_id][child.order_id]=child
    monkeypatch.setattr('app.services.broker_reports.contract',lambda *args:dict(right='CE',strike=25000,expiry='2026-10-08'))
    row=dict(status='open',order_type='LIMIT',side='BUY',quantity=40,trigger_price=0,limit_price=100,
        product='MIS',exchange='nse_fo',filled_quantity=0,filled_price=0)
    result=real_broker_state.build_orders(session,[dict(row,kotak_order_id='parent-broker'),
        dict(row,kotak_order_id='child-broker',quantity=20,tag='split-unique')])
    assert len(result)==2
    assert result['child-local'].kotak_order_id=='child-broker'
    assert all(o.split_operation['state']=='confirmed' for o in result.values())


def test_broker_edit_cannot_bypass_unconfirmed_split(monkeypatch,setup):
    from app.services.broker_order_service import sync_order_edit_async
    from app.services.kotak_service import KotakError
    session,order,writes=setup
    session.session_type='real'
    order.kotak_order_id='broker'
    order.split_operation={'state':'unknown','operation_id':'busy'}
    monkeypatch.setattr('app.services.real_trading_day.require_entry_allowed',lambda *args:None)
    with pytest.raises(KotakError,match='split is unconfirmed'):
        asyncio.run(sync_order_edit_async(session,order.model_copy(deep=True),OrderType.LIMIT))


def test_atomic_pair_on_local_dynamodb(monkeypatch,setup):
    from app.config import USE_DYNAMODB_LOCAL
    from app.services.db import get_dynamodb_resource
    if not USE_DYNAMODB_LOCAL:
        pytest.skip('Local DynamoDB integration only')
    session,order,writes=setup
    table=get_dynamodb_resource().Table('Orders')
    table.put_item(Item=order_service._order_db_item(order))
    monkeypatch.setattr(order_split,'_commit_pair',REAL_COMMIT)
    parts=[]
    try:
        parts=asyncio.run(order_split.split(session,order,'ddb-atomic'))
        rows=[table.get_item(Key={'session_id':session.session_id,'order_id':o.order_id},ConsistentRead=True)['Item'] for o in parts]
        assert [int(r['quantity']) for r in rows]==[40,20]
        assert sum(float(r['reserved_amount']) for r in rows)==6000
        assert all(r['split_operation']['state']=='confirmed' for r in rows)
        assert all(r['analytics']['action_id']=='one-action' for r in rows)
    finally:
        for part in parts or [order]:
            table.delete_item(Key={'session_id':session.session_id,'order_id':part.order_id})


def test_atomic_conflict_does_not_create_child(monkeypatch,setup):
    from app.config import USE_DYNAMODB_LOCAL
    from app.services.db import get_dynamodb_resource
    if not USE_DYNAMODB_LOCAL:
        pytest.skip('Local DynamoDB integration only')
    session,order,writes=setup
    table=get_dynamodb_resource().Table('Orders')
    stored=order_service._order_db_item(order)
    stored['quantity']=40  # another mutation already committed
    table.put_item(Item=stored)
    monkeypatch.setattr(order_split,'_commit_pair',REAL_COMMIT)
    child_id=str(__import__('uuid').uuid5(__import__('uuid').NAMESPACE_URL,f'{session.session_id}/{order.order_id}/ddb-conflict'))
    try:
        with pytest.raises(HTTPException):
            asyncio.run(order_split.split(session,order,'ddb-conflict'))
        assert table.get_item(Key={'session_id':session.session_id,'order_id':order.order_id},ConsistentRead=True)['Item']['quantity']==40
        assert 'Item' not in table.get_item(Key={'session_id':session.session_id,'order_id':child_id},ConsistentRead=True)
        assert order.quantity==60 and order.split_operation is None
    finally:
        table.delete_item(Key={'session_id':session.session_id,'order_id':order.order_id})


def test_old_operation_retry_after_a_second_split_is_still_idempotent(setup):
    session,order,writes=setup
    order.quantity=100
    original_parts=asyncio.run(order_split.split(session,order,'first-request'))
    asyncio.run(order_split.split(session,order,'second-request'))
    before=[(o.order_id,o.quantity) for o in order_service.get_open_orders(session.session_id)]
    retried=asyncio.run(order_split.split(session,order,'first-request'))
    assert retried[1].order_id==original_parts[1].order_id
    assert [(o.order_id,o.quantity) for o in order_service.get_open_orders(session.session_id)]==before
    assert writes.call_count==2


def test_refresh_does_not_replace_models_during_inflight_split(setup):
    from app.services.real_broker_state import refresh
    session,order,writes=setup
    session.order_split_in_progress='inflight'
    broker=MagicMock()
    broker.account_identity.return_value='account'
    with pytest.raises(ValueError,match='split is in progress'):
        asyncio.run(refresh(session,broker))
    assert not broker.get_order_history.called


def test_split_is_blocked_during_broker_refresh(monkeypatch,setup):
    session,order,writes,broker,edit,confirmed=broker_setup(monkeypatch,setup)
    session.broker_refresh_events=[]
    with pytest.raises(HTTPException) as exc:
        asyncio.run(order_split.split(session,order,'refresh-race'))
    assert exc.value.status_code==409
    assert not edit.called and not writes.called
    assert order.quantity==60 and order.split_operation is None


@pytest.mark.parametrize('desktop',[False,True])
def test_web_and_desktop_http_split_contract(monkeypatch,setup,desktop):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.dependencies import get_desktop_user_id
    session,order,writes=setup
    monkeypatch.setitem(app.dependency_overrides,get_desktop_user_id,lambda:session.user_id)
    path=(f'/api/desktop/v1/trading/{session.session_id}/orders/{order.order_id}/split' if desktop else
        f'/api/orders/{order.order_id}/split?session_id={session.session_id}')
    response=TestClient(app).post(path,json={'operation_id':'http-split'},headers={'X-User-Id':session.user_id})
    assert response.status_code==200,response.text
    assert [o['quantity'] for o in response.json()]==[40,20]
    assert all(o['status']=='PENDING' for o in response.json())


def test_session_stopped_before_child_submission_does_not_place_order(monkeypatch,setup):
    session,order,writes,broker,edit,confirmed=broker_setup(monkeypatch,setup)
    writes.side_effect=lambda *args:setattr(session,'state',SimulationState.ENDED)
    with pytest.raises(HTTPException,match='stopped during split'):
        asyncio.run(order_split.split(session,order,'stopped-split'))
    assert not broker.place_options_limit_order.called
    assert order.split_operation['state']=='unknown'
