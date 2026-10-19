"""Non-enforcing Real book records. Failed/missed heartbeats never stop trading."""
import asyncio
import logging
import time
import uuid

from boto3.dynamodb.conditions import Key

from app.services import real_session_slots as slots

logger = logging.getLogger(__name__)


def key(user, sid):
    return {"user_id": f"real-observe:{user}", "ledger_id": sid}


def record(user, sid, broker, account, style, token, *, state="running", date=None):
    from app.services.execution_broker import name
    broker = name(broker)
    now = int(time.time())
    try:
        slots.table().update_item(Key=key(user, sid),
            UpdateExpression="SET owner_user_id=:user, session_id=:sid, broker=:broker, #account=:account, #style=:style, operation_id=:token, engine_until=:until, updated_at=:now, #state=:state, trading_date=:date",
            ExpressionAttributeNames={"#account":"account", "#style":"style", "#state":"state"},
            ExpressionAttributeValues=slots.encode({":user":user, ":sid":sid, ":broker":broker, ":account":account,
                ":style":style, ":token":token, ":until":now+900, ":now":now, ":state":state, ":date":date}))
    except Exception as exc:
        logger.warning("real_observation_write_failed session_id=%s error_type=%s", sid, type(exc).__name__)


def presence(user, sid):
    try:
        slots.table().update_item(Key=key(user, sid), UpdateExpression="SET last_client_seen_at=:now",
            ExpressionAttributeValues={":now":int(time.time())})
    except Exception as exc:
        logger.warning("real_presence_write_failed session_id=%s error_type=%s", sid, type(exc).__name__)
    return {"session_id":sid, "enforced":False}


def active(user):
    rows = slots.table().query(KeyConditionExpression=Key("user_id").eq(f"real-observe:{user}"), ConsistentRead=True).get("Items", [])
    from app.services.real_trading_day import market_date
    return [slots.decode(row) for row in rows if row.get("state") not in ("closed", "stopped") and row.get("session_id")
            and (row.get("style") == "swing" or row.get("trading_date") == market_date())]


async def bind(session, claim):
    session.real_claim_token = claim["operation_id"]
    session.real_active_claim = True
    session.real_broker_restrictions_enabled = False
    session.real_engine_lease_required = False
    session.real_engine_valid_until = time.monotonic()+890
    previous = getattr(session, "real_engine_task", None)
    if previous:
        previous.cancel()
        await asyncio.gather(previous, return_exceptions=True)
    async def write():
        await asyncio.to_thread(record, session.user_id, session.session_id, claim["broker"], claim["account"], "intraday",
            claim["operation_id"], state="closing" if session.real_closing else "running", date=session.date)
    await write()
    async def heartbeat():
        while session.state.value != "ended":
            await asyncio.sleep(180)
            if session.state.value == "ended": return
            await write()
    session.real_engine_task = asyncio.create_task(heartbeat())


async def start(req, user, broker, account, create):
    from app.services import real_sessions, simulation, execution_broker
    lock = real_sessions._locks.setdefault((user, broker, account, req.symbol, req.date, req.instrument_type), asyncio.Lock())
    async with lock:
        runtime = next((s for s in simulation._sessions.values() if s.user_id==user and s.session_type=="real"
            and s.trading_style=="intraday" and execution_broker.name(s)==broker and s.symbol==req.symbol and s.date==req.date
            and s.instrument_type==req.instrument_type and s.broker_account_id==account and s.state.value!="ended"),None)
        if runtime and (runtime.real_closing or runtime.real_verified_closed):
            from app.services.real_close import stop
            await stop(runtime)
            runtime = None
        if runtime and real_sessions.engine_healthy(runtime):
            from app.routers.simulation import _session_response
            from app.services.real_accounting import restart_capital
            await restart_capital(runtime, execution_broker.get_service(broker), req.allocation_pct)
            return _session_response(runtime)
        if runtime:
            await asyncio.to_thread(simulation._upsert_session_to_db, runtime)
            simulation.stop_session(runtime, preserve_trading_state=True)
        records = await asyncio.to_thread(simulation.find_all_sessions_by_context, user, req.symbol, req.date, "real", req.instrument_type)
        records = [r for r in records if execution_broker.name(r.get("execution_broker"))==broker
            and (not r.get("broker_account_id") or r["broker_account_id"]==account) and r.get("broker_projection_id")!=r["session_id"]]
        saved = max(records, key=lambda r:int(r.get("created_at",0))) if records else None
        if saved:
            saved = {**saved, "real_closing":False, "real_verified_closed":False, "real_recovery_pending":False, "real_start_preparing":False}
        sid = saved["session_id"] if saved else str(uuid.uuid4())
        claim = {"session_id":sid, "broker":broker, "account":account, "operation_id":str(uuid.uuid4()), "observe_only":True}
        context = real_sessions._context.set(claim)
        recovery = real_sessions._recovery.set(saved)
        try:
            result = await create()
            session = simulation.get_session(sid)
            if session:
                session.real_start_preparing = False
                real_sessions.watch_execution(session)
                if session.real_closing:
                    from app.services.real_close import close
                    await close(session)
            return result
        finally:
            real_sessions._context.reset(context)
            real_sessions._recovery.reset(recovery)


def close(user, sid, broker, account, style, token, *, date=None, funding_period=None):
    record(user,sid,broker,account,style,token,state="closed",date=date)
    # Explicit closure may clean a matching strict row; it never gates Stop.
    try:
        from app.services.db import get_dynamodb_client
        actions=[slots.close_action(user,broker,account,style,sid,token)]
        if funding_period:
            from app.services.swing_funding_store import completion_action
            actions.append(completion_action(user,broker,account,funding_period,style,sid))
        get_dynamodb_client().transact_write_items(TransactItems=actions)
    except Exception:
        pass  # No strict row, or it belongs to another book; leave it unchanged.
