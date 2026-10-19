"""Unrestricted lifecycle preserves one book without flatness proof."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import pytest
from app.models.schemas import Order, Trade, TradeSide, OrderType, SimulationControlRequest, SimulationStartRequest
from app.services import simulation, order_service, trading, real_close, real_sessions, execution_broker
from app.services import real_session_observer as observer
from app.services import swing_portfolio_store as store, swing_portfolio_service as service, swing_real
from tests.test_real_broker_policy import observing
from tests.test_swing_paper_runtime import db


def session(**kwargs):
    s = simulation.SimulationSession('book', 'RELIANCE', '2026-10-15', '09:15:00', 1,
        user_id='u', session_type='real', execution_broker='kite', broker_account_id='account',
        session_capital=50000, real_broker_restrictions_enabled=False)
    for key, value in kwargs.items(): setattr(s, key, value)
    return s


def broker_stub(monkeypatch):
    broker = Mock()
    broker.is_authenticated.return_value = True
    broker.account_identity.return_value = 'account'
    monkeypatch.setattr(execution_broker, 'get_service', lambda *_a, **_k: broker)
    return broker


def add_book(s):
    simulation._sessions[s.session_id] = s
    trading._trades[s.session_id] = [Trade(session_id=s.session_id, user_id='u', symbol='RELIANCE',
        side=TradeSide.BUY, quantity=2, price=100, timestamp=1000, session_type='real')]
    order = Order(session_id=s.session_id, user_id='u', symbol='RELIANCE', side=TradeSide.SELL,
        quantity=2, trigger_price=90, limit_price=89, created_at=1000, order_type=OrderType.STOPLOSS)
    order_service._orders[s.session_id] = {order.order_id: order}
    trading._write_trade_to_db(trading._trades[s.session_id][0])
    order_service._write_order_to_db(order, strict=True)
    return order


@pytest.mark.asyncio
@pytest.mark.parametrize('populated', [False, True])
async def test_stop_bypasses_conditional_lock_failure_and_preserves_state(observing, monkeypatch, populated):
    from app.routers import simulation as routes
    from app.services import real_recovery, real_broker_state, emergency_exit
    broker = broker_stub(monkeypatch)
    monkeypatch.setattr('app.routers.execution_brokers.require_real_trading_access', lambda _: None)
    s = session(real_active_claim=True, real_claim_token='observation')
    simulation._sessions['book'] = s
    if populated: order = add_book(s)
    simulation._upsert_session_to_db(s, strict=True)
    forbidden = Mock(side_effect=AssertionError('No lock or broker verification on Stop'))
    for owner, name in [(real_sessions,'_finish'),(real_recovery,'verify'),(real_broker_state,'refresh'),(emergency_exit,'exit_all')]:
        monkeypatch.setattr(owner, name, forbidden)
    result = await routes.stop_simulation(SimulationControlRequest(session_id='book'), 'u')
    assert result['status'] == 'stopped' and simulation.get_session('book') is None
    saved = observing.Table('Sessions').get_item(Key={'session_id':'book'})['Item']
    assert saved['state'] == 'ended' and not saved['real_verified_closed'] and saved['session_capital'] == 50000
    assert not observer.active('u')
    broker.place_order.assert_not_called()
    broker.cancel_order.assert_not_called()
    if populated:
        assert trading.get_position('book', s.symbol).quantity == 2
        assert order_service.get_open_orders('book')[0].order_id == order.order_id
    assert (await routes.stop_simulation(SimulationControlRequest(session_id='book'), 'u'))['status'] == 'stopped'


@pytest.mark.asyncio
@pytest.mark.parametrize('verified', [False, True])
async def test_restart_reuses_identity_capital_and_clears_old_flags(observing, monkeypatch, verified):
    broker_stub(monkeypatch)
    s = session(real_closing=True, real_recovery_pending=True, real_verified_closed=verified)
    add_book(s)
    simulation._upsert_session_to_db(s, strict=True)
    simulation._sessions.clear()
    monkeypatch.setattr(simulation, 'find_all_sessions_by_context', lambda *_: [observing.Table('Sessions').get_item(Key={'session_id':'book'})['Item']])
    async def create():
        restored = simulation.rebuild_session_from_db(real_sessions.recovery_record(), 'u', read_only=True)
        simulation._sessions['book'] = restored
        await real_sessions.bind_prepared(restored)
        return SimpleNamespace(session_id='book')
    result = await real_sessions.start(SimulationStartRequest(symbol='RELIANCE', date=s.date, session_type='real', execution_broker='kite'), 'u', create)
    restored = simulation.get_session(result.session_id)
    try:
        assert result.session_id == 'book' and restored.session_capital == 50000
        assert trading.get_position('book', 'RELIANCE').quantity == 2
        assert len(order_service.get_open_orders('book')) == 1
        assert not restored.real_closing and not restored.real_verified_closed and not restored.real_recovery_pending
    finally:
        await real_close.stop(restored)


@pytest.mark.asyncio
async def test_history_refresh_returns_full_snapshot_without_verification(observing, monkeypatch):
    from app.routers.execution_brokers import refresh_history
    from app.services import real_recovery, real_broker_state
    broker = broker_stub(monkeypatch)
    s = session()
    simulation._sessions['book'] = s
    snapshot = {'trades':[], 'orders':[], 'open_orders':[], 'application_orders':[], 'positions':[], 'session_capital':50000}
    refresh = AsyncMock(return_value=snapshot)
    monkeypatch.setattr(real_broker_state, 'refresh', refresh)
    monkeypatch.setattr(real_recovery, 'verify', Mock(side_effect=AssertionError('Refresh is not verification')))
    assert await refresh_history('book', 'u') == snapshot
    refresh.assert_awaited_once_with(s, broker)
    from fastapi import HTTPException
    with pytest.raises(HTTPException): await refresh_history('book', 'other')


@pytest.mark.asyncio
async def test_swing_stop_load_resume_preserve_book_and_capital(observing, monkeypatch):
    from app.services import real_accounting
    broker_stub(monkeypatch)
    row = store.create('u', 'real', 50000, broker='kite', account='account')
    sid = row['session_id']
    current = service.runtime('u', sid)
    s = session(trading_style='swing', portfolio_id=sid)
    order = add_book(s)
    current.contexts['RELIANCE:equity'] = s
    store.update('u', sid, {'contexts':{'RELIANCE:equity':'book'}}, row['version'])
    current.real_ready = True
    wallet = AsyncMock(side_effect=AssertionError('Resume must not recalculate capital'))
    monkeypatch.setattr(real_accounting, 'refresh', wallet)
    monkeypatch.setattr(swing_real, 'verify_close', AsyncMock(side_effect=AssertionError('No verification')))
    monkeypatch.setattr(swing_real, 'close_positions', AsyncMock(side_effect=AssertionError('No exits')))
    assert (await service.close_portfolio('u', sid))['state'] == 'stopped'
    assert (await service.close_portfolio('u', sid))['state'] == 'stopped'
    service._runtimes.clear()
    stopped = await service.ensure('u', sid)
    snap = service.snapshot('u', sid)
    assert not stopped.tasks and snap['portfolio']['state'] == 'stopped'
    assert snap['positions'][0]['quantity'] == 2 and snap['open_orders'][0]['order_id'] == order.order_id
    assert snap['restrictions_enabled'] is False
    import asyncio
    subscriber = asyncio.Queue()
    stopped.subscribers.append(subscriber)
    resumed = await swing_real.start('u', SimpleNamespace(execution_broker='kite', allocation_pct=1, loss_limit_pct=None))
    assert resumed['session_id'] == sid and resumed['session_capital'] == 50000 and resumed['state'] == 'running'
    assert resumed['contexts'] == {'RELIANCE:equity':'book'}
    assert service.runtime('u', sid) is stopped and stopped.subscribers == [subscriber]
    wallet.assert_not_awaited()
    assert (await swing_real.start('u', SimpleNamespace(execution_broker='kite')))['session_id'] == sid


@pytest.mark.asyncio
async def test_done_for_day_locks_without_closure(observing, monkeypatch):
    from app.services import real_trading_day as day, emergency_exit
    broker_stub(monkeypatch)
    s = session()
    add_book(s)
    monkeypatch.setattr(emergency_exit, 'exit_all', AsyncMock(side_effect=AssertionError('No exits')))
    day._terminal.discard(('u', s.date))
    try:
        result = await day.done_for_day('u')
        assert result['state'] == 'done' and result['results'][0]['results'] == []
        assert day.state('u')['state'] == 'done' and order_service.get_open_orders('book')
        day.monitor('u')
        assert 'u' not in day._jobs
    finally:
        day._terminal.discard(('u', s.date))


def test_swing_old_recovery_flags_do_not_gate_unrestricted_entries(observing, monkeypatch):
    from fastapi import HTTPException
    row = store.create('u', 'real', 50000, broker='kite', account='account')
    s = session(trading_style='swing', portfolio_id=row['session_id'], real_recovery_pending=True)
    current = service.runtime('u', row['session_id'])
    current.real_ready = True
    current.contexts['RELIANCE:equity'] = s
    monkeypatch.setattr(real_close, 'unresolved', lambda _:False)
    service.require_entry_allowed(s, TradeSide.BUY, 1)
    monkeypatch.setattr(real_close, 'unresolved', lambda _:True)
    with pytest.raises(HTTPException, match='unconfirmed'):
        service.require_entry_allowed(s, TradeSide.BUY, 1)
