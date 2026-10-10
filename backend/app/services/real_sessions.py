"""One active Real session per user, shared by website and desktop."""
import asyncio
import uuid
import time
from contextvars import ContextVar
from weakref import WeakValueDictionary
from fastapi import HTTPException

_locks = WeakValueDictionary()
_context = ContextVar("real_start_claim", default=None)
_recovery = ContextVar("real_recovery_record", default=None)


def _table():
    from app.services.wallet_service import _ensure_ledger_table
    from app.services.db import get_dynamodb_resource
    _ensure_ledger_table()
    return get_dynamodb_resource().Table('WalletLedgers')


def active(user_id):
    row = _table().get_item(Key={'user_id': user_id, 'ledger_id': 'real-active'}, ConsistentRead=True).get('Item', {})
    return row if isinstance(row, dict) and row.get('state') in ('starting', 'running', 'closing') else None


def _claim(user_id, token, session_id=None):
    from botocore.exceptions import ClientError
    try:
        _table().put_item(Item={'user_id': user_id, 'ledger_id': 'real-active', 'state': 'starting', 'operation_id': token, 'engine_until': int(time.time()) + 45, 'session_id': session_id or ''},
            ConditionExpression='attribute_not_exists(#state) OR #state = :closed OR engine_until < :now',
            ExpressionAttributeNames={'#state': 'state'}, ExpressionAttributeValues={':closed': 'closed', ':now': int(time.time())})
    except ClientError as exc:
        if exc.response['Error']['Code'] == 'ConditionalCheckFailedException':
            raise HTTPException(409, 'A Real session is active or starting; attach to it or close it before starting another') from exc
        raise


def _finish(user_id, token, session_id=None):
    _table().update_item(Key={'user_id': user_id, 'ledger_id': 'real-active'},
        UpdateExpression='SET #state = :state, session_id = :sid, engine_until = :until', ConditionExpression='operation_id = :token',
        ExpressionAttributeNames={'#state': 'state'},
        ExpressionAttributeValues={':state': 'running' if session_id else 'closed', ':sid': session_id or '', ':token': token, ':until': int(time.time()) + 45 if session_id else 0})


def release(session):
    _table().update_item(Key={'user_id': session.user_id, 'ledger_id': 'real-active'},
        UpdateExpression='SET #state = :closed', ConditionExpression='session_id = :sid AND operation_id = :token',
        ExpressionAttributeNames={'#state': 'state'}, ExpressionAttributeValues={':closed': 'closed', ':sid': session.session_id, ':token': session.real_claim_token})


async def start(req, user_id, create):
    from app.dependencies import require_real_trading_access
    from app.services import simulation, execution_broker, user_settings_service
    require_real_trading_access(user_id)
    from app.services.real_trading_day import market_date
    if req.date != market_date():
        raise HTTPException(400, "Real trading requires today IST")
    lock = _locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        chosen = execution_broker.name((await asyncio.to_thread(user_settings_service.get_settings, user_id, strict=True))['real_execution_broker'])
        # Existing live objects also fence legacy sessions predating the durable slot.
        runtime = next((s for s in simulation._sessions.values() if s.user_id == user_id and s.session_type == 'real'
                        and s.state != simulation.SimulationState.ENDED), None)
        slot = await asyncio.to_thread(active, user_id)
        if runtime:
            if getattr(runtime, "real_start_preparing", False) and runtime.task is None and not runtime.real_closing:
                raise HTTPException(409, "Real startup is incomplete; inspect and close the outstanding session before retrying")
            if runtime.date != req.date:
                raise HTTPException(409, "Close the outstanding previous-day Real session before starting today")
            if execution_broker.name(runtime) != chosen or runtime.symbol != req.symbol or runtime.instrument_type != req.instrument_type:
                raise HTTPException(409, 'Close the active Real session before changing broker, underlying or instrument type')
            from app.routers.simulation import _session_response
            return _session_response(runtime)
        record = None
        if slot:
            if int(slot.get("engine_until") or 0) >= int(time.time()):
                raise HTTPException(409, f"Real session {slot.get('session_id') or 'startup'} is running on another backend; reconnect there")
            sid = slot.get('session_id')
            if not sid:
                # Engines bind their saved identity before they can send an order.
                # An expired unbound preparation is therefore safe to replace.
                slot = None
            from app.services.db import get_dynamodb_resource
            record = await asyncio.to_thread(lambda: get_dynamodb_resource().Table('Sessions').get_item(Key={'session_id': sid}, ConsistentRead=True).get('Item')) if sid else None
            if sid and (not record or execution_broker.name(record.get('execution_broker')) != chosen or record['symbol'] != req.symbol or record['instrument_type'] != req.instrument_type):
                raise HTTPException(409, 'Restore and close the existing Real book before switching broker or instrument')
            if record and record["date"] != req.date:
                raise HTTPException(409, "Close the outstanding previous-day Real session before starting today")
            # An expired lease permits restoring the same identity, never another book.
        token = str(uuid.uuid4())
        await asyncio.to_thread(_claim, user_id, token, record["session_id"] if record else None)
        context_token = _context.set((user_id, token))
        recovery_token = _recovery.set(record)
        async def renew_preparation():
            while True:
                await asyncio.sleep(10)
                def renew():
                    _table().update_item(Key={'user_id': user_id, 'ledger_id': 'real-active'},
                        UpdateExpression='SET engine_until = :until',
                        ConditionExpression='operation_id = :token AND #state <> :closed',
                        ExpressionAttributeNames={'#state': 'state'},
                        ExpressionAttributeValues={':until': int(time.time()) + 45, ':token': token, ':closed': 'closed'})
                try:
                    await asyncio.to_thread(renew)
                except Exception:
                    # Binding still conditionally checks ownership before execution.
                    return
        preparing = asyncio.create_task(renew_preparation())
        try:
            response = await create()
            await asyncio.to_thread(_finish, user_id, token, response.session_id)
            session = simulation.get_session(response.session_id)
            if session:
                session.real_active_claim = True
            if session and session.real_closing:
                from app.services.real_close import close
                await close(session)
            return response
        except Exception:
            # Keep an engine that actually started fenced even if its final write failed.
            live = next((s for s in simulation._sessions.values() if s.user_id == user_id and s.session_type == 'real'
                         and s.state != simulation.SimulationState.ENDED), None)
            if live:
                if not getattr(live, 'real_active_claim', False):
                    await bind_prepared(live)
            else:
                await asyncio.to_thread(_finish, user_id, token, record['session_id'] if record else None)
            raise
        finally:
            preparing.cancel()
            await asyncio.gather(preparing, return_exceptions=True)
            _context.reset(context_token)
            _recovery.reset(recovery_token)


def recovery_record():
    return _recovery.get()


async def bind_prepared(session):
    claim = _context.get()
    if claim is None:
        return
    user_id, token = claim
    await asyncio.to_thread(_finish, user_id, token, session.session_id)
    session.real_claim_token = token
    session.real_active_claim = True
    session.real_engine_lease_required = True
    session.real_engine_valid_until = time.monotonic() + 40
    async def renew():
        while session.state.value != 'ended':
            await asyncio.sleep(10)
            if session.state.value == 'ended':
                return
            def write():
                _table().update_item(Key={'user_id': user_id, 'ledger_id': 'real-active'},
                    UpdateExpression='SET engine_until = :until',
                    ConditionExpression='operation_id = :token AND #state <> :closed',
                    ExpressionAttributeNames={'#state': 'state'},
                    ExpressionAttributeValues={':until': int(time.time()) + 45, ':token': token, ':closed': 'closed'})
            try:
                await asyncio.to_thread(write)
                session.real_engine_valid_until = time.monotonic() + 40
            except Exception:
                if time.monotonic() >= session.real_engine_valid_until:
                    from app.services import simulation
                    import json
                    session.queue.put_nowait(json.dumps({'type': 'session_ended', 'session_id': session.session_id,
                        'message': 'Real engine ownership expired. The recorded book is read-only; reconnect to recover or verify closure.'}))
                    simulation.stop_session(session, preserve_trading_state=True)
                    return
    session.real_engine_task = asyncio.create_task(renew())


async def restore_for_close(record, user_id):
    """Recover a dead engine for explicit closure; never replay an expired broker day."""
    from app.services import simulation, execution_broker
    sid = record['session_id']
    lock = _locks.setdefault(user_id, asyncio.Lock())
    async with lock:
        runtime = simulation.get_session(sid)
        if runtime:
            return runtime
        slot = await asyncio.to_thread(active, user_id)
        if not slot or slot.get('session_id') != sid:
            raise HTTPException(409, 'This saved session is not the outstanding Real book')
        if int(slot.get('engine_until') or 0) >= int(time.time()):
            raise HTTPException(409, 'The Real engine is still owned by another backend; close it there')
        broker = execution_broker.get_service(record.get('execution_broker', 'KotakNeo'))
        account = await asyncio.to_thread(broker.account_identity)
        session = await asyncio.to_thread(simulation.rebuild_session_from_db, record, user_id, read_only=True)
        recorded_account = session.broker_account_id or getattr(session, '_fifo_account', None)
        if recorded_account and recorded_account != account:
            raise HTTPException(409, 'Restore the original broker account credentials before closing this book')
        token = str(uuid.uuid4())
        await asyncio.to_thread(_claim, user_id, token, sid)
        session.state = simulation.SimulationState.RUNNING
        session.broker_account_id = account
        session.desktop_read_only = False
        simulation._sessions[sid] = session
        context_token = _context.set((user_id, token))
        try:
            await bind_prepared(session)
        finally:
            _context.reset(context_token)
        return session
