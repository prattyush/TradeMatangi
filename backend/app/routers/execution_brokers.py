"""Broker-neutral authenticated account and Real lifecycle facade."""
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from app.dependencies import require_real_trading_access
from app.services import execution_broker, simulation, real_broker_state, real_close

router = APIRouter(prefix='/api/brokers', tags=['brokers'])


def owned(session_id, user_id):
    session = simulation.get_session(session_id)
    if not session or session.user_id != user_id or session.session_type != 'real':
        raise HTTPException(404, 'Real session not found')
    return session


async def saved_real_record(session_id, user_id):
    from app.services.db import get_dynamodb_resource
    record = await asyncio.to_thread(lambda: get_dynamodb_resource().Table('Sessions').get_item(
        Key={'session_id': session_id}, ConsistentRead=True).get('Item'))
    if not record or record.get('session_type') != 'real':
        return None
    if record.get('user_id') != user_id:
        raise HTTPException(404, 'Real session not found')
    require_real_trading_access(user_id)
    return record


async def status_for(user_id):
    from app.services.user_settings_service import get_settings
    chosen = (await asyncio.to_thread(get_settings, user_id, strict=True))['real_execution_broker']
    broker = execution_broker.get_service(chosen)
    authenticated = await asyncio.to_thread(broker.is_authenticated)
    active = next((s for s in simulation._sessions.values() if s.user_id == user_id and s.session_type == 'real'
                   and s.state != simulation.SimulationState.ENDED), None)
    from app.services import real_sessions
    slot = await asyncio.to_thread(real_sessions.active, user_id)
    return {'broker': chosen, 'authenticated': authenticated, 'active_session_id': active.session_id if active else (slot or {}).get('session_id'),
            'account_id': await asyncio.to_thread(broker.account_identity) if authenticated else None}


@router.get('/status')
async def status(user_id: str = Depends(require_real_trading_access)):
    return await status_for(user_id)


@router.post('/{session_id}/reconcile')
async def reconcile(session_id: str, user_id: str = Depends(require_real_trading_access)):
    session = owned(session_id, user_id)
    return await real_broker_state.refresh(session, execution_broker.get_service(session))


@router.get('/{session_id}/close-summary')
async def close_summary(session_id: str, user_id: str = Depends(require_real_trading_access)):
    if simulation.get_session(session_id):
        return real_close.summary(owned(session_id, user_id))
    record = await saved_real_record(session_id, user_id)
    if not record:
        raise HTTPException(404, "Real session not found")
    return real_close.summary(await asyncio.to_thread(simulation.rebuild_session_from_db, record, user_id, read_only=True))


@router.post('/{session_id}/stop')
async def stop(session_id: str, user_id: str = Depends(require_real_trading_access)):
    if simulation.get_session(session_id):
        return await real_close.close(owned(session_id, user_id))
    record = await saved_real_record(session_id, user_id)
    if not record:
        raise HTTPException(404, "Real session not found")
    from app.services.real_sessions import restore_for_close
    return await real_close.close(await restore_for_close(record, user_id))
