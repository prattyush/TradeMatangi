from unittest.mock import patch

import boto3
from fastapi import HTTPException
from moto import mock_aws
import pytest

from app.services import paper_wallet, wallet_service

USER = "phase18-user"
DATE = "2026-09-25"


@pytest.fixture
def database(monkeypatch):
    paper_wallet._ready_endpoints.clear()
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        client = boto3.client("dynamodb", region_name="ap-south-1")
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        monkeypatch.setattr(wallet_service, "get_or_init_wallet", lambda *args: 100_000)
        yield resource
    wallet_service._ledgers.clear()


def test_paper_wallet_reads_are_authoritative_and_retry_safe(database):
    assert paper_wallet.balance(USER, DATE) == 100_000
    assert paper_wallet.move(USER, DATE, -24_000, "entry") == 76_000
    wallet_service._ledgers[(USER, f"paper:{DATE}")] = 999_999
    assert wallet_service.get_ledger_balance(USER, DATE, f"paper:{DATE}") == 76_000
    assert paper_wallet.move(USER, DATE, -24_000, "entry") == 76_000
    with pytest.raises(HTTPException) as exc:
        paper_wallet.move(USER, DATE, -23_000, "entry")
    assert exc.value.status_code == 409
    assert paper_wallet.move(USER, DATE, 24_000, "cancel") == 100_000
    assert paper_wallet.move(USER, DATE, 24_000, "cancel") == 100_000


def test_shared_wallet_rejects_overspending_and_preserves_balance(database):
    paper_wallet.move(USER, DATE, -60_000, "screen-a")
    with pytest.raises(wallet_service.InsufficientFundsError):
        paper_wallet.move(USER, DATE, -60_000, "screen-b")
    assert paper_wallet.balance(USER, DATE) == 40_000
    assert paper_wallet.balance("another-user", DATE) == 100_000


def test_date_lock_survives_cache_clear_and_session_stop(database):
    paper_wallet.reset(USER, DATE, 150_000)
    paper_wallet.lock(USER, DATE)
    wallet_service._ledgers.clear()
    assert paper_wallet.locked(USER, DATE)
    with pytest.raises(HTTPException) as exc:
        wallet_service.reset_ledger(USER, DATE, f"paper:{DATE}", 1_000_000)
    assert exc.value.status_code == 409
    assert paper_wallet.balance(USER, DATE) == 150_000


def test_session_claim_prevents_duplicate_engines_and_can_recover(database):
    token, existing = paper_wallet.claim_session(USER, DATE, "TATPOW")
    assert existing is None
    with pytest.raises(HTTPException):
        paper_wallet.claim_session(USER, DATE, "TATPOW")
    paper_wallet.finish_session_claim(USER, DATE, "TATPOW", token, "session-a")
    with pytest.raises(HTTPException):
        paper_wallet.claim_session(USER, DATE, "TATPOW")
    # Another underlying may run concurrently on the same date/wallet.
    other, _ = paper_wallet.claim_session(USER, DATE, "RELIND")
    paper_wallet.finish_session_claim(USER, DATE, "RELIND", other, "session-b")
    paper_wallet.renew_engine(USER, DATE, "TATPOW", token, stop=True)
    recovered, existing = paper_wallet.claim_session(USER, DATE, "TATPOW")
    assert existing == "session-a"
    paper_wallet.finish_session_claim(USER, DATE, "TATPOW", recovered, existing)
    with pytest.raises(HTTPException):
        paper_wallet.renew_engine(USER, DATE, "TATPOW", token)


def test_persistence_failure_does_not_accept_spending(database):
    paper_wallet.balance(USER, DATE)
    with patch("app.services.db.get_dynamodb_client", side_effect=RuntimeError("offline")):
        with pytest.raises(HTTPException) as exc:
            paper_wallet.move(USER, DATE, -1_000, "failed")
    assert exc.value.status_code == 503
    assert paper_wallet.balance(USER, DATE) == 100_000


def test_realized_loss_can_close_without_fresh_entry_margin(database):
    paper_wallet.move(USER, DATE, -100_000, "entry")
    assert paper_wallet.move(USER, DATE, -1_000, "close", allow_negative=True) == -1_000
    with pytest.raises(wallet_service.InsufficientFundsError):
        paper_wallet.move(USER, DATE, -1, "new-entry")


def test_wallet_reservation_and_order_commit_together(database):
    from app.models.schemas import Order, OrderStatus, TradeSide
    database.create_table(TableName="Orders", KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": "order_id", "KeyType": "RANGE"}], AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": "order_id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
    order = Order(session_id="screen-a", user_id=USER, symbol="TATPOW", side=TradeSide.SELL, quantity=100, trigger_price=200, limit_price=200, created_at=1, reserved_amount=4000)
    paper_wallet.move(USER, DATE, -4000, "reserve", order=order)
    stored = database.Table("Orders").get_item(Key={"session_id": order.session_id, "order_id": order.order_id})["Item"]
    assert stored["reserved_amount"] == 4000
    assert paper_wallet.balance(USER, DATE) == 96000
    order.status = OrderStatus.CANCELLED
    order.reserved_amount = 0
    paper_wallet.move(USER, DATE, 4000, "cancel", order=order)
    paper_wallet.move(USER, DATE, 4000, "cancel", order=order)
    assert paper_wallet.balance(USER, DATE) == 100000
    stored = database.Table("Orders").get_item(Key={"session_id": order.session_id, "order_id": order.order_id})["Item"]
    assert stored["status"] == "CANCELLED"
    rejected = order.model_copy(update={"order_id": "too-large"})
    with pytest.raises(wallet_service.InsufficientFundsError):
        paper_wallet.move(USER, DATE, -100001, "rejected", order=rejected)
    assert "Item" not in database.Table("Orders").get_item(Key={"session_id": rejected.session_id, "order_id": rejected.order_id})


def test_expired_engine_cannot_renew_before_another_worker_claims(database):
    token, _ = paper_wallet.claim_session(USER, DATE, "TATPOW")
    paper_wallet.finish_session_claim(USER, DATE, "TATPOW", token, "session-a")
    database.Table("WalletLedgers").update_item(Key={"user_id": USER, "ledger_id": f"paper:{DATE}:session:TATPOW"}, UpdateExpression="SET engine_until = :expired", ExpressionAttributeValues={":expired": 1})
    with pytest.raises(HTTPException) as exc:
        paper_wallet.renew_engine(USER, DATE, "TATPOW", token)
    assert exc.value.status_code == 409
