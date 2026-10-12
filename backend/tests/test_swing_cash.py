import boto3
from moto import mock_aws
import pytest
from fastapi import HTTPException
from app.models.schemas import Order
from app.services import swing_cash
from app.services.wallet_service import InsufficientFundsError


@pytest.fixture
def db(monkeypatch):
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        client = boto3.client("dynamodb", region_name="ap-south-1")
        for table, keys in [
            ("WalletLedgers", ["user_id", "ledger_id"]),
            ("Orders", ["session_id", "order_id"]),
            ("Trades", ["session_id", "trade_id"]),
        ]:
            resource.create_table(
                TableName=table,
                KeySchema=[
                    {"AttributeName": k, "KeyType": "HASH" if i == 0 else "RANGE"}
                    for i, k in enumerate(keys)
                ],
                AttributeDefinitions=[
                    {"AttributeName": k, "AttributeType": "S"} for k in keys
                ],
                BillingMode="PAY_PER_REQUEST",
            )
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        yield resource


def test_cash_survives_date_changes_and_retry_cannot_charge_twice(db):
    swing_cash.create("u", "portfolio", 100000)
    assert swing_cash.move("u", "portfolio", -20000, "entry-fill") == 80000
    assert swing_cash.move("u", "portfolio", -20000, "entry-fill") == 80000
    assert swing_cash.move("u", "portfolio", 19000, "exit-fill") == 99000
    assert swing_cash.read("u", "portfolio")["initial_balance"] == 100000
    assert (
        db.Table("WalletLedgers")
        .get_item(Key={"user_id": "u", "ledger_id": "paper:2026-10-10"})
        .get("Item")
        is None
    )
    with pytest.raises(HTTPException):
        swing_cash.move("u", "portfolio", -30000, "entry-fill")


def test_cash_and_order_commit_together(db):
    swing_cash.create("u", "portfolio", 100000)
    order = Order(
        session_id="child",
        user_id="u",
        symbol="HDFCBANK",
        side="BUY",
        quantity=10,
        created_at=1,
        trigger_price=100,
        limit_price=100,
    )
    swing_cash.move("u", "portfolio", -1000, "reserve", order=order)
    saved = db.Table("Orders").get_item(
        Key={"session_id": "child", "order_id": order.order_id}
    )["Item"]
    assert saved["symbol"] == "HDFCBANK"
    assert swing_cash.read("u", "portfolio")["current_balance"] == 99000


def test_wrong_user_missing_wallet_and_insufficient_funds_fail_without_debit(db):
    swing_cash.create("u", "portfolio", 100)
    with pytest.raises(HTTPException):
        swing_cash.read("other", "portfolio")
    with pytest.raises(InsufficientFundsError):
        swing_cash.move("u", "portfolio", -101, "entry")
    assert swing_cash.read("u", "portfolio")["current_balance"] == 100
    assert (
        swing_cash.move("u", "portfolio", -101, "confirmed-close", allow_negative=True)
        == -1
    )


def test_existing_wallet_boundary_uses_persistent_swing_cash_across_dates(db):
    from app.services import wallet_service

    swing_cash.create("u", "portfolio", 100000)
    assert (
        wallet_service.get_ledger_balance("u", "2026-10-09", "swing:portfolio")
        == 100000
    )
    assert (
        wallet_service.debit_ledger(
            "u", 20000, "2026-10-09", "swing:portfolio", operation_id="buy"
        )
        == 80000
    )
    assert (
        wallet_service.debit_ledger(
            "u", 20000, "2026-10-10", "swing:portfolio", operation_id="buy"
        )
        == 80000
    )
    assert (
        wallet_service.credit_ledger(
            "u", 19000, "2026-10-10", "swing:portfolio", operation_id="sell"
        )
        == 99000
    )
    assert (
        wallet_service.get_ledger_balance("u", "2026-10-11", "swing:portfolio") == 99000
    )
