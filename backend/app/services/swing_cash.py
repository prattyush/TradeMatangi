"""Persistent Paper Swing cash independent of daily practice wallets."""

import hashlib
from botocore.exceptions import ClientError
from fastapi import HTTPException
from app.services.swing_funding_store import encode, decode, _table
from app.services.swing_accounting import money


def ledger_key(portfolio_id):
    return f"swing:{portfolio_id}"


def read(user, portfolio_id):
    row = (
        _table()
        .get_item(
            Key={"user_id": user, "ledger_id": ledger_key(portfolio_id)},
            ConsistentRead=True,
        )
        .get("Item")
    )
    if not row:
        raise HTTPException(
            404, "Swing wallet is not initialized; reconnect to its portfolio"
        )
    return decode(row)


def create(user, portfolio_id, capital):
    capital = money(capital)
    if capital <= 0:
        raise ValueError("Swing capital must be positive")
    row = {
        "user_id": user,
        "ledger_id": ledger_key(portfolio_id),
        "current_balance": capital,
        "initial_balance": capital,
        "version": 0,
        "ledger_kind": "swing_paper",
    }
    try:
        _table().put_item(
            Item=encode(row), ConditionExpression="attribute_not_exists(ledger_id)"
        )
        return row
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        existing = read(user, portfolio_id)
        if existing["initial_balance"] != capital:
            raise HTTPException(
                409, "Swing wallet already has a different starting capital"
            ) from exc
        return existing


def move(
    user,
    portfolio_id,
    amount,
    operation_id,
    *,
    allow_negative=False,
    order=None,
    trade=None,
    extra_actions=None,
):
    from boto3.dynamodb.types import TypeSerializer
    from app.services.db import get_dynamodb_client
    from app.services.wallet_service import InsufficientFundsError

    if not operation_id:
        raise ValueError("Swing cash changes require an operation identity")
    amount = money(amount)
    receipt = {
        "user_id": user,
        "ledger_id": f"swing-op:{portfolio_id}:{hashlib.sha256(operation_id.encode()).hexdigest()}",
    }
    serialize = lambda row: {
        k: TypeSerializer().serialize(v) for k, v in encode(row).items()
    }
    for _ in range(4):
        current = read(user, portfolio_id)
        existing = _table().get_item(Key=receipt, ConsistentRead=True).get("Item")
        if existing:
            if money(existing["amount"]) != amount:
                raise HTTPException(
                    409, "Swing cash identity was reused with a different amount"
                )
            return current["current_balance"]
        balance = money(current["current_balance"] + amount)
        if balance < 0 and not allow_negative:
            raise InsufficientFundsError(current["current_balance"], -amount)
        tx = [
            {
                "Update": {
                    "TableName": "WalletLedgers",
                    "Key": serialize(
                        {"user_id": user, "ledger_id": ledger_key(portfolio_id)}
                    ),
                    "UpdateExpression": "SET current_balance = :balance, #version = :next",
                    "ConditionExpression": "#version = :old",
                    "ExpressionAttributeNames": {"#version": "version"},
                    "ExpressionAttributeValues": serialize(
                        {
                            ":balance": balance,
                            ":next": current["version"] + 1,
                            ":old": current["version"],
                        }
                    ),
                }
            },
            {
                "Put": {
                    "TableName": "WalletLedgers",
                    "Item": serialize({**receipt, "amount": amount}),
                    "ConditionExpression": "attribute_not_exists(ledger_id)",
                }
            },
        ]
        if order is not None:
            tx.append(
                {
                    "Put": {
                        "TableName": "Orders",
                        "Item": serialize(order.model_dump(mode="json")),
                    }
                }
            )
        if trade is not None:
            tx.append(
                {
                    "Put": {
                        "TableName": "Trades",
                        "Item": serialize(trade.model_dump(mode="json")),
                    }
                }
            )
        if extra_actions:
            tx.extend(extra_actions)
        try:
            get_dynamodb_client().transact_write_items(TransactItems=tx)
            return balance
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "TransactionCanceledException":
                raise
    raise HTTPException(
        409, "Swing funds changed concurrently; retry the same operation identity"
    )
