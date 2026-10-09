import asyncio
import json
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
        monkeypatch.setattr(wallet_service, "DEFAULT_BALANCE", 100_000)
        for name, hash_key, range_key in (("Sessions", "session_id", None),
            ("Orders", "session_id", "order_id"), ("Trades", "session_id", "trade_id")):
            names = [hash_key] + ([range_key] if range_key else [])
            resource.create_table(TableName=name,
                KeySchema=[{"AttributeName": hash_key, "KeyType": "HASH"}] +
                    ([{"AttributeName": range_key, "KeyType": "RANGE"}] if range_key else []),
                AttributeDefinitions=[{"AttributeName": value, "AttributeType": "S"} for value in names],
                BillingMode="PAY_PER_REQUEST")
        resource.create_table(TableName="Strategies",
            KeySchema=[{"AttributeName": "strategy_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "strategy_id", "AttributeType": "S"},
                {"AttributeName": "session_id", "AttributeType": "S"}],
            GlobalSecondaryIndexes=[{"IndexName": "SessionIdIndex",
                "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"}}], BillingMode="PAY_PER_REQUEST")
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
    database.Table("Strategies").put_item(Item={"strategy_id": "auto-stop", "session_id": session_id,
        "user_id": user, "symbol": symbol, "status": "RUNNING"})
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
    assert database.Table("Strategies").get_item(Key={"strategy_id": "auto-stop"})["Item"]["status"] == "CANCELLED"
    assert paper_wallet.session_claim(user, date, symbol)["cleanup_pending"] is False
    candidate = asyncio.run(desktop_trading.candidate(symbol, date, "options", desktop_mode="paper", user_id=user))
    assert candidate.status == "stopped"
    assert candidate.stopped.cleanup_pending is False


def test_stop_remains_stopped_when_cleanup_fails_then_retries(database, monkeypatch, caplog):
    user, date, symbol, session_id = "desktop-user", "2026-09-28", "NIFTY", "cleanup-retry"
    monkeypatch.setattr(desktop_paper_eod, "_due", lambda _: False)
    paper_wallet.read(user, date)
    token, _ = paper_wallet.claim_session(user, date, symbol)
    paper_wallet.finish_session_claim(user, date, symbol, token, session_id, desktop=True)
    database.Table("Sessions").put_item(Item={"session_id": session_id, "user_id": user,
        "date": date, "symbol": symbol, "start_time": "09:15:00", "speed": Decimal("1"),
        "state": "running", "session_capital": Decimal("100000"), "instrument_type": "equity",
        "session_type": "paper", "wallet_ledger_id": f"paper:{date}",
        "desktop_origin": "desktop_paper", "desktop_mode": "paper"})
    cancel = order_service.cancel_all_pending_orders

    def fail_cleanup(*args):
        raise RuntimeError("temporary cleanup failure")

    monkeypatch.setattr(order_service, "cancel_all_pending_orders", fail_cleanup)
    assert asyncio.run(desktop_trading.stop_stepwise(session_id, user_id=user)) == {"status": "stopped"}
    assert paper_wallet.session_claim(user, date, symbol)["cleanup_pending"] is True
    stopped = asyncio.run(desktop_trading.snapshot(session_id, user_id=user))
    assert stopped.session.state == simulation.SimulationState.ENDED
    assert stopped.cleanup_pending is True
    assert "desktop_paper_cleanup_failed session_id=cleanup-retry" in caplog.text

    monkeypatch.setattr(order_service, "cancel_all_pending_orders", cancel)
    assert asyncio.run(desktop_trading.stop_stepwise(session_id, user_id=user)) == {"status": "stopped"}
    assert asyncio.run(desktop_trading.snapshot(session_id, user_id=user)).cleanup_pending is False


def test_resumed_paper_option_tick_serializes_saved_contract_numbers(database, monkeypatch):
    user, date, symbol, session_id = "desktop-user", "2026-09-29", "NIFTY", "resumed-tick"
    contract = {"symbol": symbol, "expiry": date, "strike": Decimal("22750"),
        "right": "CE", "contract_key": f"{symbol}:{date}:22750:CE"}
    record = {"session_id": session_id, "user_id": user, "date": date,
        "symbol": symbol, "start_time": "09:15:00", "speed": Decimal("1"),
        "state": "ended", "session_capital": Decimal("100000"),
        "instrument_type": "options", "session_type": "paper",
        "wallet_ledger_id": f"paper:{date}", "desktop_origin": "desktop_paper",
        "desktop_mode": "paper", "strike": Decimal("22700"),
        "strike_ce": Decimal("22750"), "strike_pe": Decimal("22500"),
        "expiry": date, "desktop_contracts": [contract]}
    paper_wallet.read(user, date)
    session = simulation.rebuild_session_from_db(record, user, read_only=True)
    assert session.desktop_contracts[0]["strike"] == 22750
    assert type(session.desktop_contracts[0]["strike"]) is int
    session.paper_stream_source = "breeze"
    session.paper_base_contracts = {"CE": {"strike": 22750, "expiry": date}}
    monkeypatch.setattr(simulation, "_auto_close_positions_if_eod", lambda *args: [])

    simulation._emit_tick_and_check_orders(session, {"time": 1790676000,
        "open": 23.4, "high": 23.4, "low": 23.4, "close": 23.4,
        "volume": Decimal("1.5")}, "CE")

    tick = json.loads(session.queue.get_nowait())
    assert tick["strike"] == 22750
    assert tick["volume"] == 1.5
    assert tick["session_id"] == session_id


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


@pytest.mark.parametrize("right", ["CE", "PE"])
@pytest.mark.parametrize("sizing", ["quantity", "capital", "risk"])
def test_desktop_paper_market_persists_analytics_fills_and_refunds_once(database, monkeypatch, right, sizing):
    from app.models.schemas import SimulationState, TradeSide
    user, date, symbol = "paper-analytics-user", "2026-09-28", "NIFTY"
    session_id = f"paper-market-{right}-{sizing}"
    expiry = "2026-09-29"
    now = int(datetime(2026, 9, 28, 10).timestamp())
    paper_wallet.read(user, date)
    token, _ = paper_wallet.claim_session(user, date, symbol)
    paper_wallet.finish_session_claim(user, date, symbol, token, session_id, desktop=True)
    session = simulation.SimulationSession(session_id=session_id, user_id=user, symbol=symbol,
        date=date, start_time="10:00:00", speed=1, session_type="paper",
        instrument_type="options", strike=22950, strike_ce=22950, strike_pe=22950,
        expiry=expiry, wallet_ledger_id=f"paper:{date}", session_capital=100000)
    session.current_time = str(now)
    session.last_price = 23000
    session.state = SimulationState.RUNNING
    session.desktop_origin = "desktop_paper"
    session.desktop_mode = "paper"
    session.paper_engine_token = token
    session.paper_engine_valid_until = __import__('time').monotonic() + 40
    contract = {"symbol": symbol, "expiry": expiry, "strike": 22950, "right": right,
        "contract_key": f"{symbol}:{expiry}:22950:{right}"}
    session.desktop_contracts = [contract]
    simulation._sessions[session_id] = session
    monkeypatch.setattr(desktop_trading, "_paper_chart_quote", lambda *args: {**contract,
        "price": 100., "timestamp": now, "source": "desktop_live_chart"})
    monkeypatch.setattr(desktop_trading, "_historical_context_trades", lambda *args: [])
    monkeypatch.setattr("app.services.user_settings_service.get_settings", lambda *args, **kwargs: {
        "target_deviation_pct": .01, "default_sl_pct": .2, "entry_auto_sl_enabled": True})
    monkeypatch.setattr(desktop_trading, "get_settings", lambda *args: {"target_deviation_pct": .01})
    allocation = {"quantity": 65} if sizing == "quantity" else {"funds_ratio_pct": .1} if sizing == "capital" else {"risk_pct": 1.}
    order = asyncio.run(desktop_trading.place_chart_order(session_id,
        desktop_trading.ChartOrderIntent(symbol=symbol, expiry=expiry, strike=22950,
            right=right, side=TradeSide.BUY, intent="market", entry_sl_price=80,
            group_id=f"paper-{right}-{sizing}", **allocation), user))
    assert order.status == OrderStatus.FILLED
    assert order.filled_price == 100
    saved = database.Table("Orders").get_item(Key={"session_id": session_id, "order_id": order.order_id})["Item"]
    assert saved["analytics"]["entry_method"] == "MARKET"
    assert saved["analytics"]["capital"] == Decimal("100000")
    assert saved["status"] == "FILLED"
    assert paper_wallet.fill_recorded(user, date, order.order_id)
    assert paper_wallet.balance(user, date) == pytest.approx(100000 - order.quantity * 100)
    records = database.Table("Trades").query(KeyConditionExpression=Key("session_id").eq(session_id))["Items"]
    assert len(records) == 1
    assert (records[0]["right"], records[0]["strike"], records[0]["price"]) == (right, 22950, Decimal("100"))
    position = trading.get_position(session_id, symbol, right, strike=22950, expiry=expiry)
    assert position.quantity == order.quantity
    stops = [item for item in order_service.get_open_orders(session_id) if item.is_stoploss]
    assert len(stops) == 1
    assert (stops[0].right, stops[0].strike, stops[0].quantity) == (right, 22950, order.quantity)
    # Replaying the committed reserve receipt does not double debit/rewrite a fill.
    current = paper_wallet.balance(user, date)
    paper_wallet.move(user, date, -order.quantity * 101, f"order:{order.order_id}:reserve", order=order,
        engine=(session_id, symbol, token))
    assert paper_wallet.balance(user, date) == current
    assert database.Table("Orders").get_item(Key={"session_id": session_id, "order_id": order.order_id})["Item"]["status"] == "FILLED"
