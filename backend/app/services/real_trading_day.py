"""Irreversible IST-day entry barrier and confirmed-flat completion for a user."""
import asyncio
from datetime import datetime
import json
import logging
from app.services import order_service
from zoneinfo import ZoneInfo

from fastapi import HTTPException

logger = logging.getLogger(__name__)
_jobs = {}
_terminal = set()
_table_ready = False


def market_date():
    return datetime.now(ZoneInfo('Asia/Kolkata')).date().isoformat()


def table():
    global _table_ready
    from app.services import wallet_service
    from app.services.db import get_dynamodb_resource
    if not _table_ready:
        wallet_service._ensure_ledger_table()
        _table_ready = True
    return get_dynamodb_resource().Table('WalletLedgers')


def state(user_id):
    date = market_date()
    if (user_id, date) in _terminal:
        return {'date': date, 'state': 'done'}
    row = table().get_item(Key={'user_id': user_id, 'ledger_id': 'real-day-lock:' + date}, ConsistentRead=True).get('Item', {})
    value = {'date': date, 'state': row.get('real_trading_state', 'active'), 'message': row.get('message', '')}
    if value['state'] == 'done':
        _terminal.add((user_id, date))
    return value


def begin(user_id):
    date = market_date()
    row = table().update_item(
        Key={'user_id': user_id, 'ledger_id': 'real-day-lock:' + date},
        UpdateExpression='SET real_trading_state = if_not_exists(real_trading_state, :closing), started_at = if_not_exists(started_at, :now)',
        ExpressionAttributeValues={':closing': 'closing', ':now': datetime.now(ZoneInfo('Asia/Kolkata')).isoformat()},
        ReturnValues='ALL_NEW')['Attributes']
    return {'date': date, 'state': row['real_trading_state']}


def finish(user_id, date):
    from botocore.exceptions import ClientError
    try:
        table().update_item(Key={'user_id': user_id, 'ledger_id': 'real-day-lock:' + date},
            UpdateExpression='SET real_trading_state = :done, completed_at = :now, message = :message',
            ConditionExpression='real_trading_state = :closing',
            ExpressionAttributeValues={':done':'done', ':closing':'closing', ':now':datetime.now(ZoneInfo('Asia/Kolkata')).isoformat(), ':message':'All real session positions confirmed closed; real trading is locked for this IST day'})
    except ClientError as exc:
        if exc.response['Error']['Code'] != 'ConditionalCheckFailedException':
            raise
        if state(user_id)['state'] != 'done':
            raise RuntimeError('Daily lock was not in closing state; completion was not committed')
    _terminal.add((user_id,date))
    logger.info('real_day_locked user=%s date=%s', user_id, date)


def require_entry_allowed(session, side, quantity, right=None, strike=None, expiry=None):
    if session.session_type != 'real' or getattr(session,'trading_style','intraday') == 'swing':
        return
    if getattr(session, 'real_start_preparing', False) and session.state.value == 'idle' and not session.real_closing:
        raise HTTPException(409, 'Real startup is not complete; recover or close the session before trading')
    from app.services.trading import get_position
    position = get_position(session.session_id, session.symbol, right=right, strike=strike, expiry=expiry, exact_contract=True)
    name = getattr(side, 'value', side)
    closing = (position.side == 'LONG' and name == 'SELL') or (position.side == 'SHORT' and name == 'BUY')
    pure_exit = closing and 0 < quantity <= position.quantity
    if not pure_exit and (getattr(session, 'real_entries_paused', False) or getattr(session, 'real_recovery_pending', False)):
        raise HTTPException(409, 'Real entries are paused or recovering; existing positions remain manageable')
    if not pure_exit:
        from app.services.real_close import unresolved
        if unresolved(session):
            raise HTTPException(409, 'A Real broker operation is unconfirmed; reconcile before submitting new entries')
        from app.services.real_funding import require_entry
        require_entry(session)
    if not pure_exit and getattr(session, 'real_recovery_pending', False):
        raise HTTPException(409, 'Real recovery is pending; entries wait for broker reconciliation')
    try:
        status = state(session.user_id)
    except Exception as exc:
        if pure_exit:
            logger.warning('real_day_storage_unavailable_exit_allowed user=%s session=%s',session.user_id,session.session_id)
            return  # DB outage cannot strand protection while entries fail closed.
        raise HTTPException(503, 'Could not verify daily real-trading lock; no new entry submitted') from exc
    if getattr(session, 'real_active_claim', False) and status.get('date') and status['date'] != session.date:
        raise HTTPException(403, 'Previous-day Real sessions are read-only; verify closure before starting today')
    if getattr(session, 'real_closing', False) and not pure_exit:
        raise HTTPException(403, 'Real session is closing; new entries are blocked')
    if status['state'] == 'active' or (status['state'] == 'closing' and pure_exit):
        return
    raise HTTPException(403, f'Real trading is {status["state"]} for {status["date"]}; Done for day cannot be undone')


def sessions_for(user_id):
    from app.services import simulation

    return [
        s
        for s in simulation._sessions.values()
        if s.user_id == user_id
        and s.session_type == "real"
        and getattr(s, "trading_style", "intraday") != "swing"
        and s.date == market_date()
        and (
            s.state != simulation.SimulationState.ENDED
            or (getattr(s, "real_active_claim", False) and not s.real_verified_closed)
        )
    ]


def unique_books(sessions):
    # Real aliases share one broker book. Do not submit the same contract twice
    # merely because the user has another runtime view of that symbol/mode.
    result = {}
    for session in sessions:
        key = (
            session.execution_broker,
            session.broker_account_id,
            session.symbol,
            session.instrument_type,
        )
        previous = result.get(key)
        if previous is None or (
            getattr(session, "real_active_claim", False)
            and not getattr(previous, "real_active_claim", False)
        ):
            result[key] = session
    return list(result.values())


def broadcast(user_id, status, message):
    for session in sessions_for(user_id):
        session.queue.put_nowait(json.dumps({'type':'real_trading_day_status','session_id':session.session_id,**status,'message':message}))


def has_outstanding_day_slot(user_id, date):
    """Four canonical broker/style rows plus owned session point reads; no scans."""
    from app.services import real_sessions
    from app.services.db import get_dynamodb_resource

    rows = [
        row for row in real_sessions.active_all(user_id) if row["style"] == "intraday"
    ]
    if not rows:
        return False
    sessions = get_dynamodb_resource().Table("Sessions")
    for row in rows:
        record = sessions.get_item(
            Key={"session_id": row["session_id"]}, ConsistentRead=True
        ).get("Item")
        if (
            not record
            or record.get("user_id") != user_id
            or record.get("date") in (None, date)
        ):
            return True
    return False


async def complete_when_flat(user_id):
    from app.services import emergency_exit, real_broker_state, real_close
    from app.services.execution_broker import get_service

    date = market_date()
    try:
        while market_date() == date:
            all_sessions = sessions_for(user_id)
            sessions = unique_books(all_sessions)
            try:
                exit_attempted = False
                for session in sessions:
                    await real_broker_state.refresh(session, get_service(session))
                for session in all_sessions:
                    await cancel_entries(session)
                for session in sessions:
                    if any(
                        emergency_exit.position(session, target).quantity
                        for target in emergency_exit.targets(session)
                    ):
                        exit_attempted = True
                        await emergency_exit.exit_all(session)
                still_open = any(
                    emergency_exit.position(s, target).quantity
                    for s in sessions
                    for target in emergency_exit.targets(s)
                )
                pending = any(
                    order_service.get_open_orders(s.session_id) for s in all_sessions
                )
                if (
                    not exit_attempted
                    and not still_open
                    and not pending
                    and not any(real_close.unresolved(s) for s in all_sessions)
                ):
                    # Stop aliases first; only then release the authoritative
                    # owner, so no old viewer can interfere with the next user.
                    for session in sorted(
                        all_sessions,
                        key=lambda s: getattr(s, "real_active_claim", False),
                    ):
                        await real_close.finish(session)
                    if not await asyncio.to_thread(
                        has_outstanding_day_slot, user_id, date
                    ):
                        await asyncio.to_thread(finish, user_id, date)
                        broadcast(
                            user_id,
                            {"date": date, "state": "done"},
                            "Done for day: all positions confirmed closed; real trading locked for today",
                        )
                        return
            except Exception as exc:
                logger.warning("real_day_completion_pending user=%s: %s", user_id, exc)
                broadcast(
                    user_id,
                    {"date": date, "state": "closing"},
                    f"Waiting to verify all positions closed: {exc}",
                )
            await asyncio.sleep(5)
    except Exception as exc:
        logger.exception("real_day_completion_failed user=%s", user_id)
        broadcast(
            user_id,
            {"date": date, "state": "closing"},
            f"Day closure needs attention: {exc}",
        )
    finally:
        _jobs.pop(user_id, None)


def monitor(user_id):
    if user_id not in _jobs:
        _jobs[user_id] = asyncio.create_task(complete_when_flat(user_id))


async def cancel_entries(session):
    """Retry entry cancellations while retaining exits for confirmed conversion."""
    from app.routers.orders import cancel_order
    from app.services.simulation import _is_position_exit
    from app.services.trading import get_position
    error = None
    for order in list(order_service.get_open_orders(session.session_id)):
        pos = get_position(session.session_id, session.symbol, right=order.right,
            strike=order.strike, expiry=order.expiry, exact_contract=True)
        if _is_position_exit(session, order) and max(0, order.quantity - order.broker_filled_quantity) <= pos.quantity:
            continue
        try:
            await cancel_order(order.order_id, session.session_id)
        except Exception as exc:
            error = exc
    if error is not None:
        raise error


async def done_for_day(user_id):
    from app.services import emergency_exit, simulation, strategy_service

    status = await asyncio.to_thread(begin, user_id)
    if status["state"] == "done":
        # Repair old 'done before release' failures without lifting the day barrier.
        monitor(user_id)
        return {**status, "results": []}
    logger.info(
        "real_day_closure_requested user=%s date=%s state=%s",
        user_id,
        status["date"],
        status["state"],
    )
    results = []
    # Cancel entries/strategies on every alias, but submit exits once per book.
    sessions = sessions_for(user_id)
    for session in sessions:
        session.real_day_closing = True
        session.real_closing = True
        try:
            await asyncio.to_thread(
                simulation._upsert_session_to_db, session, strict=True
            )
        except Exception as exc:
            results.append({"session_id": session.session_id, "error": str(exc)})
        try:
            strategy_service.cancel_all(session.session_id)
        except Exception as exc:
            results.append({"session_id": session.session_id, "error": str(exc)})
        try:
            await cancel_entries(session)
        except Exception as exc:
            results.append(
                {
                    "session_id": session.session_id,
                    "error": str(getattr(exc, "detail", exc)),
                }
            )
    for session in unique_books(sessions):
        try:
            results.append(await emergency_exit.exit_all(session))
        except Exception as exc:
            results.append(
                {
                    "session_id": session.session_id,
                    "error": str(getattr(exc, "detail", exc)),
                }
            )
    monitor(user_id)
    broadcast(
        user_id,
        status,
        "Done for day requested: closing positions; new real entries blocked",
    )
    return {**status, "results": results}


async def shutdown():
    jobs=list(_jobs.values())
    for job in jobs: job.cancel()
    await asyncio.gather(*jobs,return_exceptions=True)
    _jobs.clear()
