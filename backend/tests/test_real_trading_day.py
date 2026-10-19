from unittest.mock import MagicMock
import pytest
from fastapi import HTTPException
from app.models.schemas import Position, TradeSide
from app.services import real_trading_day as day, simulation, trading, order_service
from app.routers import trading as routes

@pytest.fixture
def user(monkeypatch):
    monkeypatch.setattr("app.services.real_broker_policy.enabled", lambda: True)
    monkeypatch.setattr("app.services.real_broker_policy._loaded", True)
    session=simulation.SimulationSession(session_id='day-test',symbol='RELIND',date='2026-10-07',start_time='09:15:00',speed=1,user_id='day-user',session_type='real',session_capital=10000)
    monkeypatch.setattr(day,'has_outstanding_day_slot',lambda *_:False)
    monkeypatch.setattr(day,'market_date',lambda:'2026-10-07')
    monkeypatch.setattr(day,'state',lambda *a:{'date':'2026-10-07','state':'closing'})
    monkeypatch.setattr(trading,'get_position',lambda *a,**k:Position(symbol='RELIND',side='LONG',quantity=10,avg_entry_price=100))
    return session

@pytest.mark.parametrize('state',['closing','done'])
def test_day_barrier_rejects_entries_and_reversals_but_allows_exits(user,monkeypatch,state):
    monkeypatch.setattr(day,'state',lambda *a:{'date':'2026-10-07','state':state})
    with pytest.raises(HTTPException) as error:day.require_entry_allowed(user,TradeSide.BUY,1)
    assert error.value.status_code==403
    with pytest.raises(HTTPException):day.require_entry_allowed(user,TradeSide.SELL,11)
    if state == 'closing':
        day.require_entry_allowed(user,TradeSide.SELL,10)
    else:
        with pytest.raises(HTTPException):day.require_entry_allowed(user,TradeSide.SELL,10)

@pytest.mark.parametrize('mode',['paper','sim','stepwise'])
def test_other_modes_are_not_banned(user,mode):
    user.session_type=mode
    day.require_entry_allowed(user,TradeSide.BUY,100)

def test_lock_read_failure_fails_closed(user,monkeypatch):
    monkeypatch.setattr(day,'state',MagicMock(side_effect=RuntimeError('database down')))
    with pytest.raises(HTTPException) as error:day.require_entry_allowed(user,TradeSide.BUY,1)
    assert error.value.status_code==503

@pytest.mark.asyncio
async def test_done_for_day_is_real_only_and_owned(user,monkeypatch):
    monkeypatch.setattr(simulation,'get_session',lambda *a:user)
    with pytest.raises(HTTPException) as error:await routes.done_for_day(user.session_id,'other')
    assert error.value.status_code==404
    user.session_type='paper'
    with pytest.raises(HTTPException) as error:await routes.done_for_day(user.session_id,user.user_id)
    assert error.value.status_code==400

@pytest.mark.asyncio
async def test_completion_waits_for_flat_and_broker_verification(user,monkeypatch):
    from app.services import emergency_exit, real_broker_state, kotak_service
    monkeypatch.setattr(day,'sessions_for',lambda *a:[user])
    monkeypatch.setattr(emergency_exit,'position',lambda *a:Position(symbol='RELIND',side='FLAT',quantity=0,avg_entry_price=0))
    monkeypatch.setattr(order_service,'get_open_orders',lambda *a:[])
    monkeypatch.setattr(kotak_service,'get_service',lambda:object())
    calls=[]
    monkeypatch.setattr(simulation, 'stop_session', lambda *a, **k: calls.append('stopped'))
    async def refresh(*a):calls.append('verified')
    monkeypatch.setattr(real_broker_state,'refresh',refresh)
    monkeypatch.setattr(day,'finish',lambda *a:calls.append('done'))
    monkeypatch.setattr(day,'broadcast',lambda *a:None)
    await day.complete_when_flat(user.user_id)
    assert calls==['verified','stopped','done']

def test_persisted_day_lock_survives_cache_clear_and_rollover(monkeypatch):
    rows={};date=['2026-10-07'];table=MagicMock()
    def read(**kwargs):return {'Item':rows.get(kwargs['Key']['ledger_id'],{})}
    def update(**kwargs):
        key=kwargs['Key']['ledger_id'];values=kwargs['ExpressionAttributeValues']
        row=rows.setdefault(key,{'real_trading_state':values.get(':closing','closing')})
        if ':done' in values:row['real_trading_state']='done'
        return {'Attributes':row}
    table.get_item.side_effect=read;table.update_item.side_effect=update
    monkeypatch.setattr(day,'table',lambda:table);monkeypatch.setattr(day,'market_date',lambda:date[0]);day._terminal.clear()
    assert day.state('u')['state']=='active'
    assert day.begin('u')['state']=='closing';day.finish('u',date[0]);day._terminal.clear()
    assert day.state('u')['state']=='done';assert day.begin('u')['state']=='done'
    date[0]='2026-10-08';assert day.state('u')['state']=='active';day._terminal.clear()

@pytest.mark.asyncio
async def test_nonflat_or_failed_verification_never_marks_done(user,monkeypatch):
    import asyncio
    from app.services import emergency_exit, real_broker_state, kotak_service
    monkeypatch.setattr(day,'sessions_for',lambda *a:[user])
    monkeypatch.setattr(kotak_service,'get_service',lambda:object())
    finished=MagicMock();monkeypatch.setattr(day,'finish',finished);monkeypatch.setattr(day,'broadcast',lambda *a:None)
    async def stop(*a):raise asyncio.CancelledError()
    monkeypatch.setattr(day.asyncio,'sleep',stop)
    with pytest.raises(asyncio.CancelledError):await day.complete_when_flat(user.user_id)
    assert not finished.called
    monkeypatch.setattr(emergency_exit,'position',lambda *a:Position(symbol='RELIND',side='FLAT',quantity=0,avg_entry_price=0))
    async def failure(*a):raise RuntimeError('Kotak report timeout')
    monkeypatch.setattr(real_broker_state,'refresh',failure)
    with pytest.raises(asyncio.CancelledError):await day.complete_when_flat(user.user_id)
    assert not finished.called

@pytest.mark.asyncio
async def test_done_request_is_user_wide_real_only_and_blocks_before_exit(user,monkeypatch):
    import asyncio
    from app.services import emergency_exit, strategy_service
    other=simulation.SimulationSession(session_id='other',symbol='BSESEN',date=user.date,start_time='09:15:00',speed=1,user_id=user.user_id,session_type='real',session_capital=10000)
    paper=simulation.SimulationSession(session_id='paper',symbol='NIFTY',date=user.date,start_time='09:15:00',speed=1,user_id=user.user_id,session_type='paper',session_capital=10000)
    foreign=simulation.SimulationSession(session_id='foreign',symbol='NIFTY',date=user.date,start_time='09:15:00',speed=1,user_id='other-user',session_type='real',session_capital=10000)
    monkeypatch.setattr(simulation,'_sessions',{s.session_id:s for s in [user,other,paper,foreign]})
    seen=[]
    monkeypatch.setattr(day,'begin',lambda *a:seen.append('barrier') or {'date':user.date,'state':'closing'})
    monkeypatch.setattr(day,'monitor',lambda *a:None);monkeypatch.setattr(day,'broadcast',lambda *a:None)
    monkeypatch.setattr(strategy_service,'cancel_all',lambda *a:0);monkeypatch.setattr(order_service,'get_open_orders',lambda *a:[])
    async def close(s):seen.append(s.session_id);return {'session_id':s.session_id,'results':[]}
    monkeypatch.setattr(emergency_exit,'exit_all',close)
    result=await day.done_for_day(user.user_id)
    assert seen==['barrier',user.session_id,other.session_id]
    assert result['state']=='closing'

def test_real_aliases_exit_once_per_broker_book(user):
    alias=simulation.SimulationSession(session_id='alias',symbol=user.symbol,date=user.date,start_time='09:15:00',speed=1,user_id=user.user_id,session_type='real',session_capital=10000)
    other=simulation.SimulationSession(session_id='sensex',symbol='BSESEN',date=user.date,start_time='09:15:00',speed=1,user_id=user.user_id,session_type='real',session_capital=10000)
    assert day.unique_books([user,alias,other])==[user,other]

def test_protection_is_not_blocked_by_lock_storage_outage(user,monkeypatch):
    getter=MagicMock(side_effect=RuntimeError('database down'));monkeypatch.setattr(day,'state',getter)
    day.require_entry_allowed(user,TradeSide.SELL,10)
    getter.assert_called_once()


@pytest.mark.asyncio
async def test_done_monitor_retries_failed_exit_and_verifies_before_completion(user, monkeypatch):
    from app.services import emergency_exit, real_broker_state, kotak_service, real_close
    from unittest.mock import AsyncMock
    monkeypatch.setattr(day, 'sessions_for', lambda *a: [user])
    monkeypatch.setattr(kotak_service, 'get_service', lambda: object())
    monkeypatch.setattr(order_service, 'get_open_orders', lambda *a: [])
    monkeypatch.setattr(real_close, 'unresolved', lambda *a: False)
    monkeypatch.setattr(day, 'broadcast', lambda *a: None)
    remaining = [10]
    monkeypatch.setattr(emergency_exit, 'position', lambda *a: Position(symbol=user.symbol,
        side='LONG' if remaining[0] else 'FLAT', quantity=remaining[0], avg_entry_price=100))
    refresh = AsyncMock()
    monkeypatch.setattr(real_broker_state, 'refresh', refresh)
    attempts = []
    async def exit_book(session):
        attempts.append(session.session_id)
        if len(attempts) == 1:
            raise RuntimeError('Temporary broker outage')
        remaining[0] = 0
    monkeypatch.setattr(emergency_exit, 'exit_all', exit_book)
    monkeypatch.setattr(day.asyncio, 'sleep', AsyncMock())
    finished = MagicMock()
    monkeypatch.setattr(day, 'finish', finished)
    stopped = AsyncMock()
    monkeypatch.setattr(real_close, 'finish', stopped)
    await day.complete_when_flat(user.user_id)
    assert attempts == [user.session_id, user.session_id]
    assert refresh.await_count == 3
    finished.assert_called_once_with(user.user_id, user.date)
    stopped.assert_awaited_once_with(user)

@pytest.mark.asyncio
async def test_previous_day_verified_close_retains_warning_despite_unknown_history(user, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from app.services import real_close, execution_broker, kotak_reports, strategy_service

    user.date = '2020-01-01'
    user.state = simulation.SimulationState.RUNNING
    monkeypatch.setattr(simulation, '_upsert_session_to_db', MagicMock())
    monkeypatch.setattr(execution_broker, 'get_service', lambda *_: object())
    monkeypatch.setattr(strategy_service, 'cancel_all', lambda *_: None)
    monkeypatch.setattr(kotak_reports, 'fetch', AsyncMock(return_value=SimpleNamespace(
        positions=[], orders=[], executions=[])))
    monkeypatch.setattr(order_service, 'get_open_orders', lambda *_: [])
    monkeypatch.setattr(real_close, 'unresolved', lambda *_: True)
    finished = AsyncMock()
    monkeypatch.setattr(real_close, 'finish', finished)
    await real_close.close(user)
    await real_close._jobs[user.session_id]
    finished.assert_awaited_once_with(user)
    assert 'unverified' in user.real_history_warning
    simulation._upsert_session_to_db.assert_called_with(user, strict=True)


@pytest.mark.asyncio
async def test_current_day_verified_flat_fallback_retains_history_warning(user, monkeypatch):
    from unittest.mock import AsyncMock
    from app.services import real_close, real_broker_state, real_recovery, strategy_service
    user.state = simulation.SimulationState.RUNNING
    monkeypatch.setattr(simulation, '_upsert_session_to_db', MagicMock())
    monkeypatch.setattr(strategy_service, 'cancel_all', lambda *_: None)
    monkeypatch.setattr(order_service, 'get_open_orders', lambda *_: [])
    monkeypatch.setattr(real_close, 'unresolved', lambda *_: False)
    monkeypatch.setattr(real_broker_state, 'refresh', AsyncMock(side_effect=ValueError('Older fills unavailable')))
    monkeypatch.setattr(real_recovery, 'verify', AsyncMock(return_value={'verified_flat': True}))
    finished = AsyncMock()
    monkeypatch.setattr(real_close, 'finish', finished)
    await real_close.close(user)
    await real_close._jobs[user.session_id]
    finished.assert_awaited_once_with(user)
    assert 'unverified' in user.real_history_warning
    simulation._upsert_session_to_db.assert_called_with(user, strict=True)


@pytest.mark.asyncio
async def test_done_waits_for_durable_release_and_retries(user, monkeypatch):
    from unittest.mock import AsyncMock

    from app.services import (
        emergency_exit,
        execution_broker,
        real_broker_state,
        real_close,
    )

    monkeypatch.setattr(day, "sessions_for", lambda *_: [user])
    monkeypatch.setattr(execution_broker, "get_service", lambda *_: object())
    monkeypatch.setattr(real_broker_state, "refresh", AsyncMock())
    monkeypatch.setattr(
        emergency_exit,
        "position",
        lambda *_: Position(
            symbol=user.symbol, side="FLAT", quantity=0, avg_entry_price=0
        ),
    )
    monkeypatch.setattr(order_service, "get_open_orders", lambda *_: [])
    monkeypatch.setattr(real_close, "unresolved", lambda *_: False)
    monkeypatch.setattr(day, "broadcast", lambda *_: None)
    finished = MagicMock()
    monkeypatch.setattr(day, "finish", finished)
    attempts = []

    async def release(session):
        assert not finished.called
        attempts.append(session.session_id)
        if len(attempts) == 1:
            raise RuntimeError("Release transaction unavailable")

    monkeypatch.setattr(real_close, "finish", release)
    monkeypatch.setattr(day.asyncio, "sleep", AsyncMock())
    await day.complete_when_flat(user.user_id)
    assert attempts == [user.session_id, user.session_id]
    finished.assert_called_once_with(user.user_id, user.date)


@pytest.mark.asyncio
async def test_done_closes_authoritative_owner_and_all_live_aliases(user, monkeypatch):
    from unittest.mock import AsyncMock

    from app.services import (
        emergency_exit,
        execution_broker,
        real_broker_state,
        real_close,
    )

    alias = simulation.SimulationSession(
        session_id="alias",
        symbol=user.symbol,
        date=user.date,
        start_time="09:15:00",
        speed=1,
        user_id=user.user_id,
        session_type="real",
    )
    old = simulation.SimulationSession(
        session_id="old",
        symbol=user.symbol,
        date=user.date,
        start_time="09:15:00",
        speed=1,
        user_id=user.user_id,
        session_type="real",
    )
    old.state = simulation.SimulationState.ENDED
    user.real_active_claim = True
    monkeypatch.setattr(
        simulation, "_sessions", {"old": old, "alias": alias, "owner": user}
    )
    assert old not in day.sessions_for(user.user_id)
    assert day.unique_books(day.sessions_for(user.user_id)) == [user]
    monkeypatch.setattr(execution_broker, "get_service", lambda *_: object())
    monkeypatch.setattr(real_broker_state, "refresh", AsyncMock())
    monkeypatch.setattr(
        emergency_exit,
        "position",
        lambda *_: Position(
            symbol=user.symbol, side="FLAT", quantity=0, avg_entry_price=0
        ),
    )
    monkeypatch.setattr(order_service, "get_open_orders", lambda *_: [])
    monkeypatch.setattr(real_close, "unresolved", lambda *_: False)
    calls = []

    async def release(session):
        calls.append(session.session_id)

    monkeypatch.setattr(real_close, "finish", release)
    monkeypatch.setattr(day, "finish", lambda *_: calls.append("done"))
    monkeypatch.setattr(day, "broadcast", lambda *_: None)
    await day.complete_when_flat(user.user_id)
    assert calls == ["alias", user.session_id, "done"]


@pytest.mark.asyncio
async def test_done_empty_runtime_waits_for_outstanding_slot(user, monkeypatch):
    import asyncio

    monkeypatch.setattr(simulation, "_sessions", {})
    monkeypatch.setattr(day, "has_outstanding_day_slot", lambda *_: True)
    finished = MagicMock()
    monkeypatch.setattr(day, "finish", finished)
    monkeypatch.setattr(day, "broadcast", lambda *_: None)

    async def stop(*_):
        raise asyncio.CancelledError()

    monkeypatch.setattr(day.asyncio, "sleep", stop)
    with pytest.raises(asyncio.CancelledError):
        await day.complete_when_flat(user.user_id)
    finished.assert_not_called()


@pytest.mark.asyncio
async def test_old_done_status_restarts_release_repair(user, monkeypatch):
    monkeypatch.setattr(day, "begin", lambda *_: {"date": user.date, "state": "done"})
    resume = MagicMock()
    monkeypatch.setattr(day, "monitor", resume)
    result = await day.done_for_day(user.user_id)
    assert result["state"] == "done"
    resume.assert_called_once_with(user.user_id)
