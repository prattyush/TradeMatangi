"""Real Day cutover, presence, expiry and verified stale release."""
import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException
from app.services import real_day_recovery as recovery, real_session_slots as slots, real_sessions, simulation
from app.services import real_broker_state, real_recovery, real_close, order_service
from tests.test_swing_paper_runtime import db


def legacy(**extra):
    return {"session_id":"legacy", "user_id":"u", "session_type":"real", "execution_broker":"KotakNeo",
            "date":"2026-10-15", "symbol":"NIFTY", "instrument_type":"options", "state":"ended",
            "session_capital":50000, **extra}


def change_slot(db, **values):
    table = db.Table('WalletLedgers')
    row = table.get_item(Key=slots.key('kotak','account','intraday'))['Item']
    table.put_item(Item={**row, **values})


def test_day_timing_and_unchanged_swing_lease(db, monkeypatch):
    monkeypatch.setattr(slots.time,'time',lambda:10000)
    assert slots.DAY_HEARTBEAT_SECONDS == 180 and slots.DAY_LOCAL_AUTHORITY_SECONDS == 890
    assert slots.claim('u','kotak','account','intraday','day','token')['engine_until'] == 10900
    assert slots.claim('u','kotak','account','swing','swing','swing-token')['engine_until'] == 10045
    slots.update('kotak','account','intraday','u','day','token')
    assert slots.read('kotak','account','intraday')['engine_until'] == 10900


def test_expired_authority_cannot_renew(db):
    slots.claim('u','kotak','account','intraday','day','token')
    change_slot(db,engine_until=0)
    with pytest.raises(ClientError): slots.update('kotak','account','intraday','u','day','token')
    assert slots.read('kotak','account','intraday')['engine_until'] == 0


def test_presence_is_separate_from_authority_and_fenced_during_handoff(db):
    slots.claim('u','kotak','account','intraday','day','token')
    before = slots.read('kotak','account','intraday')['engine_until']
    slots.client_heartbeat('kotak','account','u','day')
    assert slots.read('kotak','account','intraday')['engine_until'] == before
    with pytest.raises(ClientError): slots.client_heartbeat('kotak','account','other','day')
    change_slot(db,handoff_token='handoff')
    with pytest.raises(ClientError): slots.client_heartbeat('kotak','account','u','day')


@pytest.mark.parametrize('unbound',[False,True])
def test_main_stopped_session_binds_from_projection_without_funding(db, unbound):
    item=legacy()
    item['broker_projection_id']=real_broker_state.projection_id(SimpleNamespace(**item),'account')
    db.Table('Sessions').put_item(Item=item)
    if unbound: slots.adopt('u',item)
    result=recovery.bind_legacy(item,'u','kotak','account')
    row=slots.read('kotak','account','intraday')
    assert row['session_id']=='legacy' and row['account']=='account' and not row.get('unbound_account')
    assert result['session_capital']==50000 and result['state']=='ended'


@pytest.mark.parametrize('extra',[{}, {'broker_account_id':'different'}, {'broker_projection_id':'broker-day:wrong'}])
def test_same_broker_is_not_account_proof(db,extra):
    item=legacy(**extra)
    db.Table('Sessions').put_item(Item=item)
    with pytest.raises(HTTPException): recovery.bind_legacy(item,'u','kotak','account')
    assert slots.read('kotak','account','intraday') is None
    assert db.Table('Sessions').get_item(Key={'session_id':'legacy'})['Item']==item


@pytest.mark.asyncio
async def test_conflicting_legacy_candidates_are_not_arbitrarily_selected(db,monkeypatch):
    monkeypatch.setattr(recovery,'_legacy_candidates',lambda *_:[legacy(),legacy(session_id='other')])
    with pytest.raises(HTTPException,match='Multiple legacy'):
        await recovery.adopt_legacy_context(SimpleNamespace(date='2026-10-15'),'u','kotak','account')


@pytest.mark.asyncio
async def test_completed_execution_task_retires_authority_without_releasing_book(db,monkeypatch):
    slots.claim('u','kotak','account','intraday','day','token')
    task=asyncio.get_running_loop().create_future(); task.set_result(None)
    session=simulation.SimulationSession('day','NIFTY','2026-10-15','09:15:00',1,
        user_id='u',session_type='real',execution_broker='kotak',broker_account_id='account')
    session.task=task; session.real_claim_token='token'
    simulation._sessions['day']=session
    monkeypatch.setattr(simulation,'stop_session',lambda s,**_:setattr(s,'state',simulation.SimulationState.ENDED))
    assert not real_sessions.engine_healthy(session)
    await recovery.retire_failed_engine('u','kotak','account')
    assert session.real_engine_valid_until==0
    row=slots.read('kotak','account','intraday')
    assert row['engine_until']==0 and row['owner_user_id']=='u'


@pytest.mark.asyncio
@pytest.mark.parametrize('presence',[None,101,900])
async def test_takeover_requires_fifteen_minutes_missing_presence(db,monkeypatch,presence):
    monkeypatch.setattr(slots.time,'time',lambda:1000)
    slots.claim('u','kotak','account','intraday','day','token')
    if presence is not None: change_slot(db,last_client_seen_at=presence)
    verify=AsyncMock(); monkeypatch.setattr(real_recovery,'verify',verify)
    await recovery.release_stale('other','kotak','account')
    verify.assert_not_called()
    assert slots.read('kotak','account','intraday')['owner_user_id']=='u'


@pytest.fixture
def stale_book(db,monkeypatch):
    item=legacy(session_id='day',broker_account_id='account',trading_style='intraday')
    db.Table('Sessions').put_item(Item=item); slots.adopt('u',item)
    change_slot(db,last_client_seen_at=int(time.time())-900)
    session=simulation.SimulationSession('day','NIFTY','2026-10-15','09:15:00',1,
        user_id='u',session_type='real',execution_broker='kotak',broker_account_id='account',session_capital=50000)
    session.real_active_claim=True
    async def restore(record,user):
        row=slots.claim(user,'kotak','account','intraday','day','recovered')
        session.real_claim_token=row['operation_id']
        return session
    monkeypatch.setattr(real_sessions,'restore_for_close',restore)
    monkeypatch.setattr(recovery,'recover',AsyncMock())
    monkeypatch.setattr(order_service,'get_open_orders',lambda _:[])
    return session


@pytest.mark.asyncio
async def test_stale_flat_release_after_verification(db,stale_book,monkeypatch):
    monkeypatch.setattr(real_recovery,'verify',AsyncMock(return_value={'verified_flat':True,'closure_blocked':False}))
    async def finish(s): real_sessions.release(s)
    monkeypatch.setattr(real_close,'finish',finish)
    await recovery.release_stale('other','kotak','account')
    assert slots.read('kotak','account','intraday') is None
    assert db.Table('Sessions').get_item(Key={'session_id':'day'})['Item']['real_verified_closed']


@pytest.mark.asyncio
@pytest.mark.parametrize('result',[{'verified_flat':False,'closure_blocked':False},
    {'verified_flat':True,'closure_blocked':True},RuntimeError('broker unavailable')])
async def test_failed_verification_keeps_owner_and_recovers_management(db,stale_book,monkeypatch,result):
    verify=AsyncMock(side_effect=result) if isinstance(result,Exception) else AsyncMock(return_value=result)
    monkeypatch.setattr(real_recovery,'verify',verify)
    with pytest.raises(HTTPException): await recovery.release_stale('other','kotak','account')
    row=slots.read('kotak','account','intraday')
    assert row['owner_user_id']=='u' and not row.get('handoff_token')
    recovery.recover.assert_awaited_once_with('u','day')


@pytest.mark.asyncio
async def test_new_heartbeat_races_and_blocks_takeover(db,stale_book,monkeypatch):
    original=slots.read
    def read(*args):
        row=original(*args); slots.client_heartbeat('kotak','account','u','day'); return row
    monkeypatch.setattr(slots,'read',read)
    verify=AsyncMock(); monkeypatch.setattr(real_recovery,'verify',verify)
    with pytest.raises(HTTPException): await recovery.release_stale('other','kotak','account')
    verify.assert_not_called()


@pytest.fixture
def indexed_db(db):
    db.Table('Sessions').update(
        AttributeDefinitions=[{'AttributeName':'user_id','AttributeType':'S'}],
        GlobalSecondaryIndexUpdates=[{'Create':{'IndexName':'UserIdIndex',
            'KeySchema':[{'AttributeName':'user_id','KeyType':'HASH'}], 'Projection':{'ProjectionType':'ALL'}}}])
    return db


def test_explicit_legacy_lookup_includes_stopped_books_and_ignores_projection_rows(indexed_db):
    item=legacy()
    indexed_db.Table('Sessions').put_item(Item=item)
    indexed_db.Table('Sessions').put_item(Item={**item,'session_id':'projection','broker_projection_id':'projection'})
    found=recovery._legacy_candidates(SimpleNamespace(date='2026-10-15'),'u','kotak')
    assert [r['session_id'] for r in found]==['legacy']


def test_previous_day_legacy_is_discovered_but_new_closed_books_prevent_historical_resurrection(indexed_db):
    indexed_db.Table('Sessions').put_item(Item=legacy(date='2026-10-14'))
    req=SimpleNamespace(date='2026-10-15')
    assert recovery._legacy_candidates(req,'u','kotak')[0]['date']=='2026-10-14'
    indexed_db.Table('Sessions').put_item(Item=legacy(session_id='new',date='2026-10-15',real_verified_closed=True))
    assert recovery._legacy_candidates(req,'u','kotak')==[]


@pytest.mark.asyncio
async def test_crashed_handoff_expires_without_releasing_book(db):
    slots.claim('u','kotak','account','intraday','day','token')
    change_slot(db,handoff_token='handoff',handoff_started_at=int(time.time())-901,engine_until=0)
    await recovery.check_handoff('u','kotak','account')
    row=slots.read('kotak','account','intraday')
    assert row['session_id']=='day' and not row.get('handoff_token') and row['engine_until']==0


@pytest.mark.asyncio
async def test_live_handoff_is_not_interrupted_by_original_owner(db):
    slots.claim('u','kotak','account','intraday','day','token')
    change_slot(db,handoff_token='handoff',handoff_started_at=int(time.time()),engine_until=0)
    with pytest.raises(HTTPException): await recovery.check_handoff('u','kotak','account')
    assert slots.read('kotak','account','intraday')['handoff_token']=='handoff'


@pytest.mark.asyncio
async def test_failed_execution_recovers_immediately_without_waiting_for_heartbeat(monkeypatch):
    session=simulation.SimulationSession('day','NIFTY','2026-10-15','09:15:00',1,user_id='u',session_type='real')
    session.task=asyncio.get_running_loop().create_future()
    simulation._sessions['day']=session
    handler=AsyncMock()
    monkeypatch.setattr(real_sessions,'_recover_failed_task',handler)
    real_sessions.watch_execution(session)
    session.task.set_result(None)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    handler.assert_awaited_once_with(session)


@pytest.mark.asyncio
async def test_stale_pending_application_entry_blocks_release(db,stale_book,monkeypatch):
    monkeypatch.setattr(real_recovery,'verify',AsyncMock(return_value={'verified_flat':True,'closure_blocked':False}))
    monkeypatch.setattr(order_service,'get_open_orders',lambda _:[object()])
    finish=AsyncMock(); monkeypatch.setattr(real_close,'finish',finish)
    with pytest.raises(HTTPException): await recovery.release_stale('other','kotak','account')
    finish.assert_not_awaited()
    assert slots.read('kotak','account','intraday')['owner_user_id']=='u'


@pytest.mark.asyncio
async def test_older_dated_unknown_attempt_uses_existing_closure_classification(db,stale_book,monkeypatch):
    # verify() owns submission-date classification; don't add an all-history unknown veto.
    old=SimpleNamespace(recovery_state='unknown',broker_conversion={},split_operation=None)
    monkeypatch.setattr(real_recovery,'verify',AsyncMock(return_value={'verified_flat':True,'closure_blocked':False}))
    monkeypatch.setattr(order_service,'get_all_orders',lambda _:[old])
    async def finish(s): real_sessions.release(s)
    monkeypatch.setattr(real_close,'finish',finish)
    await recovery.release_stale('other','kotak','account')
    assert slots.read('kotak','account','intraday') is None


@pytest.mark.asyncio
async def test_another_servers_live_authority_prevents_takeover(db,stale_book,monkeypatch):
    change_slot(db,engine_until=int(time.time())+900)
    verify=AsyncMock(); monkeypatch.setattr(real_recovery,'verify',verify)
    with pytest.raises(HTTPException): await recovery.release_stale('other','kotak','account')
    verify.assert_not_awaited()
    assert slots.read('kotak','account','intraday')['owner_user_id']=='u'


@pytest.mark.asyncio
async def test_website_and_desktop_heartbeat_routes_reject_other_owners(db,monkeypatch):
    from app.routers import execution_brokers, desktop_trading
    monkeypatch.setattr('app.dependencies.require_real_trading_access',lambda user:user)
    slots.claim('u','kotak','account','intraday','day','token')
    for route in (execution_brokers.heartbeat,desktop_trading.real_day_heartbeat):
        assert (await route('day','u'))['session_id']=='day'
        with pytest.raises(HTTPException) as exc: await route('day','other')
        assert exc.value.status_code==404


@pytest.mark.asyncio
async def test_verified_closed_or_other_users_books_never_resume(db,monkeypatch):
    monkeypatch.setattr('app.dependencies.require_real_trading_access',lambda user:user)
    db.Table('Sessions').put_item(Item=legacy(real_verified_closed=True))
    with pytest.raises(HTTPException) as exc: await recovery.recover('u','legacy')
    assert exc.value.status_code==410
    with pytest.raises(HTTPException) as exc: await recovery.recover('other','legacy')
    assert exc.value.status_code==404


@pytest.mark.asyncio
async def test_shutdown_does_not_restart_cancelled_execution(monkeypatch):
    monkeypatch.setattr(real_sessions,'_shutting_down',True)
    session=simulation.SimulationSession('day','NIFTY','2026-10-15','09:15:00',1,user_id='u',session_type='real')
    session.task=asyncio.get_running_loop().create_future()
    simulation._sessions['day']=session
    handler=AsyncMock(); monkeypatch.setattr(real_sessions,'_recover_failed_task',handler)
    real_sessions.watch_execution(session)
    session.task.cancel()
    await asyncio.sleep(0); await asyncio.sleep(0)
    handler.assert_not_awaited()


@pytest.mark.asyncio
async def test_original_handoff_cannot_erase_a_new_handoff_marker(db,stale_book,monkeypatch):
    async def replaced_verification(session):
        change_slot(db,handoff_token='new-handoff',handoff_started_at=int(time.time()),engine_until=0)
        raise RuntimeError('old worker completed late')
    monkeypatch.setattr(real_recovery,'verify',replaced_verification)
    with pytest.raises(HTTPException): await recovery.release_stale('other','kotak','account')
    assert slots.read('kotak','account','intraday')['handoff_token']=='new-handoff'


@pytest.mark.asyncio
async def test_previous_day_reconnect_verifies_without_requesting_liquidation(db,monkeypatch):
    from app.services import execution_broker
    monkeypatch.setattr('app.dependencies.require_real_trading_access',lambda user:user)
    monkeypatch.setattr('app.services.real_trading_day.market_date',lambda:'2026-10-15')
    monkeypatch.setattr(execution_broker,'get_service',lambda _:SimpleNamespace(is_authenticated=lambda:True,account_identity=lambda:'account'))
    item=legacy(date='2026-10-14',broker_account_id='account')
    db.Table('Sessions').put_item(Item=item); slots.adopt('u',item)
    verify=AsyncMock(side_effect=HTTPException(409,'Previous-day exposure remains'))
    monkeypatch.setattr(real_sessions,'recover_previous_day',verify)
    close=AsyncMock(); monkeypatch.setattr(real_close,'close',close)
    with pytest.raises(HTTPException): await recovery.recover('u','legacy')
    verify.assert_awaited_once_with('u','kotak','account','2026-10-15')
    close.assert_not_awaited()
