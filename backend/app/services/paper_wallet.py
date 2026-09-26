"""Authoritative date-scoped Paper funds and retry-safe ledger movements.

Paper must never use a process cache as spending authority. Operation receipts
share the ledger table; DynamoDB transactions commit each receipt and movement
together. A caller retrying an operation must reuse its operation id.
"""
from decimal import Decimal
import time
import uuid

from botocore.exceptions import ClientError
from fastapi import HTTPException

_ready_endpoints = set()


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


def move(user_id, date, delta, operation_id=None, allow_negative=False, order=None):
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
        serializer = TypeSerializer()
        encode = lambda values: {key: serializer.serialize(value) for key, value in values.items()}
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
        if order is not None:
            values = {key: Decimal(str(value)) if isinstance(value, float) else value
                      for key, value in order.model_dump(mode="json", exclude_none=True).items()}
            transactions.append({"Put": {"TableName": "Orders", "Item": encode(values)}})
        get_dynamodb_client().transact_write_items(TransactItems=transactions,
            ClientRequestToken=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{user_id}:{receipt}:{amount}")))
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


def finish_session_claim(user_id, date, symbol, token, session_id=None):
    try:
        values = {":token": token}
        expression = "REMOVE claim_token, claim_until"
        if session_id:
            expression = "SET session_id = :session, engine_token = :token, engine_until = :until " + expression
            values[":session"] = session_id
            values[":until"] = int(time.time()) + 45
        _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"},
            UpdateExpression=expression, ConditionExpression="claim_token = :token",
            ExpressionAttributeValues=values)
    except Exception as exc:
        _failure(exc)


def renew_engine(user_id, date, symbol, token, stop=False):
    try:
        _table().update_item(Key={"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"},
            UpdateExpression="SET engine_until = :until", ConditionExpression="engine_token = :token AND engine_until >= :now",
            ExpressionAttributeValues={":token": token, ":now": int(time.time()), ":until": 0 if stop else int(time.time()) + 45})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(status_code=409, detail="Paper session ownership changed; reattach") from exc
        _failure(exc)
    except Exception as exc:
        _failure(exc)
