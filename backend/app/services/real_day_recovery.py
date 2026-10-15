"""Real Day reconnect and legacy cutover. Timeouts never discard a broker book."""
import asyncio
import logging
import time
import uuid
from types import SimpleNamespace

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from fastapi import HTTPException

from app.services import execution_broker, real_session_slots as slots, real_sessions, simulation

logger = logging.getLogger(__name__)


def _saved(sid):
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table("Sessions").get_item(
        Key={"session_id": sid}, ConsistentRead=True).get("Item")


def _legacy_candidates(req, user, broker):
    """An explicit Start lookup through the existing user index, never a table scan."""
    from app.services.db import get_dynamodb_resource
    table = get_dynamodb_resource().Table("Sessions")
    params = {"IndexName": "UserIdIndex", "KeyConditionExpression": Key("user_id").eq(user)}
    found = []
    latest_date = ""
    while True:
        page = table.query(**params)
        for item in page.get("Items", []):
            if (item.get("session_type") == "real" and item.get("trading_style", "intraday") == "intraday"
                and item.get("date", "") <= req.date and item.get("broker_projection_id") != item["session_id"]
                and execution_broker.name(item.get("execution_broker")) == broker):
                latest_date = max(latest_date, item.get("date", ""))
            if (item.get("session_type") == "real" and item.get("trading_style", "intraday") == "intraday"
                and item.get("date", "") <= req.date
                and not item.get("real_verified_closed") and not item.get("real_funding_period")
                and item.get("record_type") != "real_preparation"
                and item.get("broker_projection_id") != item["session_id"]
                and execution_broker.name(item.get("execution_broker")) == broker):
                found.append(item)
        if not page.get("LastEvaluatedKey"):
            current = [_saved(item["session_id"]) for item in found if item.get("date") == latest_date]
            return [item for item in current if item and not item.get("real_verified_closed") and not item.get("real_funding_period")]
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def bind_legacy(record, user, broker, account):
    """Bind only an account proven by stored identity or the legacy projection hash."""
    from app.services import real_broker_state
    from app.services.db import get_dynamodb_client
    if record.get("user_id") != user or execution_broker.name(record.get("execution_broker")) != broker:
        raise HTTPException(409, "Legacy Real session owner or broker differs")
    saved_account = record.get("broker_account_id") or record.get("_fifo_account")
    if saved_account and saved_account != account:
        raise HTTPException(409, "Restore the original broker account before recovering the saved Real session")
    expected = real_broker_state.projection_id(SimpleNamespace(**record), account)
    if not saved_account and record.get("broker_projection_id") != expected:
        raise HTTPException(409, "The original account cannot be verified from this legacy session; reconcile its identity before starting")
    sid = record["session_id"]
    current = slots.read(broker, account, "intraday")
    if current and (current["owner_user_id"] != user or current["session_id"] != sid or current.get("recovery_conflict")):
        raise HTTPException(409, "Another Real Day book requires reconciliation before legacy recovery")
    names = {"#owner": "user_id"}
    values = {":user": user, ":account": account, ":broker": broker}
    conditions = ["#owner = :user"]
    for i, field in enumerate(("broker_account_id", "broker_projection_id", "execution_broker", "state", "real_verified_closed", "real_funding_period")):
        names[f"#f{i}"] = field
        if field in record:
            values[f":f{i}"] = record[field]
            conditions.append(f"#f{i} = :f{i}")
        else:
            conditions.append(f"attribute_not_exists(#f{i})")
    actions = [{"Update": {"TableName": "Sessions", "Key": slots.serialize({"session_id": sid}),
        "UpdateExpression": "SET broker_account_id = :account, execution_broker = :broker",
        "ConditionExpression": " AND ".join(conditions), "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": slots.serialize(values)}}]
    if current:
        # Repair the cutover's unbound slot together with the saved record.
        actions.append({"Update": {"TableName": "WalletLedgers", "Key": slots.serialize(slots.key(broker, account, "intraday")),
            "UpdateExpression": "SET #account = :account REMOVE unbound_account",
            "ConditionExpression": "owner_user_id = :owner AND session_id = :sid AND operation_id = :token AND engine_until < :now AND (#account = :account OR attribute_not_exists(#account) OR #account = :none)",
            "ExpressionAttributeNames": {"#account": "account"},
            "ExpressionAttributeValues": slots.serialize({":account": account, ":owner": user, ":sid": sid,
                ":token": current["operation_id"], ":now": int(time.time()), ":none": None})}})
    try:
        get_dynamodb_client().transact_write_items(TransactItems=actions)
    except ClientError as exc:
        raise HTTPException(409, "Legacy session changed during recovery; refresh and retry") from exc
    record = {**record, "broker_account_id": account, "execution_broker": broker}
    slots.adopt(user, record)
    logger.info("real_legacy_book_bound session_id=%s", sid)
    return record


async def adopt_legacy_context(req, user, broker, account):
    row = await asyncio.to_thread(slots.read, broker, account, "intraday")
    if row and not row.get("unbound_account"):
        return
    if row and row["owner_user_id"] != user:
        return
    candidates = await asyncio.to_thread(_legacy_candidates, req, user, broker)
    if len(candidates) > 1:
        raise HTTPException(409, "Multiple legacy Real books match this session; reconcile them before starting")
    if candidates:
        await asyncio.to_thread(bind_legacy, candidates[0], user, broker, account)


async def expire_local_engine(session):
    """Invalidate this worker before stopping it; no late callback may submit."""
    session.real_engine_valid_until = 0
    session.real_authority_lost = True
    task = getattr(session, "real_engine_task", None)
    if task and task is not asyncio.current_task():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    simulation.stop_session(session, preserve_trading_state=True)
    # Release execution authority only, never logical book ownership.
    try:
        await asyncio.to_thread(slots.table().update_item,
            Key=slots.key(session.execution_broker, session.broker_account_id, "intraday"),
            UpdateExpression="SET engine_until = :zero",
            ConditionExpression="owner_user_id = :user AND session_id = :sid AND operation_id = :token AND #state <> :closed",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues=slots.encode({":zero": 0, ":user": session.user_id, ":sid": session.session_id,
                                                   ":token": session.real_claim_token, ":closed": "closed"}))
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            logger.warning("real_engine_expiry_pending session_id=%s error_type=%s", session.session_id, type(exc).__name__)
    except Exception as exc:
        logger.warning("real_engine_expiry_pending session_id=%s error_type=%s", session.session_id, type(exc).__name__)


async def check_handoff(user, broker, account):
    row = await asyncio.to_thread(slots.read, broker, account, "intraday")
    if not row or row["owner_user_id"] != user or not row.get("handoff_token"):
        return
    now = int(time.time())
    if int(row.get("handoff_started_at", now)) > now - slots.DAY_LEASE_SECONDS or int(row.get("engine_until", 0)) >= now:
        raise HTTPException(409, "This Real Day book is being verified; retry recovery shortly")
    # A crashed handoff worker cannot leave a permanent blocker.
    try:
        await asyncio.to_thread(slots.table().update_item,
            Key=slots.key(broker, account, "intraday"),
            UpdateExpression="REMOVE handoff_token, handoff_started_at",
            ConditionExpression="owner_user_id = :owner AND session_id = :sid AND operation_id = :token AND handoff_token = :handoff AND engine_until < :now",
            ExpressionAttributeValues=slots.encode({":owner": user, ":sid": row["session_id"], ":token": row["operation_id"], ":handoff": row["handoff_token"], ":now": now}))
    except ClientError as exc:
        raise HTTPException(409, "Real recovery changed concurrently; refresh and retry") from exc


async def retire_failed_engine(user, broker, account):
    row = await asyncio.to_thread(slots.read, broker, account, "intraday")
    if not row or row["owner_user_id"] != user:
        return
    session = simulation.get_session(row["session_id"])
    if session and not real_sessions.engine_healthy(session):
        logger.warning("real_engine_recovery_requested session_id=%s", session.session_id)
        await expire_local_engine(session)


async def recover(user, sid):
    from app.dependencies import require_real_trading_access
    from app.services.real_trading_day import market_date
    from app.models.schemas import SimulationStartRequest
    from app.routers.simulation import start_with_paper_claim, _session_response
    require_real_trading_access(user)
    record = await asyncio.to_thread(_saved, sid)
    if not record or record.get("user_id") != user or record.get("session_type") != "real":
        raise HTTPException(404, "Real session not found")
    if record.get("trading_style", "intraday") != "intraday":
        raise HTTPException(400, "Real Day session required")
    if record.get("real_verified_closed"):
        raise HTTPException(410, "Real session is verified closed")
    broker = execution_broker.name(record.get("execution_broker"))
    service = execution_broker.get_service(broker)
    if not await asyncio.to_thread(service.is_authenticated):
        raise HTTPException(401, "Reconnect the original broker before recovering this session")
    account = await asyncio.to_thread(service.account_identity)
    if not record.get("broker_account_id"):
        record = await asyncio.to_thread(bind_legacy, record, user, broker, account)
    if record.get("broker_account_id") != account:
        raise HTTPException(409, "Restore the original broker account before recovery")
    await check_handoff(user, broker, account)
    await retire_failed_engine(user, broker, account)
    runtime = simulation.get_session(sid)
    today = market_date()
    if record["date"] < today:
        await real_sessions.recover_previous_day(user, broker, account, today)
        raise HTTPException(410, "Previous-day book is verified closed; start today's session")
    if record["date"] > today:
        raise HTTPException(409, "Saved Real trading date is ahead of today; reconcile this book before starting")
    if runtime and real_sessions.engine_healthy(runtime):
        return _session_response(runtime)
    if record.get("real_closing"):
        session = await real_sessions.restore_for_close(record, user)
        from app.services import real_close
        await real_close.close(session)
        return _session_response(session)
    fields = {k: v for k, v in record.items() if k in SimulationStartRequest.model_fields}
    fields.pop("group_id", None)  # A saved UI group can have ended while this broker book remains open.
    fields.update(session_type="real", execution_broker=broker, override=False)
    return await start_with_paper_claim(SimulationStartRequest.model_validate(fields), user,
        desktop_independent=bool(record.get("desktop_created")))


async def heartbeat(user, sid):
    from app.dependencies import require_real_trading_access
    require_real_trading_access(user)
    rows = await asyncio.to_thread(slots.for_user, user)
    row = next((r for r in rows if r["session_id"] == sid and r["style"] == "intraday"), None)
    if not row:
        raise HTTPException(404, "Outstanding Real Day session not found")
    try:
        return await asyncio.to_thread(slots.client_heartbeat, row["broker"], row["account"], user, sid)
    except ClientError as exc:
        raise HTTPException(409, "Real session ownership changed; reconnect to its current status") from exc


def _active_wire_work(session):
    from app.services import order_service
    from app.services.broker_conversion import busy
    from app.services.order_split import ACTIVE
    return any(busy(order) or (order.split_operation or {}).get("state") in ACTIVE
               for order in order_service.get_all_orders(session.session_id))


async def release_stale(user, broker, account):
    """Another user's Start may close a stale flat book, never its exposure."""
    from app.services import real_recovery, real_close, order_service
    row = await asyncio.to_thread(slots.read, broker, account, "intraday")
    if not row or row["owner_user_id"] == user:
        return
    seen = row.get("last_client_seen_at")
    if not seen or int(seen) > int(time.time()) - slots.DAY_LEASE_SECONDS:
        return
    if row.get("account") != account or row.get("recovery_conflict") or row.get("handoff_token") or row.get("state") == "closing":
        raise HTTPException(409, "Outstanding Real Day book requires recovery")
    # Serialize with local order submissions before changing durable authority.
    from app.routers.orders import _session_edit_lock
    runtime = simulation.get_session(row["session_id"])
    if runtime is None and int(row.get("engine_until", 0)) >= int(time.time()):
        raise HTTPException(409, "The outstanding engine is on another server; wait for its authority to expire before recovery")
    lock = _session_edit_lock(runtime) if runtime else real_sessions._locks.setdefault((broker, account), asyncio.Lock())
    async with lock:
        token = str(uuid.uuid4())
        try:
            await asyncio.to_thread(slots.table().update_item,
                Key=slots.key(broker, account, "intraday"),
                UpdateExpression="SET engine_until = :zero, operation_id = :new, handoff_token = :new, handoff_started_at = :at",
                ConditionExpression="owner_user_id = :owner AND session_id = :sid AND operation_id = :old AND #account = :account AND last_client_seen_at = :seen AND #state <> :closed AND attribute_not_exists(handoff_token)",
                ExpressionAttributeNames={"#account": "account", "#state": "state"},
                ExpressionAttributeValues=slots.encode({":zero": 0, ":new": token, ":at": int(time.time()), ":owner": row["owner_user_id"],
                    ":sid": row["session_id"], ":old": row["operation_id"], ":account": account, ":seen": seen, ":closed": "closed"}))
        except ClientError as exc:
            raise HTTPException(409, "Real session changed during recovery; refresh and retry") from exc
        if runtime:
            await expire_local_engine(runtime)
    failure = None
    try:
        record = await asyncio.to_thread(_saved, row["session_id"])
        session = await real_sessions.restore_for_close(record, row["owner_user_id"])
        result = await real_recovery.verify(session)
        if not result["verified_flat"] or result.get("closure_blocked") or order_service.get_open_orders(session.session_id) or _active_wire_work(session):
            raise HTTPException(409, "Outstanding Real Day book has exposure or pending orders; its original owner must recover it")
        await real_close.finish(session)
        logger.info("real_stale_flat_book_released session_id=%s", row["session_id"])
    except Exception as exc:
        logger.warning("real_stale_release_blocked session_id=%s error_type=%s", row["session_id"], type(exc).__name__)
        failure = exc
    finally:
        # Failed verification retains the original owner and recoverable book.
        try:
            await asyncio.to_thread(slots.table().update_item,
                Key=slots.key(broker, account, "intraday"), UpdateExpression="REMOVE handoff_token, handoff_started_at",
                ConditionExpression="owner_user_id = :owner AND session_id = :sid AND handoff_token = :handoff",
                ExpressionAttributeValues=slots.encode({":owner": row["owner_user_id"], ":sid": row["session_id"], ":handoff": token}))
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                logger.warning("real_handoff_cleanup_pending session_id=%s error_type=%s", row["session_id"], type(exc).__name__)
        except Exception as exc:
            logger.warning("real_handoff_cleanup_pending session_id=%s error_type=%s", row["session_id"], type(exc).__name__)

    if failure is not None:
        # Resume management under the original owner, never free an exposed book.
        try:
            await recover(row["owner_user_id"], row["session_id"])
        except Exception as exc:
            logger.warning("real_stale_owner_recovery_pending session_id=%s error_type=%s", row["session_id"], type(exc).__name__)
        raise HTTPException(409, "Outstanding Real Day book could not be safely released; its original owner retains it") from failure
