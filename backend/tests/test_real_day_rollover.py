"""A dated Day lock rolls forward through verified closure, never by age alone."""
import asyncio
import time
from unittest.mock import AsyncMock
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from app.services import real_sessions as sessions, real_session_slots as slots, simulation
from app.services import real_close, real_recovery, trading, order_service, execution_broker
from app.services import swing_funding_store as funding
from tests.test_swing_paper_runtime import db


@pytest.fixture
def old_book(db, monkeypatch):
    saved = {'session_id':'old-day','user_id':'u','session_type':'real','trading_style':'intraday',
             'symbol':'HDFCBANK','instrument_type':'equity','date':'2026-10-14','state':'running',
             'execution_broker':'kite','broker_account_id':'account','session_capital':50000}
    slots.claim('u','kite','account','intraday','old-day','day-token',record=saved)
    pool = funding.initialize('u','kite','account',100000)
    funding.start_participant('u','kite','account',pool['period_id'],'intraday','old-day',.5)
    funding.start_participant('u','kite','account',pool['period_id'],'swing','swing-book',.5)
    slots.claim('u','kite','account','swing','swing-book','swing-token')
    current = simulation.SimulationSession('old-day','HDFCBANK','2026-10-14','09:15:00',1,
        user_id='u',session_type='real',execution_broker='kite',broker_account_id='account',session_capital=50000)
    current.real_active_claim = True
    current.real_claim_token = 'day-token'
    current.real_funding_period = pool['period_id']
    monkeypatch.setattr(simulation,'_sessions',{'old-day':current})
    monkeypatch.setattr(simulation,'stop_session',lambda s,**kwargs:setattr(s,'state',simulation.SimulationState.ENDED))
    monkeypatch.setattr('app.services.broker_order_service.refresh_account_peers',lambda *_:None)
    monkeypatch.setattr(trading,'get_trades',lambda *_:[])
    monkeypatch.setattr(order_service,'get_all_orders',lambda *_:[])
    monkeypatch.setattr(execution_broker,'get_service',lambda *_:SimpleNamespace(
        is_authenticated=lambda:True,account_identity=lambda:'account',get_recovery_reports=lambda:{'orders':[],'positions':[]}))
    return current, pool


@pytest.mark.asyncio
async def test_previous_day_flat_book_releases_day_only_and_today_can_claim(db, old_book):
    current, pool = old_book
    before_swing = funding.read('u','kite','account')['funding']['modes']['swing']
    await sessions.recover_previous_day('u','kite','account','2026-10-15')
    assert current.real_verified_closed
    assert slots.read('kite','account','intraday') is None
    released = db.Table('WalletLedgers').get_item(Key=slots.key('kite','account','intraday'))['Item']
    assert released['trading_date'] == '2026-10-14'
    assert released['closed_at'] > 0 and released['engine_until'] == 0
    assert slots.read('kite','account','swing')['session_id'] == 'swing-book'
    assert funding.read('u','kite','account')['participants']['swing']['active']
    assert funding.read('u','kite','account')['funding']['modes']['swing'] == before_swing
    saved = db.Table('Sessions').get_item(Key={'session_id':'old-day'})['Item']
    assert saved['session_capital'] == 50000 and saved['real_verified_closed']
    assert 'Older execution history' in saved['real_history_warning']
    slots.claim('u','kite','account','intraday','today','today-token',record={
        'session_id':'today','user_id':'u','session_type':'real','execution_broker':'kite','broker_account_id':'account','date':'2026-10-15'})
    today = slots.read('kite','account','intraday')
    assert today['session_id'] == 'today' and today['trading_date'] == '2026-10-15'
    assert today['engine_until'] > today['updated_at'] >= today['opened_at']


@pytest.mark.asyncio
@pytest.mark.parametrize('result',[
    {'verified_flat':False,'closure_blocked':False},
    {'verified_flat':True,'closure_blocked':True},
])
async def test_timestamp_does_not_release_exposure_or_uncertain_submissions(db, old_book, monkeypatch, result):
    monkeypatch.setattr(real_recovery,'verify',AsyncMock(return_value=result))
    with pytest.raises(HTTPException):
        await sessions.recover_previous_day('u','kite','account','2026-10-15')
    assert slots.read('kite','account','intraday')['session_id'] == 'old-day'
    assert not old_book[0].real_verified_closed


@pytest.mark.asyncio
async def test_broker_outage_preserves_previous_day_lock(db, old_book, monkeypatch):
    monkeypatch.setattr(real_recovery,'verify',AsyncMock(side_effect=RuntimeError('offline')))
    with pytest.raises(HTTPException) as error:
        await sessions.recover_previous_day('u','kite','account','2026-10-15')
    assert 'could not be verified' in error.value.detail
    assert slots.read('kite','account','intraday')


@pytest.mark.asyncio
async def test_today_and_another_users_books_are_not_expired(db, old_book, monkeypatch):
    verify = AsyncMock()
    monkeypatch.setattr(real_recovery,'verify',verify)
    await sessions.recover_previous_day('u','kite','account','2026-10-14')
    await sessions.recover_previous_day('other','kite','account','2026-10-15')
    verify.assert_not_called()
    assert slots.read('kite','account','intraday')


@pytest.mark.asyncio
async def test_concurrent_previous_day_recovery_finishes_once(db, old_book, monkeypatch):
    original = real_close.finish
    finishes = []
    async def finish(session):
        finishes.append(session.session_id)
        await original(session)
    monkeypatch.setattr(real_close,'finish',finish)
    await asyncio.gather(*(sessions.recover_previous_day('u','kite','account','2026-10-15') for _ in range(2)))
    assert finishes == ['old-day']


@pytest.mark.asyncio
async def test_start_automatically_releases_flat_previous_day_and_claims_today(db, old_book, monkeypatch):
    from app.models.schemas import SimulationStartRequest
    monkeypatch.setattr('app.dependencies.require_real_trading_access',lambda user:user)
    monkeypatch.setattr('app.services.real_trading_day.market_date',lambda:'2026-10-15')
    monkeypatch.setattr(sessions,'_ready',True)
    req = SimulationStartRequest(symbol='HDFCBANK',date='2026-10-15',session_type='real',execution_broker='kite',allocation_pct=.5)
    async def create():
        sid = sessions.prepared_identity()
        current = simulation.SimulationSession(sid,'HDFCBANK',req.date,'09:15:00',1,
            user_id='u',session_type='real',execution_broker='kite',broker_account_id='account',session_capital=50000)
        simulation._sessions[sid] = current
        return SimpleNamespace(session_id=sid)
    result = await sessions.start(req,'u',create)
    assert result.session_id != 'old-day'
    assert slots.read('kite','account','intraday')['session_id'] == result.session_id
    assert slots.read('kite','account','intraday')['trading_date'] == '2026-10-15'
    assert slots.read('kite','account','swing')['session_id'] == 'swing-book'


@pytest.mark.asyncio
async def test_known_older_attempt_uses_existing_dated_closure_rules(db, old_book, monkeypatch):
    from datetime import datetime, UTC
    old = SimpleNamespace(order_id='older-attempt',recovery_state='unknown',broker_conversion={},split_operation=None,
                          broker_submission_at=int(datetime(2026,10,14,4,tzinfo=UTC).timestamp()*1000))
    monkeypatch.setattr(order_service,'get_all_orders',lambda *_:[old])
    monkeypatch.setattr(order_service,'get_open_orders',lambda *_:[])
    monkeypatch.setattr('app.services.real_trading_day.market_date',lambda:'2026-10-15')
    await sessions.recover_previous_day('u','kite','account','2026-10-15')
    assert slots.read('kite','account','intraday') is None
    assert 'Older execution history' in old_book[0].real_history_warning
