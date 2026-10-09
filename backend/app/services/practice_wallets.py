"""Separate dated Paper and Replay/Stepwise funds; no legacy/Real seeding."""
from datetime import date as calendar_date, datetime
from decimal import Decimal
from math import isfinite
import logging
import time
from zoneinfo import ZoneInfo

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError
from fastapi import HTTPException

logger = logging.getLogger(__name__)


def kind_for(date, mode=None):
    calendar_date.fromisoformat(date)
    if mode is not None and not isinstance(mode, str):
        mode = None  # FastAPI Query defaults on internal/direct calls.
    if mode is None:
        return "paper" if date == datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat() else "sim"
    if mode not in ("paper", "sim", "replay", "stepwise"):
        raise ValueError("Practice wallet mode must be paper, replay or stepwise")
    return "paper" if mode == "paper" else "sim"


def table():
    from app.services.paper_wallet import _table
    return _table()


def storage_error(exc):
    logger.error("Dated practice wallet storage failed", exc_info=(type(exc), exc, exc.__traceback__))
    raise HTTPException(503, "Practice wallet storage unavailable; no balance update confirmed") from exc


def pages(source, method, **params):
    rows = []
    while True:
        response = getattr(source, method)(**params)
        rows.extend(response.get("Items", []))
        if not response.get("LastEvaluatedKey"):
            return rows
        params["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def previous_balance(db, user, date, kind):
    from app.services import wallet_service
    amount = Decimal(str(wallet_service.DEFAULT_BALANCE))
    params = dict(KeyConditionExpression=Key("user_id").eq(user) & Key("ledger_id").between(f"{kind}:0000", f"{kind}:{date}"),
        ConsistentRead=True, ScanIndexForward=False, Limit=50)
    while True:
        response = db.query(**params)
        prior = next((row for row in response.get("Items", [])
            if row.get("date", "") < date and row.get("ledger_id") == f"{kind}:{row.get('date')}"
            and "current_balance" in row), None)
        if prior:
            return prior["current_balance"]
        if not response.get("LastEvaluatedKey"):
            return amount
        params["ExclusiveStartKey"] = response["LastEvaluatedKey"]


def read(user, date, kind):
    """Existing date wins. Only an earlier wallet of the same kind can seed it."""
    from app.services import wallet_service
    try:
        db = table()
        key = {"user_id": user, "ledger_id": f"{kind}:{date}"}
        item = db.get_item(Key=key, ConsistentRead=True).get("Item")
        if item is None:
            amount = previous_balance(db, user, date, kind)
            try:
                db.put_item(Item={**key, "date": date, "ledger_kind": kind, "current_balance": amount,
                    "initial_balance": amount, "activity_revision": 0}, ConditionExpression="attribute_not_exists(user_id)")
            except ClientError as exc:
                if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                    raise
            item = db.get_item(Key=key, ConsistentRead=True)["Item"]
        wallet_service._ledgers[(user, f"{kind}:{date}")] = float(item["current_balance"])
        return item
    except HTTPException:
        raise
    except Exception as exc:
        storage_error(exc)


def claims(user, date):
    return pages(table(), "query", KeyConditionExpression=Key("user_id").eq(user) & Key("ledger_id").begins_with(f"paper:{date}:session:"), ConsistentRead=True)


def blocked(user, date, kind):
    """Consult live state and persistent records, including other workers/windows."""
    from app.services import simulation
    types = ("paper",) if kind == "paper" else ("sim", "stepwise")
    for session in simulation._sessions.values():
        if session.user_id == user and session.date == date and session.session_type in types and session.state != simulation.SimulationState.ENDED:
            return "Wallet cannot be updated while a session for this wallet/date is active or starting"
    try:
        paper_claims = claims(user, date) if kind == "paper" else []
        if kind == "paper":
            now = int(time.time())
            if any(row.get("session_status") == "running" or row.get("cleanup_pending") or row.get("settlement_pending")
                   or int(row.get("claim_until") or 0) >= now or int(row.get("engine_until") or 0) >= now for row in paper_claims):
                return "Paper session is active, starting, or waiting for Stop cleanup/settlement"
        from app.services.db import get_dynamodb_resource
        resource = get_dynamodb_resource()
        # Consistent base-table reads avoid the eventually consistent user GSI.
        for name in ("Sessions", "Orders"):
            try:
                rows = pages(resource.Table(name), "scan", ConsistentRead=True,
                    FilterExpression=Attr("user_id").eq(user))
            except ClientError as exc:
                if exc.response["Error"]["Code"] == "ResourceNotFoundException":
                    continue
                raise
            for row in rows:
                if name == "Sessions":
                    if row.get("date") == date and row.get("session_type") in types and row.get("state") not in ("ended", "stopped"):
                        closed_claim = kind == "paper" and any(claim.get("desktop_owned") and claim.get("session_id") == row.get("session_id") and claim.get("session_status") in ("stopped", "settled") for claim in paper_claims)
                        if not closed_claim:
                            return "A saved session for this wallet/date is still active or starting; stop it first"
                elif row.get("wallet_ledger_id") == f"{kind}:{date}" and row.get("status") == "PENDING":
                    return "Wallet update is waiting for pending orders/refunds to finish"
        return None
    except HTTPException:
        raise
    except Exception as exc:
        storage_error(exc)


def begin_start(user, date):
    """Revision handoff makes a Replay start and reset mutually exclusive."""
    read(user, date, "sim")
    try:
        record = table().update_item(Key={"user_id": user, "ledger_id": f"sim:{date}"},
            UpdateExpression="ADD activity_revision :one", ExpressionAttributeValues={":one": 1},
            ReturnValues="ALL_NEW")["Attributes"]
        # A reset can complete between initialization and this revision claim.
        from app.services import wallet_service
        wallet_service._ledgers[(user, f"sim:{date}")] = float(record["current_balance"])
        return int(record["activity_revision"])
    except Exception as exc:
        storage_error(exc)


def confirm_start(user, date, revision):
    # The provisional session must already be durably visible before this CAS.
    try:
        table().update_item(Key={"user_id": user, "ledger_id": f"sim:{date}"},
            UpdateExpression="ADD activity_revision :one", ConditionExpression="activity_revision = :revision",
            ExpressionAttributeValues={":one": 1, ":revision": revision})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(409, "Wallet changed during startup; retry with the latest dated balance") from exc
        storage_error(exc)
    except Exception as exc:
        storage_error(exc)


def reset(user, date, kind, amount):
    from app.services import wallet_service
    if not isfinite(amount) or amount <= 0:
        raise HTTPException(422, "Wallet amount must be positive and finite")
    record = read(user, date, kind)
    reason = blocked(user, date, kind)
    if reason:
        raise HTTPException(409, reason)
    try:
        from app.services.db import get_dynamodb_client
        from boto3.dynamodb.types import TypeSerializer
        encode = lambda row: {key: TypeSerializer().serialize(value) for key, value in row.items()}
        revision = int(record.get("activity_revision") or 0)
        value = Decimal(str(round(amount, 2)))
        tx = [{"Update": {"TableName": "WalletLedgers", "Key": encode({"user_id": user, "ledger_id": f"{kind}:{date}"}),
            "UpdateExpression": "SET current_balance = :amount, initial_balance = :amount, reset_at = :now, activity_revision = :next",
            "ConditionExpression": "activity_revision = :old OR (attribute_not_exists(activity_revision) AND :old = :zero)",
            "ExpressionAttributeValues": encode({":amount": value, ":now": int(time.time() * 1000), ":old": revision, ":zero": 0, ":next": revision + 1})}}]
        if kind == "paper":
            from app.config import SUPPORTED_SYMBOLS
            symbols = set(SUPPORTED_SYMBOLS) | {row["ledger_id"].split(":session:", 1)[1] for row in claims(user, date)}
            for symbol in symbols:
                # Clearing expired start tokens also fences a late startup that
                # otherwise could resume after a successful reset with old funds.
                tx.append({"Update": {"TableName": "WalletLedgers", "Key": encode({"user_id": user, "ledger_id": f"paper:{date}:session:{symbol}"}),
                    "UpdateExpression": "REMOVE claim_token, claim_until",
                    "ConditionExpression": "(attribute_not_exists(claim_until) OR claim_until < :now) AND (attribute_not_exists(engine_until) OR engine_until < :now) AND (attribute_not_exists(session_status) OR session_status <> :running) AND (attribute_not_exists(cleanup_pending) OR cleanup_pending = :false) AND (attribute_not_exists(settlement_pending) OR settlement_pending = :false)",
                    "ExpressionAttributeValues": encode({":now": int(time.time()), ":running": "running", ":false": False})}})
        get_dynamodb_client().transact_write_items(TransactItems=tx)
        wallet_service._ledgers[(user, f"{kind}:{date}")] = float(value)
        return float(value)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            raise HTTPException(409, "Wallet/session changed during reset; refresh and retry after Stop cleanup") from exc
        storage_error(exc)
    except HTTPException:
        raise
    except Exception as exc:
        storage_error(exc)
