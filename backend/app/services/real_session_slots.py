"""Durable Real book ownership; execution leases never release a trading book."""

import time

from boto3.dynamodb.conditions import Key
from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError
from fastapi import HTTPException

from app.services.swing_funding_store import decode, encode

STYLES = ("intraday", "swing")
DAY_HEARTBEAT_SECONDS = 180
DAY_LEASE_SECONDS = 900
DAY_LOCAL_AUTHORITY_SECONDS = DAY_LEASE_SECONDS - 10


def lease_seconds(style):
    return DAY_LEASE_SECONDS if style == "intraday" else 45


def key(broker, account, style):
    from app.services.execution_broker import name

    if not isinstance(account, str) or not account or style not in STYLES:
        raise ValueError("A broker account and Day/Swing style are required")
    return {
        "user_id": "real-session-slots",
        "ledger_id": f"{name(broker)}:{style}",
    }


def table():
    from app.services.swing_funding_store import _table

    return _table()


def serialize(row):
    return {k: TypeSerializer().serialize(v) for k, v in encode(row).items()}


def read(broker, account, style):
    row = (
        table()
        .get_item(Key=key(broker, account, style), ConsistentRead=True)
        .get("Item")
    )
    return decode(row) if row and row.get("state") != "closed" else None


def for_user(user):
    # There are exactly four canonical rows for the two configured brokers.
    page = table().query(
        KeyConditionExpression=Key("user_id").eq("real-session-slots"),
        ConsistentRead=True,
    )
    return [
        decode(row)
        for row in page.get("Items", [])
        if row.get("state") != "closed" and row.get("owner_user_id") == user
    ]


def sibling_account_check(broker, account, style):
    sibling = "swing" if style == "intraday" else "intraday"
    return {
        "ConditionCheck": {
            "TableName": "WalletLedgers",
            "Key": serialize(key(broker, account, sibling)),
            "ConditionExpression": "attribute_not_exists(ledger_id) OR #state = :closed OR (#account = :account AND (attribute_not_exists(recovery_conflict) OR recovery_conflict = :no))",
            "ExpressionAttributeNames": {"#state": "state", "#account": "account"},
            "ExpressionAttributeValues": serialize(
                {":closed": "closed", ":account": account, ":no": False}
            ),
        }
    }


def claim(user, broker, account, style, session_id, token, *, record=None):
    """Create a book, or reacquire its expired engine; never take another book."""
    from app.services.db import get_dynamodb_client
    from app.services.execution_broker import name

    if not all(isinstance(value, str) and value for value in (user, session_id, token)):
        raise ValueError(
            "Real ownership requires user, session and operation identities"
        )
    if record is not None and (
        record.get("session_id") != session_id
        or record.get("user_id") != user
        or record.get("broker_account_id") != account
        or name(record.get("execution_broker")) != name(broker)
    ):
        raise ValueError("Saved preparation differs from its Real slot identity")
    now = int(time.time())
    current = read(broker, account, style)
    if current:
        if current["account"] != account:
            raise HTTPException(
                409,
                "Broker account changed; restore the original account and close its outstanding book first",
            )
        if current.get("recovery_conflict"):
            raise HTTPException(
                409,
                "Conflicting legacy Real books require reconciliation before recovery",
            )
        if current["owner_user_id"] != user or current["session_id"] != session_id:
            raise HTTPException(
                409,
                f"{name(broker).title()} {'Day' if style == 'intraday' else 'Swing'} already has an outstanding Real session",
            )
        if current.get("engine_until", 0) >= now:
            raise HTTPException(
                409,
                "The existing Real engine is still active; attach or retry recovery after its lease expires",
            )
        if style == "intraday":
            legacy = (
                table()
                .get_item(
                    Key={"user_id": user, "ledger_id": "real-active"},
                    ConsistentRead=True,
                )
                .get("Item", {})
            )
            if (
                legacy.get("session_id") == session_id
                and legacy.get("state") != "closed"
                and legacy.get("engine_until", 0) >= now
            ):
                raise HTTPException(
                    409,
                    "The legacy Real engine is still active; recovery waits for it to stop",
                )
    row = {
        **key(broker, account, style),
        "broker": name(broker),
        "account": account,
        "style": style,
        "owner_user_id": user,
        "session_id": session_id,
        "operation_id": token,
        "trading_date": (record or {}).get("date") or (current or {}).get("trading_date"),
        "opened_at": (current or {}).get("opened_at", now),
        "updated_at": now,
        "engine_until": now + lease_seconds(style),
        **({"last_client_seen_at": current["last_client_seen_at"]} if current and "last_client_seen_at" in current else {}),
        **({k: current[k] for k in ("handoff_token", "handoff_started_at") if k in current} if current else {}),
        "state": current["state"] if current else "starting",
    }
    condition = "attribute_not_exists(ledger_id) OR #state = :closed"
    values = {":closed": "closed"}
    if current:
        condition = "owner_user_id = :owner AND session_id = :sid AND operation_id = :old AND engine_until < :now AND #state <> :closed"
        values.update(
            {
                ":owner": user,
                ":sid": session_id,
                ":old": current["operation_id"],
                ":now": now,
            }
        )
    tx = [
        {
            "Put": {
                "TableName": "WalletLedgers",
                "Item": serialize(row),
                "ConditionExpression": condition,
                "ExpressionAttributeNames": {"#state": "state"},
                "ExpressionAttributeValues": serialize(values),
            }
        },
        sibling_account_check(broker, account, style),
    ]
    if record is not None:
        tx.append(
            {
                "Put": {
                    "TableName": "Sessions",
                    "Item": serialize(record),
                    "ConditionExpression": "attribute_not_exists(session_id)",
                }
            }
        )
    try:
        get_dynamodb_client().transact_write_items(TransactItems=tx)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            raise HTTPException(
                409,
                "Real session ownership changed; refresh and attach to the outstanding book",
            ) from exc
        raise
    return row


def update(broker, account, style, user, session_id, token, *, state=None):
    changes = "SET engine_until = :until, updated_at = :now"
    values = {
        ":until": int(time.time()) + lease_seconds(style),
        ":now": int(time.time()),
        ":owner": user,
        ":sid": session_id,
        ":token": token,
        ":closed": "closed",
        ":account": account,
    }
    if state:
        changes += ", #state = :state"
        values[":state"] = state
    table().update_item(
        Key=key(broker, account, style),
        UpdateExpression=changes,
        ConditionExpression="owner_user_id = :owner AND session_id = :sid AND operation_id = :token AND #state <> :closed AND #account = :account" + (" AND engine_until > :now" if style == "intraday" else ""),
        ExpressionAttributeNames={"#state": "state", "#account": "account"},
        ExpressionAttributeValues=encode(values),
    )


def close_action(user, broker, account, style, session_id, token):
    return {
        "Update": {
            "TableName": "WalletLedgers",
            "Key": serialize(key(broker, account, style)),
            "UpdateExpression": "SET #state = :closed, engine_until = :zero, closed_at = :now, updated_at = :now",
            "ConditionExpression": "owner_user_id = :owner AND session_id = :sid AND operation_id = :token AND #account = :account",
            "ExpressionAttributeNames": {"#state": "state", "#account": "account"},
            "ExpressionAttributeValues": serialize(
                {
                    ":closed": "closed",
                    ":zero": 0,
                    ":now": int(time.time()),
                    ":owner": user,
                    ":sid": session_id,
                    ":token": token,
                    ":account": account,
                }
            ),
        }
    }


def adopt(user, record, *, token=None, engine_until=0, _attempt=0):
    """Cutover only: preserve legacy identity without expiring logical ownership."""
    from app.services.db import get_dynamodb_client
    from app.services.execution_broker import name

    if record.get("real_verified_closed"):
        return None
    if _attempt >= 4:
        raise HTTPException(
            409, "Real legacy ownership changed repeatedly; retry recovery"
        )
    broker = name(record.get("execution_broker"))
    account = record.get("broker_account_id") or record.get("_fifo_account")
    style = record.get("trading_style", "intraday")
    unresolved = not isinstance(account, str) or not account
    key_account = "unresolved-account" if unresolved else account
    sid = record["session_id"]
    existing = read(broker, key_account, style)
    if existing:
        if existing["owner_user_id"] != user or existing["session_id"] != sid:
            table().update_item(
                Key=key(broker, key_account, style),
                UpdateExpression="SET recovery_conflict = :yes",
                ExpressionAttributeValues={":yes": True},
            )
            raise HTTPException(
                409,
                "Legacy Real books conflict for this broker/style; no book was discarded",
            )
        if existing.get("unbound_account") and not unresolved:
            table().update_item(
                Key=key(broker, account, style),
                UpdateExpression="SET #account = :account, unbound_account = :no, #state = :state",
                ConditionExpression="owner_user_id = :owner AND session_id = :sid AND unbound_account = :yes",
                ExpressionAttributeNames={"#account": "account", "#state": "state"},
                ExpressionAttributeValues={
                    ":account": account,
                    ":no": False,
                    ":yes": True,
                    ":owner": user,
                    ":sid": sid,
                    ":state": "closing" if record.get("real_closing") else "running",
                },
            )
            return read(broker, account, style)
        return existing
    row = {
        **key(broker, key_account, style),
        "broker": broker,
        "account": account,
        "style": style,
        "owner_user_id": user,
        "session_id": sid,
        "operation_id": token or f"legacy:{sid}",
        "engine_until": engine_until,
        "trading_date": record.get("date"),
        "opened_at": int(time.time()),
        "updated_at": int(time.time()),
        "unbound_account": unresolved,
        "state": "recovery_required"
        if unresolved
        else "closing"
        if record.get("real_closing") or record.get("state") == "closing"
        else "running",
    }
    try:
        actions = [
            {
                "Put": {
                    "TableName": "WalletLedgers",
                    "Item": serialize(row),
                    "ConditionExpression": "attribute_not_exists(ledger_id) OR #state = :closed",
                    "ExpressionAttributeNames": {"#state": "state"},
                    "ExpressionAttributeValues": serialize({":closed": "closed"}),
                }
            },
        ]
        # Cutover records must stay visible even when their account is missing.
        # New starts use the sibling fence; adoption never sends broker commands.
        if style == "swing":
            actions.append(
                {
                    "Put": {
                        "TableName": "WalletLedgers",
                        "Item": serialize(
                            {
                                "user_id": user,
                                "ledger_id": f"swing-active:real:{broker}",
                                "portfolio_id": sid,
                                "state": row["state"],
                            }
                        ),
                        "ConditionExpression": "attribute_not_exists(portfolio_id) OR portfolio_id = :sid OR #state = :ended",
                        "ExpressionAttributeNames": {"#state": "state"},
                        "ExpressionAttributeValues": serialize(
                            {":sid": sid, ":ended": "ended"}
                        ),
                    }
                }
            )
        get_dynamodb_client().transact_write_items(TransactItems=actions)
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "TransactionCanceledException":
            return adopt(
                user,
                record,
                token=token,
                engine_until=engine_until,
                _attempt=_attempt + 1,
            )
        raise
    return row


def fenced_put(session, table_name, item):
    """Fence durable child evidence to the existing parent/book engine identity."""
    from app.services.db import get_dynamodb_client

    from app.services.real_broker_policy import enforce
    if not enforce(session):
        get_dynamodb_client().put_item(TableName=table_name, Item=serialize(item))
        return
    identity = (
        session.portfolio_id if session.trading_style == "swing" else session.session_id
    )
    get_dynamodb_client().transact_write_items(
        TransactItems=[
            {
                "ConditionCheck": {
                    "TableName": "WalletLedgers",
                    "Key": serialize(
                        key(
                            session.execution_broker,
                            session.broker_account_id,
                            session.trading_style,
                        )
                    ),
                    "ConditionExpression": "owner_user_id = :owner AND session_id = :sid AND operation_id = :token AND #account = :account AND engine_until >= :now AND #state <> :closed",
                    "ExpressionAttributeNames": {
                        "#state": "state",
                        "#account": "account",
                    },
                    "ExpressionAttributeValues": serialize(
                        {
                            ":owner": session.user_id,
                            ":sid": identity,
                            ":token": session.real_claim_token,
                            ":account": session.broker_account_id,
                            ":now": int(time.time()),
                            ":closed": "closed",
                        }
                    ),
                }
            },
            {"Put": {"TableName": table_name, "Item": serialize(item)}},
        ]
    )


def client_heartbeat(broker, account, user, session_id):
    """Presence is an acknowledgement from a client, independent of engine health."""
    now = int(time.time())
    table().update_item(
        Key=key(broker, account, "intraday"),
        UpdateExpression="SET last_client_seen_at = :now",
        ConditionExpression="owner_user_id = :owner AND session_id = :sid AND #account = :account AND #state <> :closed AND attribute_not_exists(handoff_token)",
        ExpressionAttributeNames={"#account": "account", "#state": "state"},
        ExpressionAttributeValues=encode({":now": now, ":owner": user, ":sid": session_id,
                                         ":account": account, ":closed": "closed"}),
    )
    return {"session_id": session_id, "last_client_seen_at": now}
