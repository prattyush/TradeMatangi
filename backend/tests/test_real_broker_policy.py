"""Admin opt-in: observations remain durable while disabled and never gate Start."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import pytest
from fastapi import HTTPException
from app.services import real_broker_policy as policy, real_sessions, real_session_observer as observer
from app.services import real_session_slots as slots, simulation, execution_broker, swing_real, swing_portfolio_store
from app.models.schemas import SimulationStartRequest
from tests.test_swing_paper_runtime import db

actual_enabled=policy.enabled
actual_dispatch=execution_broker.get_service


@pytest.fixture
def observing(db,monkeypatch):
    monkeypatch.setattr(policy,'enabled',lambda:False)
    monkeypatch.setattr(policy,'_loaded',True)
    monkeypatch.setattr('app.dependencies.require_real_trading_access',lambda user:user)
    monkeypatch.setattr('app.services.real_trading_day.market_date',lambda:'2026-10-15')
    monkeypatch.setattr(execution_broker,'get_service',lambda *_a,**_k:SimpleNamespace(is_authenticated=lambda:True,account_identity=lambda:'account'))
    return db


def test_default_is_disabled_and_admin_value_persists(db,monkeypatch):
    monkeypatch.setattr(policy,'enabled',actual_enabled)
    monkeypatch.setattr(policy,'_enabled',False)
    monkeypatch.setattr(policy,'_loaded',False)
    assert policy.refresh().enabled is False and policy.enabled() is False
    policy.save(policy.Policy(enabled=True))
    assert policy.refresh().enabled is True and policy.enabled() is True
    policy.save(policy.Policy(enabled=False))
    assert policy.refresh().enabled is False


@pytest.mark.asyncio
async def test_day_start_ignores_other_book_conflict_and_server_recovery_gate(observing,monkeypatch):
    from app.services import real_day_recovery
    slots.claim('other','kite','account','intraday','other-book','other-token')
    monkeypatch.setattr(real_sessions,'_ready',False)
    monkeypatch.setattr(simulation,'find_all_sessions_by_context',lambda *_:[])
    relation=AsyncMock(side_effect=AssertionError('No relation gate while disabled'))
    monkeypatch.setattr(real_day_recovery,'adopt_legacy_context',relation)
    monkeypatch.setattr(real_day_recovery,'release_stale',relation)
    monkeypatch.setattr(slots,'claim',Mock(side_effect=AssertionError('No lock acquisition while disabled')))
    request=SimulationStartRequest(symbol='NIFTY',date='2026-10-15',session_type='real',execution_broker='kite')
    async def create():
        claim=real_sessions.prepared_claim()
        session=simulation.SimulationSession(claim['session_id'],'NIFTY',request.date,'09:15:00',1,
            user_id='u',session_type='real',execution_broker='kite',broker_account_id='account')
        simulation._sessions[session.session_id]=session
        await real_sessions.bind_prepared(session)
        return SimpleNamespace(session_id=session.session_id)
    result=await real_sessions.start(request,'u',create)
    session=simulation.get_session(result.session_id)
    try:
        assert slots.read('kite','account','intraday')['session_id']=='other-book'
        records=observer.active('u')
        assert records[0]['session_id']==result.session_id and records[0]['engine_until']>records[0]['updated_at']
        assert not session.real_engine_lease_required
        relation.assert_not_awaited()
    finally:
        session.state=simulation.SimulationState.ENDED
        session.real_engine_task.cancel()
        await asyncio.gather(session.real_engine_task,return_exceptions=True)


@pytest.mark.asyncio
async def test_disabled_heartbeat_keeps_records_without_consulting_canonical_slot(observing,monkeypatch):
    from app.services.real_day_recovery import heartbeat
    record={'session_id':'mine','user_id':'u','session_type':'real','state':'running'}
    observing.Table('Sessions').put_item(Item=record)
    monkeypatch.setattr(slots,'for_user',Mock(side_effect=AssertionError('No slot lookup')))
    assert (await heartbeat('u','mine'))['enforced'] is False
    row=observing.Table('WalletLedgers').get_item(Key=observer.key('u','mine'))['Item']
    assert row['last_client_seen_at']>0
    with pytest.raises(HTTPException): await heartbeat('other','mine')


def test_observation_write_failure_and_expired_lease_do_not_reject_trading(observing,monkeypatch):
    monkeypatch.setattr(slots,'table',lambda:SimpleNamespace(update_item=Mock(side_effect=RuntimeError('unavailable'))))
    observer.record('u','mine','kite','account','intraday','token')
    observer.presence('u','mine')
    monkeypatch.setattr('app.services.kite_execution.get_service',lambda:'broker')
    session=SimpleNamespace(execution_broker='kite',real_engine_lease_required=True,real_engine_valid_until=0,real_broker_restrictions_enabled=True)
    assert actual_dispatch(session)=='broker'


def test_two_swing_users_can_create_records_despite_stale_broker_slot(observing):
    slots.claim('old','kite','account','swing','old-portfolio','old-token')
    first=swing_portfolio_store.create('u','real',100000,broker='kite',account='account')
    second=swing_portfolio_store.create('v','real',100000,broker='kite',account='account')
    assert first['session_id']!=second['session_id']
    assert slots.read('kite','account','swing')['session_id']=='old-portfolio'
    assert observer.active('u')[0]['session_id']==first['session_id']
    assert observer.active('v')[0]['session_id']==second['session_id']


@pytest.mark.asyncio
async def test_swing_start_skips_shared_funding_relationships(observing,monkeypatch):
    from app.services import real_accounting, swing_funding_store
    monkeypatch.setattr(real_accounting,'refresh',AsyncMock(return_value={'session_capital':100000,'balance':90000}))
    forbidden=Mock(side_effect=AssertionError('No shared participant gate while disabled'))
    monkeypatch.setattr(swing_funding_store,'initialize',forbidden)
    row=await swing_real.start('u',SimpleNamespace(execution_broker='kite',allocation_pct=.5,loss_limit_pct=None))
    assert row['session_capital']==50000 and not row.get('real_funding_period')
    forbidden.assert_not_called()


@pytest.mark.asyncio
async def test_swing_resume_with_incomplete_funding_skips_claim_and_reconciliation(observing,monkeypatch):
    from app.services.swing_portfolio_service import Runtime
    row=swing_portfolio_store.create('u','real',50000,broker='kite',account='account')
    current=Runtime('u',row['session_id'])
    monkeypatch.setattr(slots,'claim',Mock(side_effect=AssertionError('No broker lock')))
    async def idle(_): await asyncio.Event().wait()
    monkeypatch.setattr(swing_real,'engine',idle)
    await swing_real.bind(current,row)
    try:
        assert current.real_ready and current.observe_only
        await asyncio.sleep(0)
    finally:
        for task in current.tasks.values(): task.cancel()
        await asyncio.gather(*current.tasks.values(),return_exceptions=True)


def test_non_admin_cannot_change_setting(monkeypatch):
    from app.routers import admin, desktop_settings
    monkeypatch.setattr(admin,'get_user_info',lambda _: {'is_admin':False})
    for guard in (admin._require_admin,desktop_settings.require_admin):
        with pytest.raises(HTTPException) as error: guard('ordinary-user')
        assert error.value.status_code==403


@pytest.mark.asyncio
async def test_enabling_restores_broker_ownership_gate(observing,monkeypatch):
    monkeypatch.setattr(policy,'enabled',lambda:True)
    monkeypatch.setattr(real_sessions,'_ready',True)
    slots.claim('other','kite','account','intraday','other-book','other-token')
    create=AsyncMock()
    req=SimulationStartRequest(symbol='NIFTY',date='2026-10-15',session_type='real',execution_broker='kite')
    with pytest.raises(HTTPException) as error: await real_sessions.start(req,'u',create)
    assert error.value.status_code==409
    create.assert_not_awaited()


def test_observational_session_capital_stays_frozen(observing,monkeypatch):
    from app.services.real_accounting import apply_session_capital
    session=simulation.SimulationSession('mine','NIFTY','2026-10-15','09:15:00',1,
        user_id='u',session_type='real',session_capital=50000)
    session.real_active_claim=True
    session.real_broker_restrictions_enabled=False
    simulation._sessions['mine']=session
    apply_session_capital(session,14000)
    assert session.session_capital==50000


def test_disabled_reconciliation_flag_does_not_block_entries_but_unknown_wire_operations_still_do(observing,monkeypatch):
    from app.services import real_trading_day, real_close
    from app.models.schemas import TradeSide
    session=simulation.SimulationSession('mine','NIFTY','2026-10-15','09:15:00',1,user_id='u',session_type='real')
    session.real_recovery_pending=True
    monkeypatch.setattr(real_trading_day,'state',lambda _: {'state':'active','date':'2026-10-15'})
    monkeypatch.setattr(real_close,'unresolved',lambda _:False)
    real_trading_day.require_entry_allowed(session,TradeSide.BUY,1)
    monkeypatch.setattr(real_close,'unresolved',lambda _:True)
    with pytest.raises(HTTPException,match='unconfirmed'):
        real_trading_day.require_entry_allowed(session,TradeSide.BUY,1)
