"""Broker/style ownership across users and engine failures."""
import time
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi import HTTPException
from app.services import real_session_slots as slots, swing_funding_store as funding
from tests.test_swing_funding_store import db  # noqa: F401


def test_different_users_can_own_day_and_swing_but_not_the_same_slot(db):
    slots.claim('day-user', 'kite', 'account', 'intraday', 'day', 'day-token')
    slots.claim('swing-user', 'kite', 'account', 'swing', 'swing', 'swing-token')
    with pytest.raises(HTTPException):
        slots.claim('other', 'kite', 'account', 'intraday', 'another', 'another-token')
    assert len(slots.for_user('day-user')) == 1
    assert len(slots.for_user('swing-user')) == 1


def test_one_user_can_own_all_four_combinations(db):
    for broker in ('kite', 'kotak'):
        for style in slots.STYLES:
            slots.claim('u', broker, 'account', style, f'{broker}-{style}', f'token-{broker}-{style}')
    assert len(slots.for_user('u')) == 4
    assert slots.for_user('other') == []


def test_expired_engine_preserves_owner_and_only_original_book_can_recover(db):
    slots.claim('u', 'kite', 'account', 'intraday', 'day', 'old')
    slots.table().update_item(Key=slots.key('kite', 'account', 'intraday'), UpdateExpression='SET engine_until = :expired', ExpressionAttributeValues={':expired': 0})
    with pytest.raises(HTTPException):
        slots.claim('other', 'kite', 'account', 'intraday', 'other-day', 'new')
    with pytest.raises(HTTPException):
        slots.claim('u', 'kite', 'account', 'intraday', 'replacement-day', 'new')
    slots.claim('u', 'kite', 'account', 'intraday', 'day', 'new')
    with pytest.raises(Exception):
        slots.update('kite', 'account', 'intraday', 'u', 'day', 'old')
    assert slots.read('kite', 'account', 'intraday')['operation_id'] == 'new'


def test_concurrent_users_have_one_winner(db):
    def attempt(user):
        try:
            slots.claim(user, 'kite', 'account', 'swing', user, user)
            return True
        except HTTPException:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(attempt, ['a', 'b'])) == 1


def test_shared_funding_across_users_and_owner_checks(db):
    row = funding.initialize('a', 'kite', 'account', 100000)
    assert funding.initialize('b', 'kite', 'account', 1)['period_id'] == row['period_id']
    period = row['period_id']
    funding.start_participant('a', 'kite', 'account', period, 'intraday', 'day', .3)
    funding.start_participant('b', 'kite', 'account', period, 'swing', 'portfolio', .7)
    shared = funding.read('b', 'kite', 'account')
    assert shared['funding']['unallocated_balance'] == 0
    assert shared['participants']['intraday']['owner_user_id'] == 'a'
    with pytest.raises(HTTPException):
        funding.close_participant('b', 'kite', 'account', period, 'intraday', 'day')
    funding.close_participant('a', 'kite', 'account', period, 'intraday', 'day')
    assert funding.read('b', 'kite', 'account')['participants']['swing']['active']


def test_closing_is_durable_and_does_not_expire_ownership(db):
    slots.claim('u', 'kite', 'account', 'swing', 'portfolio', 'old')
    slots.update('kite', 'account', 'swing', 'u', 'portfolio', 'old', state='closing')
    slots.table().update_item(Key=slots.key('kite', 'account', 'swing'), UpdateExpression='SET engine_until = :expired', ExpressionAttributeValues={':expired': int(time.time()) - 60})
    slots.claim('u', 'kite', 'account', 'swing', 'portfolio', 'new')
    assert slots.read('kite', 'account', 'swing')['state'] == 'closing'
    from app.services.db import get_dynamodb_client
    get_dynamodb_client().transact_write_items(TransactItems=[slots.close_action('u', 'kite', 'account', 'swing', 'portfolio', 'new')])
    slots.claim('another', 'kite', 'account', 'swing', 'next', 'next')
    assert slots.for_user('u') == []


def test_conflicting_legacy_books_block_recovery_without_discarding_identity(db):
    base = {'execution_broker': 'kite', 'broker_account_id': 'account', 'trading_style': 'intraday'}
    slots.adopt('u', {**base, 'session_id': 'first'})
    with pytest.raises(HTTPException):
        slots.adopt('other', {**base, 'session_id': 'second'})
    with pytest.raises(HTTPException):
        slots.claim('u', 'kite', 'account', 'intraday', 'first', 'new')
    assert slots.read('kite', 'account', 'intraday')['session_id'] == 'first'


def test_legacy_backend_renewal_prevents_new_engine_takeover(db):
    slots.claim('u', 'kite', 'account', 'intraday', 'day', 'old')
    slots.table().update_item(Key=slots.key('kite', 'account', 'intraday'), UpdateExpression='SET engine_until = :zero', ExpressionAttributeValues={':zero': 0})
    slots.table().put_item(Item={'user_id': 'u', 'ledger_id': 'real-active', 'state': 'running', 'session_id': 'day', 'engine_until': int(time.time()) + 45})
    with pytest.raises(HTTPException, match='legacy Real engine'):
        slots.claim('u', 'kite', 'account', 'intraday', 'day', 'new')


def test_broker_product_scope_is_separate_from_generic_contract_scope():
    from types import SimpleNamespace
    from app.services.broker_reports import in_book, in_scope
    day = SimpleNamespace(symbol='HDFCBANK', instrument_type='equity', execution_broker='kite', trading_style='intraday')
    swing = SimpleNamespace(**{**vars(day), 'trading_style': 'swing'})
    assert in_scope(day, {'symbol': 'HDFCBANK', 'product': 'CNC'})
    assert not in_book(day, {'symbol': 'HDFCBANK', 'product': 'CNC'})
    assert in_book(swing, {'symbol': 'HDFCBANK', 'product': 'CNC'})
    assert not in_book(swing, {'symbol': 'HDFCBANK', 'product': 'MIS'})


def test_changed_credentials_cannot_bypass_either_broker_slot(db):
    slots.claim('u', 'kite', 'original-account', 'intraday', 'day', 'token')
    with pytest.raises(HTTPException):
        slots.claim('other', 'kite', 'different-account', 'intraday', 'another-day', 'other-token')
    with pytest.raises(HTTPException):
        slots.claim('other', 'kite', 'different-account', 'swing', 'portfolio', 'swing-token')
    assert len(slots.for_user('u')) == 1
    assert slots.for_user('other') == []


def test_unbound_legacy_account_blocks_that_broker_without_hiding_its_book(db):
    slots.adopt('u', {'session_id': 'legacy', 'execution_broker': 'kite', 'trading_style': 'intraday'})
    row = slots.for_user('u')[0]
    assert row['unbound_account'] and row['account'] is None
    assert row['state'] == 'recovery_required'
    with pytest.raises(HTTPException):
        slots.claim('u', 'kite', 'actual-account', 'intraday', 'legacy', 'new-token')
    slots.claim('u', 'kotak', 'kotak-account', 'intraday', 'kotak-day', 'kotak-token')
    assert len(slots.for_user('u')) == 2
