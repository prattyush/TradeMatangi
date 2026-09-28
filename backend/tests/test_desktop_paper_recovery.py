import asyncio
from decimal import Decimal
from datetime import datetime
from types import SimpleNamespace

import boto3
from boto3.dynamodb.conditions import Key
from moto import mock_aws
import pytest
from fastapi import HTTPException

from app.models.schemas import Order, OrderStatus, TradeSide
from app.routers import desktop_trading
from app.services import desktop_paper_eod, order_service, paper_wallet, simulation, trading, wallet_service


@pytest.fixture
def database(monkeypatch):
    paper_wallet._ready_endpoints.clear()
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        client = boto3.client("dynamodb", region_name="ap-south-1")
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        monkeypatch.setattr(wallet_service, "get_or_init_wallet", lambda *args: 100_000)
        for name, hash_key, range_key in (("Sessions", "session_id", None),
            ("Orders", "session_id", "order_id"), ("Trades", "session_id", "trade_id"),
            ("Strategies", "session_id", "strategy_id")):
            names = [hash_key] + ([range_key] if range_key else [])
            resource.create_table(TableName=name,
                KeySchema=[{"AttributeName": hash_key, "KeyType": "HASH"}] +
                    ([{"AttributeName": range_key, "KeyType": "RANGE"}] if range_key else []),
                AttributeDefinitions=[{"AttributeName": value, "AttributeType": "S"} for value in names],
                BillingMode="PAY_PER_REQUEST")
        yield resource
    simulation._sessions.clear()
    order_service._orders.clear()
    trading._trades.clear()


def test_stop_without_local_engine_preserves_position_and_cancels_pending_order(database, monkeypatch):
    user, date, symbol, session_id = "desktop-user", "2026-09-28", "NIFTY", "saved-paper"
    monkeypatch.setattr("app.services.desktop_paper_eod._due", lambda _: False)
    paper_wallet.read(user, date)
    token, _ = paper_wallet.claim_session(user, date, symbol)
    paper_wallet.finish_session_claim(user, date, symbol, token, session_id, desktop=True)
    database.Table("Sessions").put_item(Item={"session_id": session_id, "user_id": user,
        "date": date, "symbol": symbol, "start_time": "09:15:00", "speed": Decimal("1"),
        "state": "running", "session_capital": Decimal("100000"), "instrument_type": "options",
        "session_type": "paper", "wallet_ledger_id": f"paper:{date}", "desktop_origin": "desktop_paper",
        "desktop_mode": "paper", "strike": 22950, "strike_ce": 22950, "strike_pe": 22800,
        "expiry": "2026-09-29", "right": None,
        "desktop_contracts": [{"symbol": symbol, "expiry": "2026-09-29", "strike": 22950,
            "right": "CE", "contract_key": "NIFTY:2026-09-29:22950:CE"}]})
    database.Table("Trades").put_item(Item={"session_id": session_id, "trade_id": "entry",
        "user_id": user, "symbol": symbol, "side": "BUY", "quantity": 65,
        "price": Decimal("100"), "timestamp": 1790673000, "instrument_type": "options",
        "strike": 22950, "expiry": "2026-09-29", "right": "CE", "commission": Decimal("1"),
        "session_type": "paper", "source": "desktop_paper"})
    pending = Order(session_id=session_id, user_id=user, symbol=symbol, side=TradeSide.BUY,
        quantity=65, trigger_price=90, limit_price=90, created_at=1790673001,
        reserved_amount=5850, wallet_ledger_id=f"paper:{date}", wallet_ledger_kind="paper",
        right="CE", strike=22950, expiry="2026-09-29", source="desktop_paper")
    paper_wallet.move(user, date, -5850, f"order:{pending.order_id}:reserve", order=pending,
        engine=(session_id, symbol, token))

    assert asyncio.run(desktop_trading.stop_stepwise(session_id, user_id=user)) == {"status": "stopped"}
    assert asyncio.run(desktop_trading.stop_stepwise(session_id, user_id=user)) == {"status": "stopped"}
    saved = database.Table("Orders").get_item(Key={"session_id": session_id, "order_id": pending.order_id})["Item"]
    assert saved["status"] == OrderStatus.CANCELLED.value
    assert paper_wallet.balance(user, date) == 100_000
    assert len(database.Table("Trades").query(KeyConditionExpression=Key("session_id").eq(session_id))["Items"]) == 1
    assert paper_wallet.session_claim(user, date, symbol)["cleanup_pending"] is False


def test_stopped_session_settles_each_option_once_when_close_quotes_arrive(database, monkeypatch):
    user, date, symbol, session_id = "desktop-user", "2026-09-28", "NIFTY", "saved-eod"
    paper_wallet.read(user, date)
    token, _ = paper_wallet.claim_session(user, date, symbol)
    paper_wallet.finish_session_claim(user, date, symbol, token, session_id, desktop=True)
    record = {"session_id": session_id, "user_id": user, "date": date, "symbol": symbol,
        "start_time": "09:15:00", "speed": Decimal("1"), "state": "ended",
        "session_capital": Decimal("100000"), "instrument_type": "options", "session_type": "paper",
        "wallet_ledger_id": f"paper:{date}", "desktop_origin": "desktop_paper", "desktop_mode": "paper",
        "strike": 22950, "strike_ce": 22950, "strike_pe": 22800, "expiry": "2026-09-29"}
    database.Table("Sessions").put_item(Item=record)
    for right, strike, price in (("CE", 22950, 100), ("PE", 22800, 80)):
        database.Table("Trades").put_item(Item={"session_id": session_id, "trade_id": f"entry-{right}",
            "user_id": user, "symbol": symbol, "side": "BUY", "quantity": 65,
            "price": Decimal(price), "timestamp": desktop_paper_eod._clock(date, "10:00:00"),
            "instrument_type": "options", "strike": strike, "expiry": "2026-09-29",
            "right": right, "commission": Decimal("1"), "session_type": "paper", "source": "desktop_paper"})
    paper_wallet.move(user, date, -(100 + 80) * 65, "entries")
    paper_wallet.stop_desktop_session(user, date, symbol, session_id)
    monkeypatch.setattr(desktop_paper_eod, "_due", lambda _: True)
    monkeypatch.setattr(desktop_paper_eod, "_near_close_quote", lambda session, s, right, strike, expiry: None)
    assert desktop_paper_eod.reconcile_session(record) is False
    assert paper_wallet.session_claim(user, date, symbol)["settlement_pending"] is True
    assert len(database.Table("Trades").query(KeyConditionExpression=Key("session_id").eq(session_id))["Items"]) == 2

    database.Table("WalletLedgers").update_item(Key={"user_id": user, "ledger_id": f"paper:{date}:session:{symbol}"},
        UpdateExpression="SET settlement_retry_after = :zero", ExpressionAttributeValues={":zero": 0})
    def close_quote(session, s, right, strike, expiry):
        return {"price": Decimal("120") if right == "CE" else Decimal("70"),
            "timestamp": desktop_paper_eod._clock(date, "15:09:00"), "source": "historical_close",
            "right": right, "strike": strike, "expiry": expiry}
    monkeypatch.setattr(desktop_paper_eod, "_near_close_quote", close_quote)
    assert desktop_paper_eod.reconcile_session(record) is True
    assert desktop_paper_eod.reconcile_session(record) is True
    assert paper_wallet.session_claim(user, date, symbol)["session_status"] == "settled"
    assert paper_wallet.balance(user, date) == 100_650
    trades = database.Table("Trades").query(KeyConditionExpression=Key("session_id").eq(session_id))["Items"]
    exits = {item["right"]: float(item["price"]) for item in trades if item["side"] == "SELL"}
    assert exits == {"CE": 120, "PE": 70}


def test_resume_reuses_selected_session_id_only_on_trading_date(monkeypatch):
    class TradingMorning(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 28, 10, 0, tzinfo=tz)

    monkeypatch.setattr(desktop_trading, "datetime", TradingMorning)
    record = {"session_id": "same-id", "user_id": "desktop-user", "date": "2026-09-28",
        "symbol": "NIFTY", "instrument_type": "equity", "start_time": "09:15:00"}
    claim = {"session_status": "stopped", "cleanup_pending": False}
    monkeypatch.setattr(desktop_trading, "_saved_desktop_paper", lambda *args: (record, claim))
    monkeypatch.setattr(desktop_trading, "_reconcile_saved_paper", lambda *args: claim)
    monkeypatch.setattr(desktop_trading, "_require_session", lambda *args: SimpleNamespace())
    monkeypatch.setattr(desktop_trading, "_snapshot", lambda *args: "saved-snapshot")
    calls = []
    async def start(request, user_id, **kwargs):
        calls.append((request.symbol, request.session_type, user_id, kwargs))
        return SimpleNamespace(session_id="same-id")
    monkeypatch.setattr(desktop_trading.simulation_router, "start_with_paper_claim", start)

    assert asyncio.run(desktop_trading.resume_desktop_paper("same-id", user_id="desktop-user")) == "saved-snapshot"
    assert calls[0][1] == "paper"
    assert calls[0][3]["resume_session_id"] == "same-id"
    record["date"] = "2026-09-27"
    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.resume_desktop_paper("same-id", user_id="desktop-user"))
    assert exc.value.status_code == 409


def test_resume_keeps_saved_guardrail_restriction_before_first_write(database, monkeypatch):
    user, date, symbol, session_id = "desktop-user", "2026-09-28", "NIFTY", "guarded-paper"
    record = {"session_id": session_id, "user_id": user, "date": date, "symbol": symbol,
        "start_time": "09:15:00", "speed": Decimal("1"), "state": "ended",
        "session_capital": Decimal("100000"), "instrument_type": "equity",
        "session_type": "paper", "wallet_ledger_id": f"paper:{date}",
        "desktop_origin": "desktop_paper", "desktop_mode": "paper",
        "desktop_guardrail_state": {"ban_active": True, "block_until_bar": 12345,
            "consecutive_losses": 2, "cooldown_trips_seen": 1,
            "last_type": "BAN", "last_reason": "daily limit"}}
    database.Table("Sessions").put_item(Item=record)
    monkeypatch.setattr("app.services.guardrail_service.initialize_guardrails", lambda session, _: setattr(session, "guardrail_ban_active", False))

    session = simulation.rebuild_session_from_db(record, user)

    assert session.guardrail_ban_active is True
    assert session.guardrail_block_until_bar == 12345
    assert session.guardrail_consecutive_losses == 2
    saved = database.Table("Sessions").get_item(Key={"session_id": session_id})["Item"]
    assert saved["desktop_guardrail_state"] == record["desktop_guardrail_state"]
