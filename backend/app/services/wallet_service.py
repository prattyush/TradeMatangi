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
    """Overwrite wallet balance for (user_id, date)."""
    _wallets[(user_id, date)] = amount
    _write_wallet_to_db(user_id, date, amount)
    return amount
