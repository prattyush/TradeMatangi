"""Repair a stale Day session link using existing durable account ownership."""
import asyncio
import logging
import time
from fastapi import HTTPException
from botocore.exceptions import ClientError
from app.services import execution_broker, real_session_slots as slots, simulation
from app.services import swing_funding_store as funding

logger = logging.getLogger(__name__)


def _same(field, row, names, values, prefix):
    name, value = f"#{prefix}", f":{prefix}"
    names[name] = field
    if field not in row:
        return f"attribute_not_exists({name})"
    values[value] = row[field]
    return f"{name} = {value}"


async def repair(user, session_id):
    from app.services.db import get_dynamodb_resource
    record = await asyncio.to_thread(lambda: get_dynamodb_resource().Table("Sessions").get_item(
        Key={"session_id": session_id}, ConsistentRead=True).get("Item"))
    if not record or record.get("user_id") != user or record.get("session_type") != "real":
        raise HTTPException(404, "Real session not found")
    if record.get("trading_style", "intraday") != "intraday" or record.get("real_verified_closed"):
        raise HTTPException(409, "Only an outstanding Real Day session link can be repaired")
    owned = [row for row in await asyncio.to_thread(slots.for_user, user)
             if row["session_id"] == session_id and row["style"] == "intraday"]
    if len(owned) != 1 or owned[0].get("recovery_conflict"):
        raise HTTPException(409, "The saved session has conflicting or missing ownership; reconciliation is required")
    slot = owned[0]
    chosen = execution_broker.name(slot["broker"])
    if record.get("execution_broker") and execution_broker.name(record["execution_broker"]) != chosen:
        raise HTTPException(409, "The saved broker and ownership broker conflict; the link was not changed")
    broker = execution_broker.get_service(chosen)
    if not await asyncio.to_thread(broker.is_authenticated):
        raise HTTPException(401, f"Reconnect {chosen.title()} before repairing this session link")
    account = await asyncio.to_thread(broker.account_identity)
    if not isinstance(account, str) or not account:
        raise HTTPException(409, "The authenticated broker did not identify its account")
    if slot.get("account") and slot["account"] != account:
        raise HTTPException(409, "The authenticated broker account differs from this book's original ownership; reconnect the original account")
    if slot.get("account") == account and record.get("broker_account_id") == account and record.get("execution_broker") and not slot.get("unbound_account"):
        return {"repaired": False, "message": "Session link already matches. Use Reconcile with broker to recover or close the existing book."}
    runtime = simulation.get_session(session_id)
    if (runtime and runtime.state != simulation.SimulationState.ENDED) or int(slot.get("engine_until") or 0) >= int(time.time()):
        raise HTTPException(409, "The session engine is still active; stop it or wait for its recovery lease to expire before repairing its link")
    pool = await asyncio.to_thread(funding.read, user, chosen, account)
    participant = (pool or {}).get("participants", {}).get("intraday", {})
    funded = bool(pool and record.get("real_funding_period") == pool.get("period_id") and participant.get("active")
                  and participant.get("owner_user_id") == user and participant.get("identity") == session_id)
    # Missing metadata can be restored from the matching session or ownership slot. Replacing
    # a nonempty conflicting account, or binding an unbound slot, also needs the
    # independently persisted funding participant to identify this exact book.
    if ((not slot.get("account") and record.get("broker_account_id") != account) or (record.get("broker_account_id") and record["broker_account_id"] != account)) and not funded:
        raise HTTPException(409, "Ownership and funding cannot verify this saved account link; no identity was changed")
    old_pool = None
    old_account = record.get("broker_account_id")
    if old_account and old_account != account:
        old_pool = await asyncio.to_thread(funding.read, user, chosen, old_account)
        old_participant = (old_pool or {}).get("participants", {}).get("intraday", {})
        if old_participant.get("active") and old_participant.get("identity") == session_id:
            raise HTTPException(409, "This book has conflicting account funding records; reconcile them before repairing its link")
    def write():
        from app.services.db import get_dynamodb_client
        names = {"#user": "user_id", "#type": "session_type"}
        values = {":user": user, ":real": "real", ":account": account, ":broker": chosen, ":at": int(time.time()*1000)}
        condition = "#user = :user AND #type = :real AND " + " AND ".join(
            _same(field, record, names, values, f"record{i}")
            for i, field in enumerate(("broker_account_id", "execution_broker", "real_verified_closed", "real_funding_period", "state", "trading_style")))
        slot_names = {"#owner": "owner_user_id", "#sid": "session_id", "#lease": "engine_until", "#conflict": "recovery_conflict"}
        slot_values = {":user": user, ":sid": session_id, ":now": int(time.time()), ":no": False, ":account": account}
        slot_condition = "#owner = :user AND #sid = :sid AND (attribute_not_exists(#lease) OR #lease < :now) AND (attribute_not_exists(#conflict) OR #conflict = :no) AND " + " AND ".join(
            _same(field, slot, slot_names, slot_values, f"slot{i}")
            for i, field in enumerate(("account", "broker", "operation_id", "state")))
        actions = [
            {"Update": {"TableName": "Sessions", "Key": slots.serialize({"session_id": session_id}),
                "UpdateExpression": "SET broker_account_id = :account, execution_broker = :broker, identity_repaired_at = :at",
                "ConditionExpression": condition, "ExpressionAttributeNames": names, "ExpressionAttributeValues": slots.serialize(values)}},
            {"Update": {"TableName": "WalletLedgers", "Key": slots.serialize(slots.key(chosen, account, "intraday")),
                "UpdateExpression": "SET account = :account REMOVE unbound_account",
                "ConditionExpression": slot_condition, "ExpressionAttributeNames": slot_names, "ExpressionAttributeValues": slots.serialize(slot_values)}},
        ]
        if funded:
            actions.append({"ConditionCheck": {"TableName": "WalletLedgers",
                "Key": slots.serialize({"user_id": funding.partition(chosen, account), "ledger_id": funding.key(chosen, account)}),
                "ConditionExpression": "#version = :version AND period_id = :period AND participants.intraday.#owner = :user AND participants.intraday.#identity = :sid AND participants.intraday.active = :yes",
                "ExpressionAttributeNames": {"#version": "version", "#owner": "owner_user_id", "#identity": "identity"},
                "ExpressionAttributeValues": slots.serialize({":version": pool["version"], ":period": pool["period_id"], ":user": user, ":sid": session_id, ":yes": True})}})
        if old_account and old_account != account:
            check = {"TableName": "WalletLedgers", "Key": slots.serialize({"user_id": funding.partition(chosen, old_account), "ledger_id": funding.key(chosen, old_account)})}
            if old_pool:
                check.update(ConditionExpression="#version = :version", ExpressionAttributeNames={"#version": "version"},
                             ExpressionAttributeValues=slots.serialize({":version": old_pool["version"]}))
            else:
                check["ConditionExpression"] = "attribute_not_exists(ledger_id)"
            actions.append({"ConditionCheck": check})
        get_dynamodb_client().transact_write_items(TransactItems=actions)
    try:
        await asyncio.to_thread(write)
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("TransactionCanceledException", "ConditionalCheckFailedException"):
            raise
        raise HTTPException(409, "Session ownership or funding changed during repair; refresh and retry") from exc
    logger.info("Real session identity link repaired user_id=%s session_id=%s broker=%s", user, session_id, chosen)
    return {"repaired": True, "message": "Session link repaired. Use Reconcile with broker, then resume or close the existing book."}
