"""
Wallet service: per-user per-day balance with carry-forward logic.

Balance model:
- BUY order placement: debit (qty * price) from wallet
- BUY order cancel:    credit the reserved_amount back
- SELL order fill:     credit (qty * filled_price) to wallet
- SELL order cancel:   no credit (nothing was debited on placement)
- SL orders:           no debit on placement (handled in Sprint 2)

In-memory dict is process-local source of truth during a session.
DynamoDB is the persistent store; writes use the swallow-on-failure pattern.
"""
from __future__ import annotations

import logging
from decimal import Decimal

logger = logging.getLogger(__name__)

DEFAULT_BALANCE = 150_000.0

# {(user_id, date): float}
_wallets: dict[tuple[str, str], float] = {}
_ledgers: dict[tuple[str, str], float] = {}
_LEDGER_TABLE = "WalletLedgers"


class InsufficientFundsError(Exception):
    """Raised when a wallet debit would push the balance below zero."""
    def __init__(self, balance: float, required: float):
        self.balance = balance
        self.required = required
        super().__init__(f"Insufficient funds: have ₹{balance:.2f}, need ₹{required:.2f}")


def _write_wallet_to_db(user_id: str, date: str, balance: float) -> None:
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Wallet")
        table.put_item(Item={
            "user_id": user_id,
            "date": date,
            "current_balance": Decimal(str(round(balance, 2))),
        })
    except Exception:
        logger.exception("DynamoDB wallet write failed for user=%s date=%s", user_id, date)


def _load_from_db(user_id: str, date: str) -> float | None:
    """Query DynamoDB for the most recent wallet record before `date`. Returns None if no records."""
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        table = get_dynamodb_resource().Table("Wallet")
        resp = table.query(
            KeyConditionExpression=Key("user_id").eq(user_id) & Key("date").lte(date),
            ScanIndexForward=False,
            Limit=1,
        )
        items = resp.get("Items", [])
        if items:
            return float(items[0]["current_balance"])
    except Exception:
        logger.exception("DynamoDB wallet query failed for user=%s date=%s", user_id, date)
    return None


def _load_prior_from_db(user_id: str, date: str) -> float | None:
    """Query DynamoDB for the most recent wallet record strictly before `date`."""
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        table = get_dynamodb_resource().Table("Wallet")
        resp = table.query(
            KeyConditionExpression=Key("user_id").eq(user_id) & Key("date").lt(date),
            ScanIndexForward=False,
            Limit=1,
        )
        items = resp.get("Items", [])
        if items:
            return float(items[0]["current_balance"])
    except Exception:
        logger.exception("DynamoDB prior wallet query failed for user=%s date=%s", user_id, date)
    return None


def get_or_init_wallet(user_id: str, date: str) -> float:
    """Return balance for (user_id, date), initialising with carry-forward or default if new."""
    key = (user_id, date)
    if key in _wallets:
        return _wallets[key]

    # Try carry-forward from prior date
    prior = _load_from_db(user_id, date)
    balance = prior if prior is not None else DEFAULT_BALANCE

    _wallets[key] = balance
    _write_wallet_to_db(user_id, date, balance)
    return balance


def get_balance(user_id: str, date: str) -> float:
    return get_or_init_wallet(user_id, date)


def _ensure_ledger_table() -> None:
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        if _LEDGER_TABLE in set(get_dynamodb_resource().meta.client.list_tables()["TableNames"]):
            return
        get_dynamodb_client().create_table(
            TableName=_LEDGER_TABLE,
            KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}, {"AttributeName": "ledger_id", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"}, {"AttributeName": "ledger_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
    except Exception:
        logger.exception("Could not ensure %s", _LEDGER_TABLE)


def get_or_init_ledger(user_id: str, date: str, ledger_id: str, ledger_kind: str = "sim") -> float:
    """Use isolated dated practice funds; preserve the Real ledger path."""
    if ledger_id.startswith("paper:"):
        from app.services.paper_wallet import balance
        return balance(user_id, date)
    key = (user_id, ledger_id)
    if key in _ledgers:
        return _ledgers[key]
    balance: float | None = None
    try:
        _ensure_ledger_table()
        from app.services.db import get_dynamodb_resource
        item = get_dynamodb_resource().Table(_LEDGER_TABLE).get_item(Key={"user_id": user_id, "ledger_id": ledger_id}).get("Item")
        if item:
            balance = float(item["current_balance"])
    except Exception:
        logger.exception("DynamoDB ledger read failed user=%s ledger=%s", user_id, ledger_id)
    if balance is None:
        if ledger_id == f"sim:{date}":
            from app.services.practice_wallets import read
            balance = float(read(user_id, date, "sim")["current_balance"])
        else:
            balance = get_or_init_wallet(user_id, date)
    _ledgers[key] = balance
    _write_ledger(user_id, date, ledger_id, ledger_kind, balance)
    return balance


def _write_ledger(user_id: str, date: str, ledger_id: str, ledger_kind: str, balance: float) -> None:
    try:
        _ensure_ledger_table()
        from app.services.db import get_dynamodb_resource
        import time
        get_dynamodb_resource().Table(_LEDGER_TABLE).update_item(
            Key={"user_id": user_id, "ledger_id": ledger_id},
            UpdateExpression="SET #date = :date, ledger_kind = :kind, current_balance = :balance, updated_at = :updated",
            ExpressionAttributeNames={"#date": "date"},
            ExpressionAttributeValues={":date": date, ":kind": ledger_kind,
                ":balance": Decimal(str(round(balance, 2))), ":updated": int(time.time() * 1000)},
        )
    except Exception:
        logger.exception("DynamoDB ledger write failed user=%s ledger=%s", user_id, ledger_id)


def get_ledger_balance(user_id: str, date: str, ledger_id: str, ledger_kind: str = "sim") -> float:
    return get_or_init_ledger(user_id, date, ledger_id, ledger_kind)


def debit_ledger(user_id: str, amount: float, date: str, ledger_id: str, ledger_kind: str = "sim", operation_id: str | None = None, allow_negative: bool = False, order=None, engine=None) -> float:
    if ledger_id.startswith("paper:"):
        from app.services.paper_wallet import move
        return move(user_id, date, -max(amount, 0), operation_id, allow_negative, order, engine)
    balance = get_or_init_ledger(user_id, date, ledger_id, ledger_kind)
    if amount > balance:
        raise InsufficientFundsError(balance, amount)
    balance -= max(amount, 0)
    _ledgers[(user_id, ledger_id)] = balance
    _write_ledger(user_id, date, ledger_id, ledger_kind, balance)
    return balance


def credit_ledger(user_id: str, amount: float, date: str, ledger_id: str, ledger_kind: str = "sim", operation_id: str | None = None, order=None, engine=None, cleanup=None) -> float:
    if ledger_id.startswith("paper:"):
        from app.services.paper_wallet import move
        return move(user_id, date, max(amount, 0), operation_id, order=order, engine=engine, cleanup=cleanup)
    balance = get_or_init_ledger(user_id, date, ledger_id, ledger_kind) + max(amount, 0)
    _ledgers[(user_id, ledger_id)] = balance
    _write_ledger(user_id, date, ledger_id, ledger_kind, balance)
    return balance


def reset_ledger(user_id: str, date: str, ledger_id: str, amount: float, ledger_kind: str = "real") -> float:
    if ledger_id.startswith("paper:"):
        from app.services.paper_wallet import reset
        return reset(user_id, date, amount)
    _ledgers[(user_id, ledger_id)] = amount
    _write_ledger(user_id, date, ledger_id, ledger_kind, amount)
    return amount


def recalculate_sim_ledger_for_date(user_id: str, date: str) -> float:
    """Rebuild the shared historical simulation ledger after deleting sessions.

    The shared sim ledger is keyed by date, so override cleanup must remove the
    deleted sessions' cash-flow effects without erasing retained sessions for
    the same day.
    """
    from app.services import practice_wallets
    record = practice_wallets.read(user_id, date, "sim")
    # Explicit resets establish the baseline for later runs. Old evidence stays
    # in history but must not be charged to that newly saved starting amount.
    balance = float(record["initial_balance"]) if "initial_balance" in record else None
    reset_at = int(record.get("reset_at") or 0)
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        resource = get_dynamodb_resource()
        if balance is None:
            balance = float(practice_wallets.previous_balance(practice_wallets.table(), user_id, date, "sim"))
        sessions_table = resource.Table("Sessions")
        trades_table = resource.Table("Trades")
        from boto3.dynamodb.conditions import Attr
        rows = practice_wallets.pages(sessions_table, "scan", ConsistentRead=True,
            FilterExpression=Attr("user_id").eq(user_id))
        sessions = [
            item for item in rows
            if item.get("date") == date
            and item.get("session_type") in ("sim", "stepwise")
            and (item.get("wallet_ledger_id") or f"sim:{date}") == f"sim:{date}"
            and (not reset_at or int(item.get("created_at") or 0) >= reset_at)
        ]
        trades: list[dict] = []
        for session in sessions:
            sid = session.get("session_id")
            if not sid:
                continue
            trades.extend(practice_wallets.pages(trades_table, "query",
                KeyConditionExpression=Key("session_id").eq(sid), ConsistentRead=True))
        trades.sort(key=lambda item: int(item.get("timestamp", 0)))
        from collections import deque
        from app.config import EQUITY_MIS_MARGIN_RATE
        anchors = {item["session_id"]: item.get("instrument_type", "equity") for item in sessions}
        lots = {}
        for trade in trades:
            price = float(trade.get("price", 0))
            qty = int(trade.get("quantity", 0))
            sid = trade.get("session_id")
            if anchors.get(sid) != "equity" or trade.get("right"):
                amount = price * qty
                balance += amount if trade.get("side") == "SELL" else -amount
                continue
            key = (sid, trade.get("symbol"))
            queue = lots.setdefault(key, deque())
            side = trade.get("side")
            while qty and queue and queue[0][0] != side:
                entry_side, entry_price, entry_qty = queue[0]
                matched = min(qty, entry_qty)
                pnl = (price - entry_price) * matched * (1 if entry_side == "BUY" else -1)
                balance += entry_price * matched * EQUITY_MIS_MARGIN_RATE + pnl
                qty -= matched
                if matched == entry_qty:
                    queue.popleft()
                else:
                    queue[0] = (entry_side, entry_price, entry_qty - matched)
            if qty:
                balance -= price * qty * EQUITY_MIS_MARGIN_RATE
                queue.append((side, price, qty))
        from app.services import order_service
        for session in sessions:
            balance -= sum(order.reserved_amount for order in order_service.get_open_orders(session["session_id"]))
    except Exception as exc:
        practice_wallets.storage_error(exc)
    # Do not update the generic/Real wallet when rebuilding Replay/Stepwise.
    try:
        practice_wallets.table().update_item(Key={"user_id": user_id, "ledger_id": f"sim:{date}"},
            UpdateExpression="SET current_balance = :balance",
            ConditionExpression="activity_revision = :revision OR (attribute_not_exists(activity_revision) AND :revision = :zero)",
            ExpressionAttributeValues={":balance": Decimal(str(round(balance, 2))),
                ":revision": int(record.get("activity_revision") or 0), ":zero": 0})
    except Exception as exc:
        from botocore.exceptions import ClientError
        from fastapi import HTTPException
        if isinstance(exc, ClientError) and exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HTTPException(409, "Wallet changed while rebuilding Replay funds; retry with the saved balance") from exc
        practice_wallets.storage_error(exc)
    _ledgers[(user_id, f"sim:{date}")] = balance
    return balance


def debit(user_id: str, amount: float, date: str) -> float:
    """Debit `amount` from the wallet. Raises InsufficientFundsError if insufficient."""
    if amount <= 0:
        return get_or_init_wallet(user_id, date)
    balance = get_or_init_wallet(user_id, date)
    if balance < amount:
        raise InsufficientFundsError(balance, amount)
    balance -= amount
    _wallets[(user_id, date)] = balance
    _write_wallet_to_db(user_id, date, balance)
    return balance


def credit(user_id: str, amount: float, date: str) -> float:
    """Credit `amount` to the wallet."""
    if amount <= 0:
        return get_or_init_wallet(user_id, date)
    balance = get_or_init_wallet(user_id, date)
    balance += amount
    _wallets[(user_id, date)] = balance
    _write_wallet_to_db(user_id, date, balance)
    return balance


def reset(user_id: str, date: str, amount: float = DEFAULT_BALANCE) -> float:
    """Overwrite the pre-session wallet balance for (user_id, date).

    The shared simulation ledger uses ``sim:<date>`` and can survive a prior
    replay in the same process. Keep it in sync when the wallet is reset before
    the next session is created, otherwise a stale ledger can mask the value
    configured in Settings.
    """
    _wallets[(user_id, date)] = amount
    _write_wallet_to_db(user_id, date, amount)
    simulation_ledger_id = f"sim:{date}"
    if (user_id, simulation_ledger_id) in _ledgers:
        _ledgers[(user_id, simulation_ledger_id)] = amount
        _write_ledger(user_id, date, simulation_ledger_id, "sim", amount)
    return amount


def delete_entry(user_id: str, date: str) -> None:
    """Delete the wallet record for (user_id, date) from DynamoDB and in-memory cache."""
    _wallets.pop((user_id, date), None)
    try:
        from app.services.db import get_dynamodb_resource
        get_dynamodb_resource().Table("Wallet").delete_item(
            Key={"user_id": user_id, "date": date},
        )
        logger.info("Deleted wallet entry for user=%s date=%s", user_id, date)
    except Exception:
        logger.exception("DynamoDB wallet delete failed for user=%s date=%s", user_id, date)


# Broker snapshots are deliberately separate from locally reserved cash.
def sync_real_funds(user_id: str, date: str, amount: float, *, reason: str, accounting: dict | None = None) -> float:
    import math
    import time
    if not math.isfinite(amount):
        raise ValueError("Broker funds must be finite")
    ledger_id = f"real:{date}"
    updated_at = int(time.time() * 1000)
    _ensure_ledger_table()
    from app.services.db import get_dynamodb_resource
    expression = "SET #date = :date, ledger_kind = :kind, current_balance = :balance, " \
                 "broker_balance = :balance, broker_funds_updated_at = :updated, updated_at = :updated"
    values = {":date": date, ":kind": "real", ":balance": Decimal(str(amount)), ":updated": updated_at}
    if accounting is not None:
        for name, value in accounting.items():
            expression += f", {name} = :{name}"
            values[":" + name] = Decimal(str(value)) if isinstance(value, (float, int)) else value
    # Persist first: a failed write must not advertise a successful sync.
    get_dynamodb_resource().Table(_LEDGER_TABLE).update_item(
        Key={"user_id": user_id, "ledger_id": ledger_id},
        UpdateExpression=expression,
        ExpressionAttributeNames={"#date": "date"},
        ExpressionAttributeValues=values,
    )
    _ledgers[(user_id, ledger_id)] = amount
    logger.info("real_funds_synced user_id=%s ledger=%s reason=%s", user_id, ledger_id, reason)
    return amount


def get_real_funds_snapshot(user_id: str, date: str) -> tuple[float, int]:
    key = (user_id, f"real:{date}")
    # Read consistently so another worker's explicit refresh is visible here.
    from app.services.db import get_dynamodb_resource
    item = get_dynamodb_resource().Table(_LEDGER_TABLE).get_item(
        Key={"user_id": key[0], "ledger_id": key[1]}, ConsistentRead=True,
    ).get("Item", {})
    if "broker_balance" not in item:
        # Legacy real ledgers have no authoritative broker snapshot.
        raise ValueError("Real wallet needs a broker refresh")
    snapshot = (float(item["broker_balance"]), int(item["broker_funds_updated_at"]))
    return snapshot


def sync_real_account_funds(user_id, date, account, net, realized, committed, *, reason):
    """Initialize account/day capital once; retain raw cash for order affordability."""
    import math
    candidate = round(net - realized + committed, 2)
    display = round(net - realized, 2)
    if not all(math.isfinite(value) for value in (net, realized, committed, candidate, display)):
        raise ValueError("Invalid real accounting snapshot")
    _ensure_ledger_table()
    from app.services.db import get_dynamodb_resource
    # Atomic initialization also works when another worker initializes the same day.
    row = get_dynamodb_resource().Table(_LEDGER_TABLE).update_item(
        Key={"user_id": user_id, "ledger_id": f"real-capital:{account}:{date}"},
        UpdateExpression="SET #date = :date, ledger_kind = :kind, "
                         "day_start_capital = if_not_exists(day_start_capital, :capital)",
        ExpressionAttributeNames={"#date": "date"},
        ExpressionAttributeValues={":date": date, ":kind": "real-capital", ":capital": Decimal(str(candidate))},
        ReturnValues="ALL_NEW",
    )["Attributes"]
    capital = float(row["day_start_capital"])
    if not math.isfinite(capital):
        raise ValueError("Invalid saved real day-start capital")
    accounting = {"broker_account_id": account, "day_start_capital": capital,
                  "display_balance": display, "gross_realized_pnl": realized, "committed_funds": committed}
    sync_real_funds(user_id, date, net, reason=reason, accounting=accounting)
    return {"balance": net, "display_balance": display, "session_capital": capital}


def get_real_wallet_snapshot(user_id, date):
    from app.services.db import get_dynamodb_resource
    item = get_dynamodb_resource().Table(_LEDGER_TABLE).get_item(
        Key={"user_id": user_id, "ledger_id": f"real:{date}"}, ConsistentRead=True,
    ).get("Item", {})
    if "broker_balance" not in item:
        raise ValueError("Real wallet needs a broker refresh")
    result = {"balance": float(item["broker_balance"]),
              "broker_funds_updated_at": int(item["broker_funds_updated_at"])}
    if "display_balance" in item and "day_start_capital" in item:
        result.update(display_balance=float(item["display_balance"]), session_capital=float(item["day_start_capital"]))
    return result
