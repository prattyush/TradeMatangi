"""Authoritative date-scoped Paper funds and retry-safe ledger movements.

Paper must never use a process cache as spending authority. Operation receipts
share the ledger table; DynamoDB transactions commit each receipt and movement
together. A caller retrying an operation must reuse its operation id.
"""
from decimal import Decimal
import logging
import time
import uuid

from botocore.exceptions import ClientError
from fastapi import HTTPException

_ready_endpoints = set()
logger = logging.getLogger(__name__)


def _table():
    from app.services.db import get_dynamodb_resource
    from app.services.wallet_service import _ensure_ledger_table
    resource = get_dynamodb_resource()
    endpoint = resource.meta.client.meta.endpoint_url
    if endpoint not in _ready_endpoints:
        _ensure_ledger_table()
        _ready_endpoints.add(endpoint)
    return resource.Table("WalletLedgers")


def _failure(exc):
    _ready_endpoints.clear()
    logger.error("Paper wallet storage operation could not be confirmed", exc_info=(type(exc), exc, exc.__traceback__))
    raise HTTPException(status_code=503, detail="Paper wallet storage unavailable; retry without changing the operation identity") from exc


def read(user_id, date):
    try:
        table = _table()
        key = {"user_id": user_id, "ledger_id": f"paper:{date}"}
        item = table.get_item(Key=key, ConsistentRead=True).get("Item")
        if item is None:
            from app.services.wallet_service import get_or_init_wallet
            amount = Decimal(str(round(get_or_init_wallet(user_id, date), 2)))
            try:
                table.put_item(Item={**key, "date": date, "ledger_kind": "paper", "current_balance": amount},
                               ConditionExpression="attribute_not_exists(user_id)")
            except ClientError as exc:
                if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    raise
            item = table.get_item(Key=key, ConsistentRead=True)["Item"]
        return item
    except HTTPException:
        raise
    except Exception as exc:
        _failure(exc)


def balance(user_id, date):
    return float(read(user_id, date)["current_balance"])


def fill_recorded(user_id, date, order_id):
    return bool(_table().get_item(Key={"user_id": user_id,
        "ledger_id": f"paper:{date}:op:fill:{order_id}"}, ConsistentRead=True).get("Item"))


def locked(user_id, date):
    return bool(read(user_id, date).get("started_at"))


def lock(user_id, date):
    read(user_id, date)
    try:
        _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}"},
            UpdateExpression="SET started_at = if_not_exists(started_at, :now)",
            ExpressionAttributeValues={":now": int(time.time() * 1000)})
    except Exception as exc:
        _failure(exc)


def reset(user_id, date, amount):
    read(user_id, date)
    try:
        result = _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}"},
            UpdateExpression="SET current_balance = :balance",
            ConditionExpression="attribute_not_exists(started_at)",
            ExpressionAttributeValues={":balance": Decimal(str(round(amount, 2)))}, ReturnValues="ALL_NEW")
        return float(result["Attributes"]["current_balance"])
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(status_code=409, detail="Paper wallet is locked after the first session starts") from exc
        _failure(exc)
    except Exception as exc:
        _failure(exc)


def move(user_id, date, delta, operation_id=None, allow_negative=False, order=None, engine=None, cleanup=None):
    read(user_id, date)
    operation_id = operation_id or str(uuid.uuid4())
    ledger = f"paper:{date}"
    receipt = f"{ledger}:op:{operation_id}"
    amount = Decimal(str(round(delta, 2)))
    try:
        table = _table()
        existing = table.get_item(Key={"user_id": user_id, "ledger_id": receipt}, ConsistentRead=True).get("Item")
        if existing:
            if existing["delta"] != amount:
                raise HTTPException(status_code=409, detail="Wallet operation identity reused with a different amount")
            return balance(user_id, date)
        from app.services.db import get_dynamodb_client
        from boto3.dynamodb.types import TypeSerializer
        from app.services.real_broker_state import encode as dynamodb_safe
        serializer = TypeSerializer()
        encode = lambda values: {key: serializer.serialize(dynamodb_safe(value)) for key, value in values.items()}
        update = {"TableName": "WalletLedgers", "Key": encode({"user_id": user_id, "ledger_id": ledger}),
                  "UpdateExpression": "ADD current_balance :delta",
                  "ExpressionAttributeValues": encode({":delta": amount})}
        if amount < 0 and not allow_negative:
            update["ConditionExpression"] = "current_balance >= :required"
            update["ExpressionAttributeValues"].update(encode({":required": -amount}))
        transactions = [
            {"Update": update},
            {"Put": {"TableName": "WalletLedgers", "Item": encode({"user_id": user_id, "ledger_id": receipt,
                "delta": amount}),
                "ConditionExpression": "attribute_not_exists(user_id)"}},
        ]
        if engine is not None:
            session_id, symbol, token = engine
            transactions.insert(0, {"ConditionCheck": {
                "TableName": "WalletLedgers",
                "Key": encode({"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"}),
                "ConditionExpression": "session_id = :session AND engine_token = :token AND engine_until >= :now AND session_status = :running",
                "ExpressionAttributeValues": encode({":session": session_id, ":token": token,
                    ":now": int(time.time()), ":running": "running"}),
            }})
        elif cleanup is not None:
            session_id, symbol = cleanup
            transactions.insert(0, {"ConditionCheck": {
                "TableName": "WalletLedgers",
                "Key": encode({"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"}),
                "ConditionExpression": "session_id = :session AND desktop_owned = :owned AND session_status = :stopped",
                "ExpressionAttributeValues": encode({":session": session_id, ":owned": True, ":stopped": "stopped"}),
            }})
        if order is not None:
            # Match ordinary order writes, including nested analytics/controller
            # numbers. JSON mode turns Decimals into strings and leaves nested
            # floats that boto3 rejects before the atomic reservation is sent.
            from app.services.order_service import _order_db_item
            values = _order_db_item(order)
            transactions.append({"Put": {"TableName": "Orders", "Item": encode(values)}})
        get_dynamodb_client().transact_write_items(TransactItems=transactions,
            ClientRequestToken=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{user_id}:{receipt}:{amount}:{engine}:{cleanup}")))
        return balance(user_id, date)
    except HTTPException:
        raise
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            existing = _table().get_item(Key={"user_id": user_id, "ledger_id": receipt}, ConsistentRead=True).get("Item")
            if existing and existing["delta"] == amount:
                return balance(user_id, date)
            current = balance(user_id, date)
            if amount < 0 and current < -float(amount) and not allow_negative:
                from app.services.wallet_service import InsufficientFundsError
                raise InsufficientFundsError(current, -float(amount)) from exc
            if engine is not None or cleanup is not None:
                raise HTTPException(status_code=409, detail="Paper engine ownership changed; refresh the session") from exc
        _failure(exc)
    except Exception as exc:
        _failure(exc)


def fenced_put(table_name, item, *, user_id, date, symbol, session_id, token=None, stopped=False):
    """Commit one desktop Paper item only while its engine or stopped parent owns it."""
    return fenced_put_many(table_name, [item], user_id=user_id, date=date,
        symbol=symbol, session_id=session_id, token=token, stopped=stopped)


def fenced_put_many(table_name, items, *, user_id, date, symbol, session_id, token=None, stopped=False):
    """Commit a group of related items under a single Paper ownership fence."""
    from app.services.db import get_dynamodb_client
    from boto3.dynamodb.types import TypeSerializer
    from app.services.real_broker_state import encode as dynamodb_safe
    serializer = TypeSerializer()
    encode = lambda values: {key: serializer.serialize(dynamodb_safe(value)) for key, value in values.items()}
    expression = "session_id = :session AND desktop_owned = :owned AND session_status = :status"
    values = {":session": session_id, ":owned": True, ":status": "stopped" if stopped else "running"}
    if not stopped:
        expression += " AND engine_token = :token AND engine_until >= :now"
        values.update({":token": token, ":now": int(time.time())})
    try:
        get_dynamodb_client().transact_write_items(TransactItems=[
            {"ConditionCheck": {"TableName": "WalletLedgers",
                "Key": encode({"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"}),
                "ConditionExpression": expression, "ExpressionAttributeValues": encode(values)}},
            *[{"Put": {"TableName": table_name, "Item": encode(item)}} for item in items],
        ])
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            raise HTTPException(status_code=409, detail="Paper session ownership changed; refresh") from exc
        _failure(exc)
    except Exception as exc:
        _failure(exc)


def claim_session(user_id, date, symbol):
    """Serialize Paper starts across workers; retain an authoritative session id."""
    read(user_id, date)
    token = str(uuid.uuid4())
    key = {"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"}
    try:
        result = _table().update_item(Key=key,
            UpdateExpression="SET claim_token = :token, claim_until = :until",
            ConditionExpression="(attribute_not_exists(claim_until) OR claim_until < :now) AND (attribute_not_exists(engine_until) OR engine_until < :now)",
            ExpressionAttributeValues={":token": token, ":until": int(time.time()) + 120, ":now": int(time.time())},
            ReturnValues="ALL_NEW")
        return token, result["Attributes"].get("session_id")
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(status_code=409, detail="A Paper start for this underlying is in progress; retry to attach") from exc
        _failure(exc)
    except Exception as exc:
        _failure(exc)


def session_claim(user_id, date, symbol):
    """Read the durable Paper identity and engine state, even on another worker."""
    try:
        return _table().get_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"},
            ConsistentRead=True).get("Item")
    except Exception as exc:
        _failure(exc)


def desktop_write_context(session_id, user_id, date, symbol):
    """Return (token, stopped) for desktop-owned records; None for website Paper."""
    from app.services import simulation
    active = simulation.get_session(session_id)
    if active and getattr(active, "desktop_origin", None) == "desktop_paper":
        return getattr(active, "paper_engine_token", None), False
    claim = session_claim(user_id, date, symbol)
    if not claim or claim.get("session_id") != session_id or not claim.get("desktop_owned"):
        return None
    if claim.get("session_status") == "stopped":
        return None, True
    raise HTTPException(status_code=409, detail="Paper engine is active on another worker")


def ensure_desktop_claim(user_id, date, symbol, session_id):
    """Adopt a desktop Paper record created before durable lifecycle fields existed."""
    current = session_claim(user_id, date, symbol)
    if current and current.get("desktop_owned"):
        return current
    if current and current.get("session_id") not in (None, session_id):
        raise HTTPException(status_code=409, detail="A different Paper session owns this underlying")
    now = int(time.time())
    running = bool(current and current.get("engine_token") and int(current.get("engine_until") or 0) >= now)
    key = {"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"}
    try:
        _table().update_item(Key=key,
            UpdateExpression="SET session_id = :session, desktop_owned = :owned, session_status = :status, "
                "cleanup_pending = :pending, engine_generation = if_not_exists(engine_generation, :zero)",
            ConditionExpression="(attribute_not_exists(session_id) OR session_id = :session) AND attribute_not_exists(desktop_owned)",
            ExpressionAttributeValues={":session": session_id, ":owned": True,
                ":status": "running" if running else "stopped", ":pending": not running, ":zero": 0})
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            _failure(exc)
    except Exception as exc:
        _failure(exc)
    return session_claim(user_id, date, symbol)


def stop_desktop_session(user_id, date, symbol, session_id, *, expected_generation=None):
    """Fence the engine first; stopping a previously stopped session is safe."""
    key = {"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"}
    try:
        current = session_claim(user_id, date, symbol)
        if current and current.get("session_id") == session_id and current.get("desktop_owned") and current.get("session_status") in ("stopped", "settled"):
            return current
        if expected_generation is not None and current and int(current.get("engine_generation") or 0) != expected_generation:
            raise HTTPException(status_code=409, detail="Paper engine changed since this Stop request; refresh the session")
        condition = "session_id = :session AND desktop_owned = :owned AND session_status = :running"
        values = {":session": session_id, ":owned": True, ":stopped": "stopped",
            ":running": "running", ":pending": True, ":zero": 0, ":one": 1, ":empty": ""}
        if expected_generation is not None:
            condition += " AND engine_generation = :expected"
            values[":expected"] = expected_generation
        result = _table().update_item(Key=key,
            UpdateExpression="SET session_status = :stopped, cleanup_pending = :pending, engine_until = :zero, engine_token = :empty, "
                "engine_generation = if_not_exists(engine_generation, :zero) + :one REMOVE claim_token, claim_until",
            ConditionExpression=condition, ExpressionAttributeValues=values,
            ReturnValues="ALL_NEW")
        return result["Attributes"]
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            record = session_claim(user_id, date, symbol)
            if record and record.get("session_id") == session_id and record.get("desktop_owned") and record.get("session_status") in ("stopped", "settled"):
                return record
            if expected_generation is not None and record and record.get("session_id") == session_id:
                raise HTTPException(status_code=409, detail="Paper engine changed since this Stop request; refresh the session") from exc
            raise HTTPException(status_code=404, detail="Desktop Paper session not found") from exc
        _failure(exc)
    except HTTPException:
        raise
    except Exception as exc:
        _failure(exc)


def complete_desktop_cleanup(user_id, date, symbol, session_id):
    try:
        _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"},
            UpdateExpression="SET cleanup_pending = :done",
            ConditionExpression="session_id = :session AND session_status = :stopped",
            ExpressionAttributeValues={":session": session_id, ":stopped": "stopped", ":done": False})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(status_code=409, detail="Paper session changed during cleanup") from exc
        _failure(exc)
    except Exception as exc:
        _failure(exc)


def settle_desktop_session(user_id, date, symbol, session_id):
    try:
        _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"},
            UpdateExpression="SET session_status = :settled, engine_until = :zero, engine_token = :empty",
            ConditionExpression="session_id = :session AND desktop_owned = :owned AND session_status = :stopped",
            ExpressionAttributeValues={":session": session_id, ":owned": True, ":stopped": "stopped",
                ":settled": "settled", ":zero": 0, ":empty": ""})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return
        _failure(exc)
    except Exception as exc:
        _failure(exc)


def finish_session_claim(user_id, date, symbol, token, session_id=None, *, desktop=False):
    try:
        values = {":token": token}
        expression = "REMOVE claim_token, claim_until"
        if session_id:
            expression = "SET session_id = :session, engine_token = :token, engine_until = :until " + expression
            values[":session"] = session_id
            values[":until"] = int(time.time()) + 45
            if desktop:
                expression = expression.replace("engine_until = :until", "engine_until = :until, session_status = :running, desktop_owned = :owned, engine_generation = if_not_exists(engine_generation, :zero) + :one")
                values.update({":running": "running", ":owned": True, ":zero": 0, ":one": 1})
        result = _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"},
            UpdateExpression=expression, ConditionExpression="claim_token = :token",
            ExpressionAttributeValues=values, ReturnValues="ALL_NEW")
        return result.get("Attributes")
    except Exception as exc:
        _failure(exc)


def renew_engine(user_id, date, symbol, token, stop=False):
    try:
        _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"},
            UpdateExpression="SET engine_until = :until", ConditionExpression="engine_token = :token AND engine_until >= :now AND (attribute_not_exists(desktop_owned) OR desktop_owned = :false OR session_status = :running)",
            ExpressionAttributeValues={":token": token, ":now": int(time.time()), ":until": 0 if stop else int(time.time()) + 45,
                ":false": False, ":running": "running"})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(status_code=409, detail="Paper session ownership changed; reattach") from exc
        _failure(exc)
    except Exception as exc:
        _failure(exc)
