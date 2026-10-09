import asyncio
import time
from types import SimpleNamespace
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
        monkeypatch.setattr(wallet_service, "DEFAULT_BALANCE", 100_000)
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
    token, _ = paper_wallet.claim_session(USER, DATE, "NIFTY")
    paper_wallet.finish_session_claim(USER, DATE, "NIFTY", token, "locked-run", desktop=True)
    paper_wallet.lock(USER, DATE)
    wallet_service._ledgers.clear()
    assert paper_wallet.locked(USER, DATE)
    with pytest.raises(HTTPException) as exc:
        wallet_service.reset_ledger(USER, DATE, f"paper:{DATE}", 1_000_000)
    assert exc.value.status_code == 409
    assert paper_wallet.balance(USER, DATE) == 150_000
    paper_wallet.stop_desktop_session(USER, DATE, "NIFTY", "locked-run")
    paper_wallet.complete_desktop_cleanup(USER, DATE, "NIFTY", "locked-run")
    assert not paper_wallet.locked(USER, DATE)
    assert wallet_service.reset_ledger(USER, DATE, f"paper:{DATE}", 1_000_000) == 1_000_000


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


def test_atomic_order_reservation_handles_nested_analytics_and_decimal_evidence(database):
    from decimal import Decimal
    from app.models.schemas import Order, TradeSide
    database.create_table(TableName="Orders", KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": "order_id", "KeyType": "RANGE"}], AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": "order_id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
    token, _ = paper_wallet.claim_session(USER, DATE, "NIFTY")
    paper_wallet.finish_session_claim(USER, DATE, "NIFTY", token, "analytics-paper", desktop=True)
    order = Order(session_id="analytics-paper", user_id=USER, symbol="NIFTY", side=TradeSide.BUY,
        quantity=65, trigger_price=101, limit_price=101, created_at=1, reserved_amount=6565,
        source="desktop_paper", wallet_ledger_id=f"paper:{DATE}", wallet_ledger_kind="paper",
        analytics={"capital": 100000.0, "requested_pct": 3.0, "reference_price": Decimal("100.25"),
                   "action_id": "00123", "details": [{"budget": 3000.5, "unknown": None, "zero": 0.0, "enabled": False}]},
        split_operation={"operation_id": "007", "details": [{"price": 100.25}]})
    for _ in range(2):
        assert paper_wallet.move(USER, DATE, -6565, "nested-reserve", order=order,
            engine=(order.session_id, order.symbol, token)) == 93435
    stored = database.Table("Orders").get_item(Key={"session_id": order.session_id, "order_id": order.order_id})["Item"]
    assert stored["analytics"]["capital"] == Decimal("100000")
    assert stored["analytics"]["reference_price"] == Decimal("100.25")
    assert stored["analytics"]["action_id"] == "00123"
    assert stored["analytics"]["details"] == [{"budget": Decimal("3000.5"), "unknown": None, "zero": Decimal("0"), "enabled": False}]
    assert stored["split_operation"]["operation_id"] == "007"
    assert stored["split_operation"]["details"][0]["price"] == Decimal("100.25")


def test_fenced_nested_items_keep_numbers_and_engine_ownership(database):
    from decimal import Decimal
    database.create_table(TableName="Sessions", KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}], AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
    token, _ = paper_wallet.claim_session(USER, DATE, "NIFTY")
    paper_wallet.finish_session_claim(USER, DATE, "NIFTY", token, "nested-fence", desktop=True)
    item = {"session_id": "nested-fence", "metadata": {"prices": [100.25, Decimal("90.5")], "enabled": True}}
    paper_wallet.fenced_put("Sessions", item, user_id=USER, date=DATE, symbol="NIFTY", session_id="nested-fence", token=token)
    stored = database.Table("Sessions").get_item(Key={"session_id": "nested-fence"})["Item"]
    assert stored["metadata"]["prices"] == [Decimal("100.25"), Decimal("90.5")]
    with pytest.raises(HTTPException) as error:
        paper_wallet.fenced_put("Sessions", {**item, "metadata": {"prices": [999.25]}}, user_id=USER, date=DATE, symbol="NIFTY", session_id="nested-fence", token="other-engine")
    assert error.value.status_code == 409
    assert database.Table("Sessions").get_item(Key={"session_id": "nested-fence"})["Item"] == stored


def test_lost_transaction_reply_recovers_same_receipt_without_second_debit(database, monkeypatch, caplog):
    from app.services.db import get_dynamodb_client
    assert paper_wallet.balance(USER, DATE) == 100000
    client = get_dynamodb_client()
    calls = []
    def lost_reply(**params):
        calls.append(params)
        client.transact_write_items(**params)
        raise TimeoutError("Synthetic lost acknowledgement")
    monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: SimpleNamespace(transact_write_items=lost_reply))
    with pytest.raises(HTTPException) as error:
        paper_wallet.move(USER, DATE, -1000, "same-operation")
    assert error.value.status_code == 503
    assert "Synthetic lost acknowledgement" in caplog.text
    assert paper_wallet.move(USER, DATE, -1000, "same-operation") == 99000
    assert len(calls) == 1
    with pytest.raises(HTTPException) as error:
        paper_wallet.move(USER, DATE, -1001, "same-operation")
    assert error.value.status_code == 409
    assert paper_wallet.balance(USER, DATE) == 99000


def test_expired_engine_cannot_renew_before_another_worker_claims(database):
    token, _ = paper_wallet.claim_session(USER, DATE, "TATPOW")
    paper_wallet.finish_session_claim(USER, DATE, "TATPOW", token, "session-a")
    database.Table("WalletLedgers").update_item(Key={"user_id": USER, "ledger_id": f"paper:{DATE}:session:TATPOW"}, UpdateExpression="SET engine_until = :expired", ExpressionAttributeValues={":expired": 1})
    with pytest.raises(HTTPException) as exc:
        paper_wallet.renew_engine(USER, DATE, "TATPOW", token)
    assert exc.value.status_code == 409


def test_desktop_paper_stop_keeps_identity_and_fences_old_engine(database):
    token, previous = paper_wallet.claim_session(USER, DATE, "NIFTY")
    assert previous is None
    paper_wallet.finish_session_claim(USER, DATE, "NIFTY", token, "desktop-session", desktop=True)
    assert paper_wallet.move(USER, DATE, -100, "first-fill", engine=("desktop-session", "NIFTY", token)) == 99_900

    first_generation = int(paper_wallet.session_claim(USER, DATE, "NIFTY")["engine_generation"])
    stopped = paper_wallet.stop_desktop_session(USER, DATE, "NIFTY", "desktop-session",
        expected_generation=first_generation)
    assert stopped["session_status"] == "stopped"
    assert stopped["session_id"] == "desktop-session"
    with pytest.raises(HTTPException) as exc:
        paper_wallet.move(USER, DATE, -100, "late-fill", engine=("desktop-session", "NIFTY", token))
    assert exc.value.status_code == 409
    assert paper_wallet.balance(USER, DATE) == 99_900

    paper_wallet.complete_desktop_cleanup(USER, DATE, "NIFTY", "desktop-session")
    assert paper_wallet.stop_desktop_session(USER, DATE, "NIFTY", "desktop-session")["cleanup_pending"] is False
    resumed_token, previous = paper_wallet.claim_session(USER, DATE, "NIFTY")
    assert previous == "desktop-session"
    paper_wallet.finish_session_claim(USER, DATE, "NIFTY", resumed_token, previous, desktop=True)
    with pytest.raises(HTTPException) as exc:
        paper_wallet.stop_desktop_session(USER, DATE, "NIFTY", "desktop-session",
            expected_generation=first_generation)
    assert exc.value.status_code == 409
    assert paper_wallet.session_claim(USER, DATE, "NIFTY")["session_status"] == "running"
    with pytest.raises(HTTPException) as exc:
        paper_wallet.move(USER, DATE, 100, "stale-cleanup", cleanup=("desktop-session", "NIFTY"))
    assert exc.value.status_code == 409
    assert paper_wallet.move(USER, DATE, -100, "new-fill", engine=("desktop-session", "NIFTY", resumed_token)) == 99_800
    with pytest.raises(HTTPException):
        paper_wallet.renew_engine(USER, DATE, "NIFTY", token)


def test_desktop_paper_fenced_put_rejects_stale_session_write(database):
    database.create_table(TableName="Sessions", KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
    token, _ = paper_wallet.claim_session(USER, DATE, "NIFTY")
    paper_wallet.finish_session_claim(USER, DATE, "NIFTY", token, "desktop-session", desktop=True)
    paper_wallet.fenced_put("Sessions", {"session_id": "desktop-session", "state": "running"},
        user_id=USER, date=DATE, symbol="NIFTY", session_id="desktop-session", token=token)
    paper_wallet.stop_desktop_session(USER, DATE, "NIFTY", "desktop-session")
    with pytest.raises(HTTPException) as exc:
        paper_wallet.fenced_put("Sessions", {"session_id": "desktop-session", "state": "running"},
            user_id=USER, date=DATE, symbol="NIFTY", session_id="desktop-session", token=token)
    assert exc.value.status_code == 409
    assert database.Table("Sessions").get_item(Key={"session_id": "desktop-session"})["Item"]["state"] == "running"
    paper_wallet.fenced_put("Sessions", {"session_id": "desktop-session", "state": "ended"},
        user_id=USER, date=DATE, symbol="NIFTY", session_id="desktop-session", stopped=True)
    assert database.Table("Sessions").get_item(Key={"session_id": "desktop-session"})["Item"]["state"] == "ended"


def test_paper_engine_retries_transient_renewal_failure(monkeypatch):
    from app.routers import simulation
    from app.models.schemas import SimulationState

    session = SimpleNamespace(session_id="paper-retry", user_id=USER, date=DATE, symbol="TATPOW",
                              paper_engine_token="token", paper_engine_valid_until=time.monotonic() + 40,
                              state=SimulationState.RUNNING)
    attempts = []
    sleeps = []

    async def next_interval(_):
        sleeps.append(None)
        if len(sleeps) == 3:
            session.state = SimulationState.ENDED

    def renew(*_):
        attempts.append(None)
        if len(attempts) == 1:
            raise HTTPException(status_code=503, detail="temporary storage failure")

    monkeypatch.setattr(simulation.asyncio, "sleep", next_interval)
    monkeypatch.setattr(paper_wallet, "renew_engine", renew)
    monkeypatch.setattr(simulation.sim_svc, "stop_session", lambda _: pytest.fail("transient error stopped Paper"))

    asyncio.run(simulation._renew_paper_engine(session))
    assert len(attempts) == 2


def test_paper_engine_stops_after_ownership_changes(monkeypatch):
    from app.routers import simulation
    from app.models.schemas import SimulationState

    session = SimpleNamespace(session_id="paper-lost", user_id=USER, date=DATE, symbol="TATPOW",
                              paper_engine_token="token", paper_engine_valid_until=time.monotonic() + 40,
                              state=SimulationState.RUNNING)
    stopped = []

    async def next_interval(_):
        return None

    def stop(current):
        stopped.append(current.session_id)
        current.state = SimulationState.ENDED

    monkeypatch.setattr(simulation.asyncio, "sleep", next_interval)
    monkeypatch.setattr(paper_wallet, "renew_engine", lambda *_: (_ for _ in ()).throw(HTTPException(status_code=409, detail="owner changed")))
    monkeypatch.setattr(simulation.sim_svc, "stop_session", stop)

    asyncio.run(simulation._renew_paper_engine(session))
    assert stopped == ["paper-lost"]
    assert session.paper_lease_lost is True
