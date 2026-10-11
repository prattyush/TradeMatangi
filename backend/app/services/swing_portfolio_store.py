"""Owned, persistent Swing portfolio metadata in Sessions and WalletLedgers."""

from datetime import datetime
from zoneinfo import ZoneInfo
import time
import uuid
from botocore.exceptions import ClientError
from fastapi import HTTPException
from app.services.swing_funding_store import encode, decode
from app.services.swing_accounting import money


def _sessions():
    from app.services.db import get_dynamodb_resource

    return get_dynamodb_resource().Table("Sessions")


def _ledgers():
    from app.services.swing_funding_store import _table

    return _table()


def owned(user, portfolio_id):
    row = (
        _sessions()
        .get_item(Key={"session_id": portfolio_id}, ConsistentRead=True)
        .get("Item")
    )
    if (
        not row
        or row.get("record_type") != "swing_portfolio"
        or row.get("user_id") != user
    ):
        raise HTTPException(404, "Swing portfolio not found")
    return decode(row)


def active(user, mode):
    row = (
        _ledgers()
        .get_item(
            Key={"user_id": user, "ledger_id": f"swing-active:{mode}"},
            ConsistentRead=True,
        )
        .get("Item")
    )
    return (
        owned(user, row["portfolio_id"])
        if row and row.get("state") != "ended"
        else None
    )


def create(user, mode, capital, *, broker=None, account=None, loss_limit_pct=None):
    from app.services.db import get_dynamodb_client
    from boto3.dynamodb.types import TypeSerializer

    capital = money(capital)
    if mode not in ("paper", "real", "replay") or capital <= 0:
        raise ValueError("A supported mode and positive capital are required")
    if mode == "real" and (not broker or not account):
        raise ValueError("Real Swing requires pinned broker/account identity")
    portfolio_id = str(uuid.uuid4())
    row = {
        "session_id": portfolio_id,
        "user_id": user,
        "record_type": "swing_portfolio",
        "session_type": "portfolio",
        "mode": mode,
        "trading_style": "swing",
        "state": "running",
        "date": datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat(),
        "session_capital": capital,
        "starting_capital": capital,
        "contexts": {},
        "entries_paused": False,
        "guardrail_epoch": 0,
        "guardrail_start_pnl": 0,
        "loss_limit_pct": loss_limit_pct,
        "version": 0,
        "execution_broker": broker,
        "broker_account_id": account,
        "created_at": int(time.time() * 1000),
    }
    serialize = lambda value: {
        k: TypeSerializer().serialize(v) for k, v in encode(value).items()
    }
    tx = [
        {
            "Put": {
                "TableName": "Sessions",
                "Item": serialize(row),
                "ConditionExpression": "attribute_not_exists(session_id)",
            }
        },
        {
            "Put": {
                "TableName": "WalletLedgers",
                "Item": serialize(
                    {
                        "user_id": user,
                        "ledger_id": f"swing-active:{mode}",
                        "portfolio_id": portfolio_id,
                        "state": "running",
                    }
                ),
                "ConditionExpression": "attribute_not_exists(portfolio_id) OR #state = :ended",
                "ExpressionAttributeNames": {"#state": "state"},
                "ExpressionAttributeValues": serialize({":ended": "ended"}),
            }
        },
    ]
    if mode != "real":
        tx.append(
            {
                "Put": {
                    "TableName": "WalletLedgers",
                    "Item": serialize(
                        {
                            "user_id": user,
                            "ledger_id": f"swing:{portfolio_id}",
                            "initial_balance": capital,
                            "current_balance": capital,
                            "ledger_kind": "swing_paper",
                            "version": 0,
                        }
                    ),
                    "ConditionExpression": "attribute_not_exists(ledger_id)",
                }
            }
        )
    try:
        get_dynamodb_client().transact_write_items(TransactItems=tx)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            raise HTTPException(
                409,
                "A Swing portfolio already exists; attach or close it before creating another",
            ) from exc
        raise
    return row


def update(user, portfolio_id, changes, version):
    row = owned(user, portfolio_id)
    if row["version"] != version:
        raise HTTPException(409, "Portfolio changed; refresh before retrying")
    protected = {
        "session_id",
        "user_id",
        "record_type",
        "session_type",
        "mode",
        "trading_style",
        "date",
        "starting_capital",
        "execution_broker",
        "broker_account_id",
        "version",
        "created_at",
    }
    if protected.intersection(changes):
        raise ValueError("Portfolio identity and capture evidence are immutable")
    row.update(changes)
    row["version"] = version + 1
    row["updated_at"] = int(time.time() * 1000)
    try:
        _sessions().put_item(
            Item=encode(row),
            ConditionExpression="#version = :old AND user_id = :user",
            ExpressionAttributeNames={"#version": "version"},
            ExpressionAttributeValues={":old": version, ":user": user},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(
                409, "Portfolio changed; refresh before retrying"
            ) from exc
        raise
    return row


def pause_entries(user, portfolio_id, paused):
    row = owned(user, portfolio_id)
    if row["state"] in ("closing", "ended"):
        raise HTTPException(409, "Closing or ended portfolios cannot resume entries")
    return update(user, portfolio_id, {"entries_paused": bool(paused)}, row["version"])


def reset_guardrail_reference(user, portfolio_id, capital, current_pnl):
    capital, current_pnl = money(capital), money(current_pnl)
    if capital <= 0:
        raise ValueError("Capital must be positive")
    row = owned(user, portfolio_id)
    if row["state"] in ("closing", "ended"):
        raise HTTPException(409, "Cannot reset capital while closing a portfolio")
    return update(
        user,
        portfolio_id,
        {
            "session_capital": capital,
            "guardrail_start_pnl": current_pnl,
            "guardrail_epoch": row["guardrail_epoch"] + 1,
            "guardrail_ban": False,
        },
        row["version"],
    )


def finish_verified_close(user, portfolio_id):
    """Runtime calls this only after confirming its managed book has no exposure."""
    from app.services.db import get_dynamodb_client
    from boto3.dynamodb.types import TypeSerializer

    row = owned(user, portfolio_id)
    if row["state"] == "ended":
        return row
    if row["state"] != "closing":
        raise HTTPException(409, "Portfolio closure was not requested")
    version = row["version"]
    row["version"] += 1
    row["state"] = "ended"
    serialize = lambda value: {
        k: TypeSerializer().serialize(v) for k, v in encode(value).items()
    }
    try:
        get_dynamodb_client().transact_write_items(
            TransactItems=[
                {
                    "Put": {
                        "TableName": "Sessions",
                        "Item": serialize(row),
                        "ConditionExpression": "#version = :old AND user_id = :user",
                        "ExpressionAttributeNames": {"#version": "version"},
                        "ExpressionAttributeValues": serialize(
                            {":old": version, ":user": user}
                        ),
                    }
                },
                {
                    "Update": {
                        "TableName": "WalletLedgers",
                        "Key": serialize(
                            {
                                "user_id": user,
                                "ledger_id": f"swing-active:{row['mode']}",
                            }
                        ),
                        "UpdateExpression": "SET #state = :ended",
                        "ConditionExpression": "portfolio_id = :pid",
                        "ExpressionAttributeNames": {"#state": "state"},
                        "ExpressionAttributeValues": serialize(
                            {":ended": "ended", ":pid": portfolio_id}
                        ),
                    }
                },
            ]
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            raise HTTPException(
                409, "Portfolio changed during closure; verify again"
            ) from exc
        raise
    return row
