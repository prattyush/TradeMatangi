"""Manual finalized Real charges, applied to analytics copies only."""

import hashlib
import logging
from collections import defaultdict
from datetime import UTC, datetime
from decimal import ROUND_DOWN, Decimal

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError
from fastapi import HTTPException

logger = logging.getLogger(__name__)
PREFIX = "analytics-real-fees:"


def table():
    from app.services.db import get_dynamodb_resource

    return get_dynamodb_resource().Table("WalletLedgers")


def legacy_key(user, date, account):
    return {
        "user_id": user,
        "ledger_id": PREFIX + date + ":" + hashlib.sha256(account.encode()).hexdigest(),
    }


def key(user, date, account, broker="kotak"):
    from app.services.execution_broker import name

    return {
        "user_id": user,
        "ledger_id": PREFIX
        + date
        + ":"
        + name(broker)
        + ":"
        + hashlib.sha256(account.encode()).hexdigest(),
    }


def order_key(row):
    return hashlib.sha256(
        f"{row.get('broker_exchange') or row.get('exchange') or ''}:{row.get('broker_order_id') or row.get('kotak_order_id') or row.get('trade_id')}".encode()
    ).hexdigest()


def read(user, date, account, broker="kotak"):
    try:
        from app.services.execution_broker import name

        saved = (
            table()
            .get_item(Key=key(user, date, account, broker), ConsistentRead=True)
            .get("Item")
        )
        if saved is None and name(broker) == "kotak":
            saved = (
                table()
                .get_item(Key=legacy_key(user, date, account), ConsistentRead=True)
                .get("Item")
            )
        return saved
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ResourceNotFoundException":
            return None
        raise


def grouped(rows):
    result = defaultdict(list)
    for row in rows:
        account = row.get("broker_account_id")
        if account and (
            row.get("broker_order_id")
            or row.get("kotak_order_id")
            or row.get("trade_id")
        ):
            from app.services.execution_broker import name

            result[(name(row.get("execution_broker")), str(account))].append(row)
    return result


def totals(rows):
    result = {}
    for row in rows:
        item = result.setdefault(
            order_key(row),
            {"quantity": 0, "value": Decimal(0), "estimated": Decimal(0)},
        )
        item["quantity"] += int(row["quantity"])
        item["value"] += Decimal(str(row["price"])) * int(row["quantity"])
        item["estimated"] += Decimal(str(row.get("commission", 0)))
    return result


def day_accounts(user, date):
    from app.services.db import get_dynamodb_resource
    from app.services.performance_service import load_session_cycles, query_all

    sessions = query_all(
        get_dynamodb_resource().Table("Sessions"),
        IndexName="UserIdIndex",
        KeyConditionExpression=Key("user_id").eq(user),
        FilterExpression=Attr("date").eq(date) & Attr("session_type").eq("real"),
    )
    accounts, owners = defaultdict(list), set()
    for session in sessions:
        if session.get("trading_style", "intraday") != "intraday":
            continue
        sid = session["session_id"]
        owner = session.get("broker_projection_id") or sid
        if (
            session.get("user_id") != user
            or session.get("broker_projection_owner", sid) != sid
            or ":archive:" in sid
            or owner in owners
        ):
            continue
        owners.add(owner)
        for cycle in load_session_cycles(
            session, include_labels=False, apply_fee_correction=False
        ):
            executions = [
                {
                    **row,
                    "execution_broker": row.get("execution_broker")
                    or session.get("execution_broker")
                    or "kotak",
                }
                for row in cycle["executions"]
            ]
            for account, rows in grouped(executions).items():
                accounts[account].extend(rows)
    return {account: totals(rows) for account, rows in accounts.items()}


def overview(user, date):
    accounts = []
    for (broker, account), orders in day_accounts(user, date).items():
        saved = read(user, date, account, broker)
        previous = saved.get("orders", {}) if saved else {}
        changed = bool(
            saved
            and (
                set(previous) != set(orders)
                or any(
                    int(previous[k]["quantity"]) != item["quantity"]
                    or abs(float(previous[k]["value"] - item["value"])) > 0.0001
                    for k, item in orders.items()
                    if k in previous
                )
            )
        )
        accounts.append(
            {
                "account_id": account,
                "execution_broker": broker,
                "order_count": len(orders),
                "estimated_total": float(
                    sum(item["estimated"] for item in orders.values())
                ),
                "actual_total": float(saved["actual_total"]) if saved else None,
                "updated_at": saved.get("updated_at") if saved else None,
                "history_changed": changed,
            }
        )
    return {"date": date, "accounts": accounts}


def save(user, date, account, amount, broker="kotak"):
    from app.services.execution_broker import name

    broker = name(broker)
    orders = day_accounts(user, date).get((broker, account))
    if not orders:
        raise HTTPException(404, "No owned Real trades with this broker account/date")
    amount = Decimal(str(amount))
    if (
        not amount.is_finite()
        or amount < 0
        or amount != amount.quantize(Decimal(".01"))
    ):
        raise HTTPException(
            422, "Actual charges must be a nonnegative amount with at most two decimals"
        )
    weights = {k: max(v["estimated"], Decimal(0)) for k, v in orders.items()}
    if not sum(weights.values()):
        weights = {k: v["value"] for k, v in orders.items()}
    total = sum(weights.values())
    cents = int(amount * 100)
    exact = {k: Decimal(cents) * weight / total for k, weight in weights.items()}
    allocated = {
        k: int(value.to_integral_value(rounding=ROUND_DOWN))
        for k, value in exact.items()
    }
    for k in sorted(exact, key=lambda k: (-(exact[k] - allocated[k]), k))[
        : cents - sum(allocated.values())
    ]:
        allocated[k] += 1
    item = {
        **key(user, date, account, broker),
        "date": date,
        "account_id": account,
        "execution_broker": broker,
        "actual_total": amount,
        "estimated_total": sum(v["estimated"] for v in orders.values()),
        "updated_at": datetime.now(UTC).isoformat(),
        "orders": {
            k: {
                "quantity": v["quantity"],
                "value": v["value"],
                "actual": Decimal(allocated[k]) / 100,
            }
            for k, v in orders.items()
        },
    }
    from app.services.wallet_service import _ensure_ledger_table

    _ensure_ledger_table()
    table().put_item(Item=item)
    logger.info("Real analytics charges saved date=%s orders=%s", date, len(orders))
    return overview(user, date)


def remove(user, date, account, broker="kotak"):
    from app.services.execution_broker import name

    broker = name(broker)
    if read(user, date, account, broker) is None:
        raise HTTPException(404, "Saved actual charges not found for this account/date")
    from boto3.dynamodb.types import TypeSerializer

    from app.services.db import get_dynamodb_client

    keys = [key(user, date, account, broker)]
    if broker == "kotak":
        keys.append(legacy_key(user, date, account))
    # Remove both versions together so a failed delete cannot revive an old bill.
    serializer = TypeSerializer()
    get_dynamodb_client().transact_write_items(
        TransactItems=[
            {
                "Delete": {
                    "TableName": "WalletLedgers",
                    "Key": {
                        name: serializer.serialize(value)
                        for name, value in item.items()
                    },
                }
            }
            for item in keys
        ]
    )
    logger.info("Real analytics charges removed date=%s", date)
    return overview(user, date)


def apply_rows(session, rows):
    """Return copies; never change Trades, broker snapshots, wallets or live state."""
    if session.get("session_type") != "real":
        return rows
    result = [
        {
            **row,
            "execution_broker": row.get("execution_broker")
            or session.get("execution_broker")
            or "kotak",
            "fee_source": "estimated",
        }
        for row in rows
    ]
    if session.get("trading_style", "intraday") != "intraday":
        return result
    if not session.get("user_id") or not session.get("date"):
        return result
    for (broker, account), account_rows in grouped(result).items():
        saved = read(session["user_id"], session["date"], account, broker)
        if not saved:
            continue
        current = totals(account_rows)
        by_order = defaultdict(list)
        for row in account_rows:
            by_order[order_key(row)].append(row)
        for k, members in by_order.items():
            billed = saved.get("orders", {}).get(k)
            now = current[k]
            if (
                not billed
                or int(billed["quantity"]) != now["quantity"]
                or abs(float(billed["value"] - now["value"])) > 0.0001
            ):
                for row in members:
                    row["fee_source"] = "estimated_history_changed"
                continue
            weights = [
                max(Decimal(str(row.get("commission", 0))), Decimal(0))
                for row in members
            ]
            if not sum(weights):
                weights = [
                    Decimal(str(row["price"])) * int(row["quantity"]) for row in members
                ]
            total = sum(weights)
            for row, weight in zip(members, weights):
                row["commission"] = float(billed["actual"] * weight / total)
                row["fee_source"] = "allocated_actual"
    return result
