"""Persisted per-user live kill switch for Kotak protection automation."""
import asyncio
import logging
import threading

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_values = {}
_epochs = {}


def enabled(user_id):
    with _lock:
        return _values.get(user_id, True)


def apply(user_id, value):
    with _lock:
        _values[user_id] = bool(value)
        _epochs[user_id] = _epochs.get(user_id, 0) + 1
    if value:
        from app.services import simulation, kotak_protection
        for session in list(simulation._sessions.values()):
            if session.user_id == user_id and session.task and not session.task.get_loop().is_closed():
                session.task.get_loop().call_soon_threadsafe(
                    lambda session=session: kotak_protection.request(session, reason='settings_enabled'))
    if not value:
        from app.services import kotak_protection
        for identity in list(kotak_protection._pending):
            loop = identity[0]
            if not loop.is_closed():
                def drop(identity=identity):
                    pending = kotak_protection._pending.get(identity, {})
                    for sid, (session, _, _) in list(pending.items()):
                        if session.user_id == user_id:
                            pending.pop(sid, None)
                loop.call_soon_threadsafe(drop)
        from app.services import simulation, order_service
        import json
        for session in list(simulation._sessions.values()):
            if session.user_id != user_id or session.session_type != 'real' or getattr(session, 'execution_broker', 'KotakNeo') != 'KotakNeo':
                continue
            contracts = {(o.right, o.strike, o.expiry) for o in order_service.get_all_orders(session.session_id)}
            for right, strike, expiry in contracts:
                try:
                    session.queue.put_nowait(json.dumps({'type': 'protection_recovery', 'session_id': session.session_id,
                        'symbol': session.symbol, 'right': right, 'strike': strike, 'expiry': expiry,
                        'state': 'cleared', 'message': 'Automatic Kotak protection disabled; manage stoplosses manually',
                        'replacement_ids': []}))
                except Exception:
                    logger.debug('Could not clear protection notice session=%s', session.session_id)


async def check(user_id, *, force=False):
    # A settings PUT is authoritative immediately, even during an older DB read.
    if not force and not enabled(user_id):
        return False
    with _lock:
        epoch = _epochs.get(user_id, 0)
    try:
        from app.services.user_settings_service import get_settings
        settings = await asyncio.to_thread(get_settings, user_id, strict=True)
        value = settings.get('kotak_automated_protection_enabled', True)
    except Exception:
        logger.exception('kotak_automation_settings_unavailable user=%s; automatic repair deferred', user_id)
        from app.services import simulation
        import json
        for session in list(simulation._sessions.values()):
            if session.user_id == user_id and session.session_type == 'real':
                try:
                    session.queue.put_nowait(json.dumps({'type': 'broker_error', 'message':
                        'Could not verify the Kotak automation setting; automatic protection deferred. Use Trade History Refresh to retry or manage SLs manually.'}))
                except Exception:
                    pass
        return False
    with _lock:
        if epoch == _epochs.get(user_id, 0):
            _values[user_id] = bool(value)
        return _values.get(user_id, True)
