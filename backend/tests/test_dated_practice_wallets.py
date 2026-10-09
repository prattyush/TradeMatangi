from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import boto3
from fastapi import HTTPException
from fastapi.testclient import TestClient
from moto import mock_aws
import pytest

from app.main import app
from app.services import paper_wallet, practice_wallets as wallets, simulation, wallet_service

USER = "dated-wallet-user"
DATE = "2026-10-09"


@pytest.fixture
def db(monkeypatch):
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        client = boto3.client("dynamodb", region_name="ap-south-1")
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        paper_wallet._ready_endpoints.clear()
        wallet_service._ledgers.clear()
        for name, keys in [("WalletLedgers", ["user_id", "ledger_id"]), ("Wallet", ["user_id", "date"]),
                           ("Sessions", ["session_id"]), ("Orders", ["session_id", "order_id"])]:
            resource.create_table(TableName=name, KeySchema=[{"AttributeName": key, "KeyType": "HASH" if index == 0 else "RANGE"} for index, key in enumerate(keys)],
                AttributeDefinitions=[{"AttributeName": key, "AttributeType": "S"} for key in keys], BillingMode="PAY_PER_REQUEST")
        yield resource
        wallet_service._ledgers.clear()
        simulation._sessions.clear()


def seed(db, kind, date, amount):
    db.Table("WalletLedgers").put_item(Item={"user_id": USER, "ledger_id": f"{kind}:{date}", "date": date,
        "ledger_kind": kind, "current_balance": Decimal(str(amount))})


def test_same_kind_carry_forward_existing_date_and_no_legacy_real_seed(db):
    db.Table("Wallet").put_item(Item={"user_id": USER, "date": DATE, "current_balance": Decimal("999999")})
    seed(db, "real", DATE, 888888)
    assert wallets.read(USER, DATE, "paper")["current_balance"] == 150000
    assert wallets.read(USER, DATE, "sim")["current_balance"] == 150000
    seed(db, "paper", "2026-10-10", 153000)
    seed(db, "sim", "2026-10-10", 148000)
    assert wallets.read(USER, "2026-10-11", "paper")["current_balance"] == 153000
    assert wallets.read(USER, "2026-10-11", "sim")["current_balance"] == 148000
    seed(db, "paper", "2026-10-10", 200000)
    assert wallets.read(USER, "2026-10-11", "paper")["current_balance"] == 153000


def test_paper_reset_after_stop_is_shared_by_clients_but_not_other_modes(db):
    seed(db, "sim", DATE, 120000)
    seed(db, "real", DATE, 999999)
    token, _ = paper_wallet.claim_session(USER, DATE, "NIFTY")
    paper_wallet.finish_session_claim(USER, DATE, "NIFTY", token, "stopped", desktop=True)
    paper_wallet.lock(USER, DATE)
    with pytest.raises(HTTPException) as blocked:
        wallets.reset(USER, DATE, "paper", 180000)
    assert blocked.value.status_code == 409
    paper_wallet.stop_desktop_session(USER, DATE, "NIFTY", "stopped")
    assert wallets.reset(USER, DATE, "paper", 180000) == 180000
    paper_wallet.complete_desktop_cleanup(USER, DATE, "NIFTY", "stopped")
    client = TestClient(app)
    headers = {"X-User-Id": USER}
    result = client.post(f"/api/wallet/reset?date={DATE}&mode=paper", headers=headers, json={"amount": 180000})
    assert result.status_code == 200
    desktop = client.get(f"/api/desktop/v1/trading/wallet?date={DATE}&desktop_mode=paper", headers=headers)
    assert desktop.json()["balance"] == 180000
    assert desktop.json()["locked"] is False
    assert wallets.read(USER, DATE, "sim")["current_balance"] == 120000
    assert wallets.read(USER, DATE, "real")["current_balance"] == 999999


def test_replay_stepwise_reset_does_not_touch_paper_real_or_legacy(db):
    seed(db, "paper", DATE, 130000)
    seed(db, "real", DATE, 990000)
    client = TestClient(app)
    headers = {"X-User-Id": USER}
    result = client.post(f"/api/desktop/v1/trading/wallet/reset?date={DATE}&desktop_mode=stepwise", headers=headers, json={"amount": 200000})
    assert result.status_code == 200
    assert client.get(f"/api/wallet?date={DATE}&mode=sim", headers=headers).json()["balance"] == 200000
    assert wallets.read(USER, DATE, "paper")["current_balance"] == 130000
    assert wallets.read(USER, DATE, "real")["current_balance"] == 990000
    assert "Item" not in db.Table("Wallet").get_item(Key={"user_id": USER, "date": DATE})
    wallet_service._ledgers[(USER, f"sim:{DATE}")] = 1
    assert client.get(f"/api/wallet?date={DATE}&mode=sim", headers=headers).json()["balance"] == 200000


def test_default_today_is_paper_and_selected_historical_date_is_sim(db):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    seed(db, "paper", today, 300000)
    seed(db, "sim", today, 200000)
    seed(db, "sim", "2020-01-02", 190000)
    client = TestClient(app)
    headers = {"X-User-Id": USER}
    assert client.get(f"/api/wallet?date={today}", headers=headers).json()["balance"] == 300000
    assert client.get("/api/wallet?date=2020-01-02", headers=headers).json()["balance"] == 190000


def test_any_on_session_blocks_reset_but_stopped_history_does_not(db):
    from types import SimpleNamespace
    session = SimpleNamespace(user_id=USER, date=DATE, session_type="stepwise", state=simulation.SimulationState.PAUSED)
    simulation._sessions["on"] = session
    for kind in ("sim", "paper"):
        with pytest.raises(HTTPException) as error:
            wallets.reset(USER, "2026-10-08", kind, 123000)
        assert error.value.status_code == 409
    session.state = simulation.SimulationState.ENDED
    db.Table("Sessions").put_item(Item={"session_id": "old", "user_id": USER, "date": DATE, "session_type": "sim", "state": "running"})
    db.Table("Orders").put_item(Item={"session_id": "old", "order_id": "old-order", "user_id": USER, "status": "PENDING", "wallet_ledger_id": f"sim:{DATE}"})
    assert wallets.reset(USER, DATE, "sim", 123000) == 123000
    assert wallets.reset(USER, DATE, "paper", 111000) == 111000
    assert db.Table("Orders").scan()["Count"] == 1


def test_replay_start_reset_revision_races_fail_closed(db):
    version = wallets.begin_start(USER, DATE)
    assert wallets.reset(USER, DATE, "sim", 220000) == 220000
    with pytest.raises(HTTPException) as error:
        wallets.confirm_start(USER, DATE, version)
    assert error.value.status_code == 409
    version = wallets.begin_start(USER, DATE)
    db.Table("Sessions").put_item(Item={"session_id": "prepared", "user_id": USER, "date": DATE, "session_type": "sim", "state": "idle"})
    wallets.confirm_start(USER, DATE, version)
    assert wallets.reset(USER, DATE, "sim", 230000) == 230000


def test_reset_storage_failure_preserves_balance_and_history(db, monkeypatch):
    seed(db, "paper", DATE, 140000)
    monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: (_ for _ in ()).throw(RuntimeError("offline")))
    with pytest.raises(HTTPException) as error:
        wallets.reset(USER, DATE, "paper", 180000)
    assert error.value.status_code == 503
    assert paper_wallet.balance(USER, DATE) == 140000


def test_stopped_empty_paper_preparation_and_resume_use_updated_wallet(db, monkeypatch):
    from app.routers import desktop_trading as routes
    from app.services.desktop_auth_service import _access_token
    from app.routers import simulation as start_routes
    class Morning(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 9, 11, 0, tzinfo=tz)
    monkeypatch.setattr(routes, "datetime", Morning)
    today = DATE
    session_id = "empty-stopped-paper"
    token, _ = paper_wallet.claim_session(USER, today, "TATPOW")
    paper_wallet.finish_session_claim(USER, today, "TATPOW", token, session_id, desktop=True)
    paper_wallet.stop_desktop_session(USER, today, "TATPOW", session_id)
    paper_wallet.complete_desktop_cleanup(USER, today, "TATPOW", session_id)
    record = {"session_id": session_id, "user_id": USER, "symbol": "TATPOW", "date": today,
        "start_time": "09:15:00", "speed": Decimal("1"), "state": "ended", "instrument_type": "equity",
        "session_type": "paper", "wallet_ledger_id": f"paper:{today}", "session_capital": Decimal("150000"),
        "desktop_origin": "desktop_paper", "desktop_mode": "paper"}
    db.Table("Sessions").put_item(Item=record)
    db.create_table(TableName="Trades", KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": "trade_id", "KeyType": "RANGE"}], AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": "trade_id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
    assert wallets.reset(USER, today, "paper", 180000) == 180000
    monkeypatch.setattr("app.services.desktop_preparation.prepare", lambda *args: {"version": 1, "date": today, "reference_time": "11:00:00", "panes": []})
    client = TestClient(app)
    response = client.post("/api/desktop/v1/trading/prepare-session", headers={"Authorization": f"Bearer {_access_token(USER)[0]}"}, json={
        "mode": "paper", "date": today, "session_id": session_id, "panes": [{"id": "spot", "kind": "spot", "symbol": "TATPOW", "tradingDate": today, "interval": "3"}]})
    assert response.status_code == 200, response.text
    assert session_id not in simulation._sessions
    assert response.json()["date"] == today
    wrong = client.post("/api/desktop/v1/trading/prepare-session", headers={"Authorization": f"Bearer {_access_token('other')[0]}"}, json={
        "mode": "paper", "date": today, "session_id": session_id, "panes": [{"id": "spot", "kind": "spot", "symbol": "TATPOW", "tradingDate": today, "interval": "3"}]})
    assert wrong.status_code == 404
    monkeypatch.setattr(start_routes, "_ensure_session_data", lambda *args: None)
    monkeypatch.setattr(simulation, "find_session_by_context", lambda *args: record)
    monkeypatch.setattr(simulation, "start_session", lambda session: setattr(session, "state", simulation.SimulationState.RUNNING))
    async def no_renewal(session):
        return
    monkeypatch.setattr(start_routes, "_renew_paper_engine", no_renewal)
    resumed = client.post(f"/api/desktop/v1/trading/{session_id}/resume", headers={"X-User-Id": USER})
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["session"]["session_id"] == session_id
    assert resumed.json()["session"]["state"] == "running"
    assert resumed.json()["session"]["session_capital"] == 180000
    assert resumed.json()["wallet_balance"] == 180000
    assert resumed.json()["trades"] == []
    assert resumed.json()["open_orders"] == []


def test_paper_start_racing_reset_cannot_be_adopted_after_reset(db, monkeypatch):
    seed(db, "paper", DATE, 100000)
    original = __import__('app.services.db', fromlist=['get_dynamodb_client']).get_dynamodb_client()
    def transaction(**params):
        token, _ = paper_wallet.claim_session(USER, DATE, "NIFTY")
        original.transact_write_items(**params)
    monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: type("Client", (), {"transact_write_items": staticmethod(transaction)})())
    with pytest.raises(HTTPException) as error:
        wallets.reset(USER, DATE, "paper", 250000)
    assert error.value.status_code == 409
    assert paper_wallet.balance(USER, DATE) == 100000


def test_paper_reset_clears_expired_start_token_before_setting_new_amount(db):
    token, _ = paper_wallet.claim_session(USER, DATE, "NIFTY")
    db.Table("WalletLedgers").update_item(Key={"user_id": USER, "ledger_id": f"paper:{DATE}:session:NIFTY"}, UpdateExpression="SET claim_until=:old", ExpressionAttributeValues={":old": 1})
    assert wallets.reset(USER, DATE, "paper", 210000) == 210000
    with pytest.raises(HTTPException):
        paper_wallet.finish_session_claim(USER, DATE, "NIFTY", token, "late-start", desktop=True)
    assert paper_wallet.balance(USER, DATE) == 210000


def test_replay_recalculation_honors_reset_without_recharging_old_history(db):
    db.create_table(TableName="Trades", KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": "trade_id", "KeyType": "RANGE"}], AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": "trade_id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
    seed(db, "paper", DATE, 130000)
    seed(db, "real", DATE, 900000)
    wallets.reset(USER, DATE, "sim", 220000)
    reset_at = int(wallets.read(USER, DATE, "sim")["reset_at"])
    for sid, created_at, price in [("old", reset_at-1000, 100), ("new", reset_at+1000, 20)]:
        db.Table("Sessions").put_item(Item={"session_id": sid, "user_id": USER, "date": DATE, "session_type": "sim", "state": "ended", "instrument_type": "options", "created_at": created_at})
        db.Table("Trades").put_item(Item={"session_id": sid, "trade_id": "entry", "symbol": "NIFTY", "side": "BUY", "quantity": 65, "price": price, "timestamp": 1})
    assert wallet_service.recalculate_sim_ledger_for_date(USER, DATE) == 220000 - 20*65
    assert wallet_service.recalculate_sim_ledger_for_date(USER, DATE) == 220000 - 20*65
    assert wallets.read(USER, DATE, "paper")["current_balance"] == 130000
    assert wallets.read(USER, DATE, "real")["current_balance"] == 900000
    assert db.Table("Trades").scan()["Count"] == 2


def test_carry_forward_skips_paginated_paper_receipts_and_preserves_cash_pnl(db):
    previous = "2026-10-08"
    wallets.read(USER, previous, "paper")
    paper_wallet.move(USER, previous, -6500, "entry")
    paper_wallet.move(USER, previous, 7800, "exit")
    for index in range(60):
        db.Table("WalletLedgers").put_item(Item={"user_id": USER, "ledger_id": f"paper:{previous}:op:receipt-{index}", "delta": 0})
    assert wallets.read(USER, DATE, "paper")["current_balance"] == 151300
    assert wallets.read(USER, DATE, "sim")["current_balance"] == 150000


def test_replay_start_refreshes_balance_when_reset_wins_before_revision_claim(db, monkeypatch):
    wallets.read(USER, DATE, "sim")
    real_table = wallets.table()
    reset_done = False
    class InterleavedTable:
        def __getattr__(self, name):
            return getattr(real_table, name)
        def update_item(self, **params):
            nonlocal reset_done
            if params.get("ReturnValues") == "ALL_NEW" and not reset_done:
                reset_done = True
                wallets.reset(USER, DATE, "sim", 250000)
            return real_table.update_item(**params)
    monkeypatch.setattr(wallets, "table", lambda: InterleavedTable())
    version = wallets.begin_start(USER, DATE)
    wallets.confirm_start(USER, DATE, version)
    assert wallet_service.get_ledger_balance(USER, DATE, f"sim:{DATE}") == 250000


@pytest.mark.parametrize("override", [False, True])
def test_website_empty_stopped_paper_restarts_without_trades_or_erase(db, monkeypatch, override):
    from app.routers import simulation as routes
    class Morning(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 10, 9, 11, 0, tzinfo=tz)
    monkeypatch.setattr(routes, "datetime", Morning)
    sid = "website-empty-paper"
    token, _ = paper_wallet.claim_session(USER, DATE, "TATPOW")
    paper_wallet.finish_session_claim(USER, DATE, "TATPOW", token, sid)
    paper_wallet.renew_engine(USER, DATE, "TATPOW", token, stop=True)
    db.Table("Sessions").put_item(Item={"session_id": sid, "user_id": USER, "symbol": "TATPOW",
        "date": DATE, "start_time": "09:15:00", "speed": 1, "state": "ended",
        "session_type": "paper", "instrument_type": "equity", "wallet_ledger_id": f"paper:{DATE}",
        "session_capital": 150000})
    db.create_table(TableName="Trades", KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": "trade_id", "KeyType": "RANGE"}], AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": "trade_id", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST")
    db.create_table(TableName="Strategies", KeySchema=[{"AttributeName": "strategy_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "strategy_id", "AttributeType": "S"}, {"AttributeName": "session_id", "AttributeType": "S"}],
        GlobalSecondaryIndexes=[{"IndexName": "SessionIdIndex", "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}], BillingMode="PAY_PER_REQUEST")
    wallets.reset(USER, DATE, "paper", 190000)
    monkeypatch.setattr(routes, "_ensure_session_data", lambda *args: None)
    monkeypatch.setattr(simulation, "start_session", lambda session: setattr(session, "state", simulation.SimulationState.RUNNING))
    async def no_renewal(session):
        return
    monkeypatch.setattr(routes, "_renew_paper_engine", no_renewal)
    response = TestClient(app).post("/api/simulation/start", headers={"X-User-Id": USER}, json={
        "symbol": "TATPOW", "date": DATE, "session_type": "paper", "instrument_type": "equity", "override": override})
    assert response.status_code == 200, response.text
    assert response.json()["session_id"] == sid
    assert response.json()["session_capital"] == 190000
    assert simulation.get_session(sid).state == simulation.SimulationState.RUNNING
    assert db.Table("Trades").scan()["Count"] == 0
    assert db.Table("Sessions").get_item(Key={"session_id": sid})["Item"]["session_id"] == sid


def test_replay_recalculation_cannot_overwrite_concurrent_explicit_reset(db, monkeypatch):
    wallets.reset(USER, DATE, "sim", 220000)
    real_table = wallets.table()
    reset_done = False
    class InterleavedTable:
        def __getattr__(self, name):
            return getattr(real_table, name)
        def update_item(self, **params):
            nonlocal reset_done
            if params.get("UpdateExpression") == "SET current_balance = :balance" and not reset_done:
                reset_done = True
                wallets.reset(USER, DATE, "sim", 250000)
            return real_table.update_item(**params)
    monkeypatch.setattr(wallets, "table", lambda: InterleavedTable())
    with pytest.raises(HTTPException) as error:
        wallet_service.recalculate_sim_ledger_for_date(USER, DATE)
    assert error.value.status_code == 409
    assert wallets.read(USER, DATE, "sim")["current_balance"] == 250000
