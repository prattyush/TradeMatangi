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
    """Ledger-aware facade. First use copies the legacy balance, preserving history."""
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
        balance = get_or_init_wallet(user_id, date)
    _ledgers[key] = balance
    _write_ledger(user_id, date, ledger_id, ledger_kind, balance)
    return balance


def _write_ledger(user_id: str, date: str, ledger_id: str, ledger_kind: str, balance: float) -> None:
    try:
        _ensure_ledger_table()
        from app.services.db import get_dynamodb_resource
        import time
        get_dynamodb_resource().Table(_LEDGER_TABLE).put_item(Item={
            "user_id": user_id, "ledger_id": ledger_id, "date": date, "ledger_kind": ledger_kind,
            "current_balance": Decimal(str(round(balance, 2))), "updated_at": int(time.time() * 1000),
        })
    except Exception:
        logger.exception("DynamoDB ledger write failed user=%s ledger=%s", user_id, ledger_id)


def get_ledger_balance(user_id: str, date: str, ledger_id: str, ledger_kind: str = "sim") -> float:
    return get_or_init_ledger(user_id, date, ledger_id, ledger_kind)


def debit_ledger(user_id: str, amount: float, date: str, ledger_id: str, ledger_kind: str = "sim") -> float:
    balance = get_or_init_ledger(user_id, date, ledger_id, ledger_kind)
    if amount > balance:
        raise InsufficientFundsError(balance, amount)
    balance -= max(amount, 0)
    _ledgers[(user_id, ledger_id)] = balance
    _write_ledger(user_id, date, ledger_id, ledger_kind, balance)
    return balance


def credit_ledger(user_id: str, amount: float, date: str, ledger_id: str, ledger_kind: str = "sim") -> float:
    balance = get_or_init_ledger(user_id, date, ledger_id, ledger_kind) + max(amount, 0)
    _ledgers[(user_id, ledger_id)] = balance
    _write_ledger(user_id, date, ledger_id, ledger_kind, balance)
    return balance


def reset_ledger(user_id: str, date: str, ledger_id: str, amount: float, ledger_kind: str = "real") -> float:
    _ledgers[(user_id, ledger_id)] = amount
    _write_ledger(user_id, date, ledger_id, ledger_kind, amount)
    return amount


def recalculate_sim_ledger_for_date(user_id: str, date: str) -> float:
    """Rebuild the shared historical simulation ledger after deleting sessions.

    The shared sim ledger is keyed by date, so override cleanup must remove the
    deleted sessions' cash-flow effects without erasing retained sessions for
    the same day.
    """
    balance = _load_prior_from_db(user_id, date)
    if balance is None:
        balance = DEFAULT_BALANCE
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        resource = get_dynamodb_resource()
        sessions_table = resource.Table("Sessions")
        trades_table = resource.Table("Trades")
        resp = sessions_table.query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
        )
        sessions = [
            item for item in resp.get("Items", [])
            if item.get("date") == date
            and item.get("session_type") in ("sim", "stepwise")
            and (item.get("wallet_ledger_id") or f"sim:{date}") == f"sim:{date}"
        ]
        trades: list[dict] = []
        for session in sessions:
            sid = session.get("session_id")
            if not sid:
                continue
            trade_resp = trades_table.query(KeyConditionExpression=Key("session_id").eq(sid))
            trades.extend(trade_resp.get("Items", []))
        trades.sort(key=lambda item: int(item.get("timestamp", 0)))
        for trade in trades:
            amount = float(trade.get("price", 0)) * int(trade.get("quantity", 0))
            if trade.get("side") == "BUY":
                balance -= amount
            elif trade.get("side") == "SELL":
                balance += amount
    except Exception:
        logger.exception("Could not recalculate sim ledger user=%s date=%s", user_id, date)
    reset(user_id, date, balance)
    return reset_ledger(user_id, date, f"sim:{date}", balance, "sim")


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
