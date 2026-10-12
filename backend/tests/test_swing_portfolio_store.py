import boto3
from moto import mock_aws
import pytest
from fastapi import HTTPException
from app.services import swing_portfolio_store as store, swing_cash


@pytest.fixture
def db(monkeypatch):
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        client = boto3.client("dynamodb", region_name="ap-south-1")
        for name, keys in [
            ("WalletLedgers", ["user_id", "ledger_id"]),
            ("Sessions", ["session_id"]),
        ]:
            resource.create_table(
                TableName=name,
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


def test_one_owned_persistent_portfolio_cash_and_pause_do_not_end_positions(db):
    row = store.create("u", "paper", 800000)
    assert store.active("u", "paper")["session_id"] == row["session_id"]
    assert swing_cash.read("u", row["session_id"])["current_balance"] == 800000
    paused = store.pause_entries("u", row["session_id"], True)
    assert paused["entries_paused"] and paused["state"] == "running"
    with pytest.raises(HTTPException):
        store.create("u", "paper", 1)
    with pytest.raises(HTTPException):
        store.owned("other", row["session_id"])


def test_reference_reset_starts_guardrail_epoch_without_changing_cash(db):
    row = store.create("u", "paper", 100000)
    changed = store.reset_guardrail_reference("u", row["session_id"], 120000, 20000)
    assert changed["guardrail_epoch"] == 1 and changed["guardrail_start_pnl"] == 20000
    assert changed["starting_capital"] == 100000
    assert swing_cash.read("u", row["session_id"])["current_balance"] == 100000
    assert store.create("other", "paper", 100000)["user_id"] == "other"


def test_stale_updates_and_identity_changes_are_rejected(db):
    row = store.create("u", "paper", 100000)
    store.pause_entries("u", row["session_id"], True)
    with pytest.raises(HTTPException):
        store.update("u", row["session_id"], {"entries_paused": False}, 0)
    with pytest.raises(ValueError):
        store.update("u", row["session_id"], {"broker_account_id": "different"}, 1)
