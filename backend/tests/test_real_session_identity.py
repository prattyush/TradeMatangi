"""Repair verifiable metadata, preserving the outstanding Real book and funding."""
import time
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from fastapi import HTTPException
from app.services import real_session_identity as repair, real_session_slots as slots, simulation
from app.services import swing_funding_store as funding
from tests.test_swing_portfolio_store import db


@pytest.fixture
def book(db, monkeypatch):
    saved = {"session_id":"book", "user_id":"u", "session_type":"real", "trading_style":"intraday",
             "execution_broker":"kotak", "date":"2026-10-14", "state":"running", "session_capital":100000,
             "opening_positions":[{"quantity":10,"avg_entry_price":100}], "real_history_warning":"retain history"}
    db.Table('Sessions').put_item(Item=saved)
    slot = {"user_id":"real-session-slots", "ledger_id":"kotak:intraday", "owner_user_id":"u", "broker":"kotak",
            "account":"original", "session_id":"book", "style":"intraday", "state":"recovery_required", "engine_until":0, "operation_id":"claim"}
    db.Table('WalletLedgers').put_item(Item=slot)
    broker = SimpleNamespace(is_authenticated=Mock(return_value=True), account_identity=Mock(return_value="original"))
    monkeypatch.setattr(repair.execution_broker, 'get_service', lambda *_: broker)
    monkeypatch.setattr(simulation, '_sessions', {})
    return saved, slot, broker


def read(db):
    return db.Table('Sessions').get_item(Key={'session_id':'book'},ConsistentRead=True)['Item']


@pytest.mark.asyncio
async def test_missing_account_is_restored_from_authenticated_owned_slot_without_resetting_book(db, book):
    saved, slot, broker = book
    result = await repair.repair('u','book')
    assert result['repaired'] is True
    row = read(db)
    assert row['broker_account_id'] == 'original'
    assert all(row[key] == value for key,value in saved.items())
    assert slots.read('kotak','original','intraday')['operation_id'] == 'claim'
    assert slots.read('kotak','original','intraday')['state'] == 'recovery_required'
    assert (await repair.repair('u','book'))['repaired'] is False


@pytest.mark.asyncio
async def test_another_users_record_is_private(db, book):
    with pytest.raises(HTTPException) as error:
        await repair.repair('other','book')
    assert error.value.status_code == 404
    book[2].account_identity.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('change', ['account','broker','active','closed','conflict','unauthenticated'])
async def test_conflicting_or_active_books_cannot_be_reassigned(db, book, change):
    saved, slot, broker = book
    if change == 'account': broker.account_identity.return_value = 'different'
    if change == 'broker': saved['execution_broker'] = 'kite'
    if change == 'active': slot['engine_until'] = int(time.time())+100
    if change == 'closed': saved['real_verified_closed'] = True
    if change == 'conflict': slot['recovery_conflict'] = True
    if change == 'unauthenticated': broker.is_authenticated.return_value = False
    db.Table('Sessions').put_item(Item=saved)
    db.Table('WalletLedgers').put_item(Item=slot)
    with pytest.raises(HTTPException) as error:
        await repair.repair('u','book')
    assert error.value.status_code in (401,409)
    assert 'broker_account_id' not in read(db)


@pytest.mark.asyncio
async def test_stale_nonempty_account_needs_independent_funding_evidence(db, book):
    saved, _, _ = book
    saved['broker_account_id'] = 'stale-metadata'
    db.Table('Sessions').put_item(Item=saved)
    with pytest.raises(HTTPException, match='409'):
        await repair.repair('u','book')
    pool = funding.initialize('u','kotak','original',100000)
    funding.start_participant('u','kotak','original',pool['period_id'],'intraday','book',1)
    saved['real_funding_period'] = pool['period_id']
    db.Table('Sessions').put_item(Item=saved)
    before = funding.read('u','kotak','original')
    assert (await repair.repair('u','book'))['repaired']
    assert read(db)['broker_account_id'] == 'original'
    assert funding.read('u','kotak','original') == before


@pytest.mark.asyncio
async def test_funding_can_identify_original_account_for_unbound_legacy_slot(db, book):
    saved, slot, _ = book
    slot['account'] = None
    slot['unbound_account'] = True
    db.Table('WalletLedgers').put_item(Item=slot)
    with pytest.raises(HTTPException):
        await repair.repair('u','book')
    pool = funding.initialize('u','kotak','original',100000)
    funding.start_participant('u','kotak','original',pool['period_id'],'intraday','book',1)
    saved['real_funding_period'] = pool['period_id']
    db.Table('Sessions').put_item(Item=saved)
    assert (await repair.repair('u','book'))['repaired']
    assert slots.read('kotak','original','intraday')['account'] == 'original'
    assert 'unbound_account' not in slots.read('kotak','original','intraday')


@pytest.mark.asyncio
async def test_slot_change_during_repair_rolls_back_session_update(db, book, monkeypatch):
    import app.services.db as database
    original_client = database.get_dynamodb_client()
    def transact(**kwargs):
        db.Table('WalletLedgers').update_item(Key={'user_id':'real-session-slots','ledger_id':'kotak:intraday'},
            UpdateExpression='SET operation_id = :new',ExpressionAttributeValues={':new':'different-claim'})
        return original_client.transact_write_items(**kwargs)
    monkeypatch.setattr(database,'get_dynamodb_client',lambda:SimpleNamespace(transact_write_items=transact))
    with pytest.raises(HTTPException) as error:
        await repair.repair('u','book')
    assert error.value.status_code == 409
    assert 'broker_account_id' not in read(db)


@pytest.mark.asyncio
async def test_missing_slot_account_can_be_restored_from_matching_saved_session(db, book):
    saved, slot, _ = book
    saved['broker_account_id'] = 'original'
    slot['account'] = None
    slot['unbound_account'] = True
    db.Table('Sessions').put_item(Item=saved)
    db.Table('WalletLedgers').put_item(Item=slot)
    assert (await repair.repair('u','book'))['repaired']
    assert slots.read('kotak','original','intraday')['account'] == 'original'
    assert 'unbound_account' not in slots.read('kotak','original','intraday')


@pytest.mark.asyncio
async def test_kite_alias_is_normalized_without_changing_session_capital(db, book):
    saved, slot, _ = book
    saved['execution_broker'] = 'Kite'
    db.Table('Sessions').put_item(Item=saved)
    db.Table('WalletLedgers').delete_item(Key={'user_id':'real-session-slots','ledger_id':'kotak:intraday'})
    slot.update(broker='kite', ledger_id='kite:intraday')
    db.Table('WalletLedgers').put_item(Item=slot)
    assert (await repair.repair('u','book'))['repaired']
    assert read(db)['execution_broker'] == 'kite'
    assert read(db)['session_capital'] == saved['session_capital']


@pytest.mark.asyncio
async def test_conflicting_old_funding_prevents_account_replacement(db, book):
    saved, _, _ = book
    current = funding.initialize('u','kotak','original',100000)
    funding.start_participant('u','kotak','original',current['period_id'],'intraday','book',1)
    old = funding.initialize('u','kotak','stale-metadata',100000)
    funding.start_participant('u','kotak','stale-metadata',old['period_id'],'intraday','book',1)
    saved.update(broker_account_id='stale-metadata', real_funding_period=current['period_id'])
    db.Table('Sessions').put_item(Item=saved)
    with pytest.raises(HTTPException) as error:
        await repair.repair('u','book')
    assert 'conflicting account funding' in error.value.detail
    assert read(db)['broker_account_id'] == 'stale-metadata'


@pytest.mark.asyncio
async def test_funding_change_during_repair_leaves_metadata_unchanged(db, book, monkeypatch):
    import app.services.db as database
    saved, _, _ = book
    pool = funding.initialize('u','kotak','original',100000)
    funding.start_participant('u','kotak','original',pool['period_id'],'intraday','book',1)
    saved.update(broker_account_id='stale-metadata',real_funding_period=pool['period_id'])
    db.Table('Sessions').put_item(Item=saved)
    original_client = database.get_dynamodb_client()
    def transact(**kwargs):
        db.Table('WalletLedgers').update_item(Key={'user_id':funding.partition('kotak','original'),'ledger_id':funding.key('kotak','original')},
            UpdateExpression='SET #v = #v + :one',ExpressionAttributeNames={'#v':'version'},ExpressionAttributeValues={':one':1})
        return original_client.transact_write_items(**kwargs)
    monkeypatch.setattr(database,'get_dynamodb_client',lambda:SimpleNamespace(transact_write_items=transact))
    with pytest.raises(HTTPException):
        await repair.repair('u','book')
    assert read(db)['broker_account_id'] == 'stale-metadata'


def test_repair_action_is_exposed_through_existing_real_sessions_api(db, book):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.dependencies import require_real_trading_access
    from app.routers.execution_brokers import router
    app = FastAPI()
    app.include_router(router)
    from app.routers import desktop_settings
    app.include_router(desktop_settings.router)
    app.dependency_overrides[desktop_settings.require_broker_access] = lambda: 'u'
    app.dependency_overrides[require_real_trading_access] = lambda: 'u'
    with TestClient(app) as client:
        result = client.post('/api/brokers/book/repair-identity')
        desktop = client.post('/api/desktop/v1/settings/broker/book/repair-identity')
        assert desktop.status_code == 200, desktop.text
        assert desktop.json()['repaired'] is False
    assert result.status_code == 200, result.text
    assert result.json()['repaired'] is True
    assert read(db)['session_capital'] == 100000
