import asyncio
from unittest.mock import MagicMock
import pytest
from fastapi import HTTPException
from app.models.schemas import OrderType, OrderStatus, TradeSide, Position, SimulationState
from app.services import emergency_exit as exits, real_trading_day as day, simulation, trading, order_service, kotak_service
from app.routers import trading as routes

@pytest.fixture
def book(monkeypatch):
    session=simulation.SimulationSession(session_id='urgent-test',symbol='RELIND',date='2026-10-07',start_time='09:15:00',speed=1,user_id='urgent-user',session_type='sim',session_capital=10000)
    session.state=SimulationState.RUNNING;session.current_time=1791347400;session.last_price=100
    qty={'side':'LONG','quantity':10}
    monkeypatch.setattr(simulation,'get_session',lambda sid:session if sid==session.session_id else None)
    monkeypatch.setattr(trading,'get_position',lambda *a,**k:Position(symbol=session.symbol,avg_entry_price=100,**qty))
    monkeypatch.setattr(trading,'get_open_option_contracts',lambda *a:[])
    monkeypatch.setattr(day,'state',lambda *a:{'date':session.date,'state':'active'})
    monkeypatch.setattr(order_service,'_write_order_to_db',MagicMock())
    monkeypatch.setattr(exits,'quote',async_quote)
    monkeypatch.setattr('app.services.protection_recovery.fresh_quote',lambda *a:100)
    broker=MagicMock();broker.place_limit_order.return_value='urgent-broker'
    monkeypatch.setattr(kotak_service,'get_service',lambda:broker)
    order_service._orders[session.session_id]={}
    yield session,qty,broker
    order_service._orders.pop(session.session_id,None)

async def async_quote(*a):return 100

def order(session,quantity=10,kind=OrderType.STOPLOSS,side=TradeSide.SELL):
    return order_service.place_order(session_id=session.session_id,user_id=session.user_id,symbol=session.symbol,side=side,order_type=kind,quantity=quantity,created_at=0,trading_date=session.date,is_stoploss=True,trigger_price=95,limit_price=95)

@pytest.mark.asyncio
@pytest.mark.parametrize('direction,side,price',[('LONG','SELL',97),('SHORT','BUY',103)])
async def test_exit_uses_aggressive_limits_and_keeps_positions_until_fill(book,direction,side,price):
    session,qty,_=book;qty['side']=direction
    result=await exits.exit_all(session)
    created=order_service.get_open_orders(session.session_id)
    assert len(created)==1 and created[0].side.value==side and created[0].limit_price==price
    assert created[0].quantity==10 and created[0].order_type==OrderType.LIMIT
    assert qty['quantity']==10 and result['status']=='orders_requested'

@pytest.mark.asyncio
async def test_existing_half_exit_is_converted_and_remainder_created(book):
    session,_,_=book;old=order(session,quantity=4)
    result=await exits.exit_all(session)
    assert not result['results'][0]['errors']
    rows=order_service.get_open_orders(session.session_id)
    assert len(rows)==2 and sum(o.quantity for o in rows)==10
    assert old.order_type==OrderType.LIMIT and old.limit_price==97

@pytest.mark.asyncio
async def test_repeated_click_reuses_orders_without_duplicate(book):
    session,_,_=book
    await exits.exit_all(session);await exits.exit_all(session)
    assert len(order_service.get_open_orders(session.session_id))==1

@pytest.mark.asyncio
async def test_uncertain_existing_conversion_keeps_protection_and_no_duplicate(book):
    session,_,_=book;old=order(session);old.broker_conversion={'state':'unknown'}
    result=await exits.exit_all(session)
    assert result['status']=='needs_attention' and len(order_service.get_open_orders(session.session_id))==1
    assert old.order_type==OrderType.STOPLOSS

@pytest.mark.asyncio
async def test_mismatch_and_missing_quote_are_errors_not_success(book,monkeypatch):
    session,_,_=book;order(session,quantity=11)
    assert (await exits.exit_all(session))['status']=='needs_attention'
    order_service._orders[session.session_id]={}
    async def missing(*a):raise ValueError('No fresh quote')
    monkeypatch.setattr(exits,'quote',missing)
    assert (await exits.exit_all(session))['status']=='needs_attention'
    assert not order_service.get_open_orders(session.session_id)

@pytest.mark.asyncio
async def test_real_exit_does_not_use_normal_market_gap_or_synthesize_fill(book):
    session,qty,broker=book;session.session_type='real'
    result=await exits.exit_all(session)
    assert not result['results'][0]['errors']
    assert broker.place_limit_order.call_args.kwargs['price']==97
    placed=order_service.get_open_orders(session.session_id)[0]
    assert placed.kotak_order_id=='urgent-broker' and placed.recovery_state=='acknowledged'
    assert qty['quantity']==10

@pytest.mark.asyncio
async def test_real_timeout_is_reserved_and_not_blindly_retried(book):
    session,_,broker=book;session.session_type='real';broker.place_limit_order.side_effect=TimeoutError('30 seconds')
    assert (await exits.exit_all(session))['status']=='needs_attention'
    assert order_service.get_open_orders(session.session_id)[0].recovery_state=='unknown'
    await exits.exit_all(session)
    assert broker.place_limit_order.call_count==1

@pytest.mark.asyncio
async def test_rejection_is_cancelled_not_unknown(book):
    session,_,broker=book;session.session_type='real';broker.place_limit_order.side_effect=kotak_service.KotakOrderRejected('Rejected')
    await exits.exit_all(session)
    assert order_service.get_all_orders(session.session_id)[0].status==OrderStatus.CANCELLED

@pytest.mark.asyncio
async def test_wrong_owner_and_inactive_session(book):
    session,_,_=book
    with pytest.raises(HTTPException) as error:await routes.exit_all_now(session.session_id,'another-user')
    assert error.value.status_code==404
    session.state=SimulationState.ENDED
    with pytest.raises(HTTPException):await exits.exit_all(session)

@pytest.mark.asyncio
async def test_option_targets_include_old_strikes_and_expiries_and_continue_on_error(book,monkeypatch):
    session,_,_=book;session.instrument_type='options';session.symbol='BSESEN'
    targets=[dict(right='CE',strike=73800,expiry='2026-10-08'),dict(right='PE',strike=73000,expiry='2026-10-15')]
    monkeypatch.setattr(trading,'get_open_option_contracts',lambda *a:targets)
    seen=[]
    async def process(s,target):
        seen.append(target)
        if target['right']=='CE':raise ValueError('Quote missing')
        return {**target,'created':['exit'],'converted':[],'pending':[],'errors':[]}
    monkeypatch.setattr(exits,'exit_contract',process)
    result=await exits.exit_all(session)
    assert len(seen)==2 and result['status']=='needs_attention'
    assert any(row['created']==['exit'] for row in result['results'])
