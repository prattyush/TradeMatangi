# ruff: noqa: F811
import time
from types import SimpleNamespace

import pytest
from app.services import real_session_slots as slots
from app.services import real_sessions, simulation
from app.services import swing_funding_store as funding
from botocore.exceptions import ClientError
from fastapi import HTTPException

from tests.test_swing_portfolio_store import db  # noqa: F401


def record(sid="book", **extra):
    return {
        "session_id": sid,
        "user_id": "u",
        "session_type": "real",
        "symbol": "HDFCBANK",
        "instrument_type": "equity",
        "execution_broker": "kite",
        "broker_account_id": "account",
        "date": "2026-10-11",
        "state": "running",
        **extra,
    }


def test_legacy_records_without_record_type_are_adopted_with_the_existing_lease(db):
    db.Table("Sessions").put_item(Item=record())
    db.Table("WalletLedgers").put_item(
        Item={
            "user_id": "u",
            "ledger_id": "real-active",
            "session_id": "book",
            "state": "running",
            "operation_id": "legacy-token",
            "engine_until": int(time.time()) + 100,
        }
    )
    real_sessions._adopt_legacy()
    slot = slots.read("kite", "account", "intraday")
    assert slot["session_id"] == "book"
    assert slot["operation_id"] == "legacy-token"
    assert slot["engine_until"] > int(time.time())


def test_stopped_engine_record_still_owned_by_legacy_pointer_is_not_discarded(db):
    db.Table("Sessions").put_item(Item=record(state="ended"))
    db.Table("WalletLedgers").put_item(
        Item={
            "user_id": "u",
            "ledger_id": "real-active",
            "session_id": "book",
            "state": "running",
            "operation_id": "legacy-token",
            "engine_until": 0,
        }
    )
    real_sessions._adopt_legacy()
    assert slots.for_user("u")[0]["session_id"] == "book"


def test_slot_and_preparation_creation_roll_back_together_on_duplicate_identity(db):
    db.Table("Sessions").put_item(Item=record())
    with pytest.raises(HTTPException):
        slots.claim(
            "u", "kite", "account", "intraday", "book", "token", record=record()
        )
    assert slots.read("kite", "account", "intraday") is None
    assert slots.for_user("u") == []


def test_stale_engine_cannot_overwrite_recovered_book(db):
    slots.claim("u", "kite", "account", "intraday", "book", "old", record=record())
    db.Table("WalletLedgers").update_item(
        Key=slots.key("kite", "account", "intraday"),
        UpdateExpression="SET engine_until = :zero",
        ExpressionAttributeValues={":zero": 0},
    )
    slots.claim("u", "kite", "account", "intraday", "book", "new")
    stale = simulation.SimulationSession(
        "book",
        "HDFCBANK",
        "2026-10-11",
        "09:15:00",
        1,
        user_id="u",
        session_type="real",
        execution_broker="kite",
        broker_account_id="account",
    )
    stale.real_claim_token = "old"
    with pytest.raises(ClientError):
        simulation._upsert_session_to_db(stale, strict=True)
    assert (
        db.Table("Sessions").get_item(Key={"session_id": "book"})["Item"]["state"]
        == "running"
    )


def test_completion_is_atomic_with_funding_and_release(db):
    slots.claim(
        "u",
        "kite",
        "account",
        "intraday",
        "book",
        "token",
        record=record(state="closing"),
    )
    row = funding.initialize("u", "kite", "account", 100000)
    funding.start_participant(
        "u", "kite", "account", row["period_id"], "intraday", "book", 1
    )
    session = SimpleNamespace(
        user_id="u",
        session_id="book",
        execution_broker="kite",
        broker_account_id="account",
        real_claim_token="wrong",
        real_funding_period=row["period_id"],
    )
    with pytest.raises(ClientError):
        real_sessions.release(session)
    assert funding.read("u", "kite", "account")["participants"]["intraday"]["active"]
    assert (
        db.Table("Sessions").get_item(Key={"session_id": "book"})["Item"]["state"]
        == "closing"
    )
    session.real_claim_token = "token"
    real_sessions.release(session)
    assert slots.read("kite", "account", "intraday") is None
    assert not funding.read("u", "kite", "account")["participants"]["intraday"][
        "active"
    ]
    assert db.Table("Sessions").get_item(Key={"session_id": "book"})["Item"][
        "real_verified_closed"
    ]


def test_replacement_day_book_excludes_previous_fills_and_keeps_same_second_owned_fills(
    monkeypatch,
):
    from app.models.schemas import Order, TradeSide
    from app.services import order_service, real_broker_state

    session = SimpleNamespace(
        user_id="u",
        session_id="new",
        symbol="HDFCBANK",
        instrument_type="equity",
        execution_broker="kite",
        real_funding_period="period",
        date="2026-10-11",
        created_at=100000,
    )
    owned = Order(
        session_id="new",
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        quantity=1,
        trigger_price=100,
        limit_price=100,
        created_at=19900,
        broker_order_id="own",
    )
    monkeypatch.setattr(order_service, "get_all_orders", lambda sid: [owned])
    base = {
        "symbol": "HDFCBANK",
        "product": "MIS",
        "status": "complete",
        "order_time": "",
    }
    orders = [
        {**base, "broker_order_id": value} for value in ("previous", "own", "manual")
    ]
    fills = [
        {**base, "broker_order_id": value, "timestamp": stamp}
        for value, stamp in [("previous", 19900), ("own", 19900), ("manual", 19901)]
    ]
    result_orders, result_fills = real_broker_state.book_reports(session, orders, fills)
    assert {r["broker_order_id"] for r in result_fills} == {"own", "manual"}
    assert {r["broker_order_id"] for r in result_orders} == {"own", "manual"}


def test_funding_admission_cannot_reopen_a_concurrently_closed_swing_book(db):
    from app.services import swing_portfolio_store as portfolios
    parent = portfolios.create('u', 'real', 100000, broker='kite', account='account')
    pool = funding.initialize('u', 'kite', 'account', 100000)
    portfolios.update('u', parent['session_id'], {'state': 'closing'}, parent['version'])
    portfolios.finish_verified_close('u', parent['session_id'])
    with pytest.raises(HTTPException):
        funding.start_participant('u', 'kite', 'account', pool['period_id'], 'swing', parent['session_id'], 1,
                                  session_record_id=parent['session_id'])
    assert funding.read('u', 'kite', 'account')['participants'] == {}
    ended = portfolios.owned('u', parent['session_id'])
    assert ended['state'] == 'ended' and not ended.get('real_funding_period')


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["closing", "done"])
async def test_restart_resumes_day_closure_instead_of_starting_entries(
    db, monkeypatch, status
):
    import asyncio
    from unittest.mock import AsyncMock, MagicMock

    from app.routers import simulation as routes
    from app.services import real_close
    from app.services import real_trading_day as day

    saved = record(date="2026-10-13")
    db.Table("Sessions").put_item(Item=saved)
    row = {
        "session_id": "book",
        "owner_user_id": "u",
        "style": "intraday",
        "state": "running",
        "engine_until": 0,
    }
    monkeypatch.setattr(real_sessions, "_ready", True)
    monkeypatch.setattr(real_sessions, "_outstanding", lambda: [row])
    monkeypatch.setattr(simulation, "get_session", lambda *_: None)
    monkeypatch.setattr(day, "market_date", lambda: "2026-10-13")
    monkeypatch.setattr(
        day, "state", lambda *_: {"date": "2026-10-13", "state": status}
    )
    restored = SimpleNamespace(session_id="book")
    restore = AsyncMock(return_value=restored)
    close = AsyncMock()
    start = AsyncMock()
    monkeypatch.setattr(real_sessions, "restore_for_close", restore)
    monkeypatch.setattr(real_close, "close", close)
    monkeypatch.setattr(routes, "start_with_paper_claim", start)
    monitor = MagicMock()
    monkeypatch.setattr(day, "monitor", monitor)

    async def stop(*_):
        raise asyncio.CancelledError()

    monkeypatch.setattr(real_sessions.asyncio, "sleep", stop)
    with pytest.raises(asyncio.CancelledError):
        await real_sessions._recover_outstanding()
    restore.assert_awaited_once_with(saved, "u")
    close.assert_awaited_once_with(restored)
    start.assert_not_called()
    assert monitor.call_count == (1 if status == "closing" else 0)


@pytest.mark.asyncio
async def test_confirmed_day_completion_releases_shared_kotak_account_for_next_user(
    db, monkeypatch
):
    from unittest.mock import AsyncMock

    from app.models.schemas import Position
    from app.services import (
        emergency_exit,
        execution_broker,
        order_service,
        real_broker_state,
        real_close,
        trading,
    )
    from app.services import real_trading_day as day

    date = "2026-10-13"
    saved = record("kotak-book", execution_broker="kotak", date=date)
    slots.claim(
        "u", "kotak", "account", "intraday", "kotak-book", "token", record=saved
    )
    pool = funding.initialize("u", "kotak", "account", 100000)
    funding.start_participant(
        "u", "kotak", "account", pool["period_id"], "intraday", "kotak-book", 1
    )
    session = simulation.SimulationSession(
        session_id="kotak-book",
        symbol="HDFCBANK",
        date=date,
        start_time="09:15:00",
        speed=1,
        user_id="u",
        session_type="real",
        execution_broker="kotak",
        broker_account_id="account",
    )
    session.real_active_claim = True
    session.real_claim_token = "token"
    session.real_funding_period = pool["period_id"]
    monkeypatch.setattr(simulation, "_sessions", {session.session_id: session})
    monkeypatch.setattr(day, "market_date", lambda: date)
    monkeypatch.setattr(day, "table", lambda: db.Table("WalletLedgers"))
    monkeypatch.setattr(day, "broadcast", lambda *_: None)
    monkeypatch.setattr(execution_broker, "get_service", lambda *_: object())
    monkeypatch.setattr(real_broker_state, "refresh", AsyncMock())
    monkeypatch.setattr(
        emergency_exit,
        "position",
        lambda *_: Position(
            symbol=session.symbol, side="FLAT", quantity=0, avg_entry_price=0
        ),
    )
    monkeypatch.setattr(trading, "get_trades", lambda *_: [])
    monkeypatch.setattr(order_service, "get_open_orders", lambda *_: [])
    monkeypatch.setattr(real_close, "unresolved", lambda *_: False)
    monkeypatch.setattr(
        simulation,
        "stop_session",
        lambda s, **_: setattr(s, "state", simulation.SimulationState.ENDED),
    )
    monkeypatch.setattr(
        "app.services.broker_order_service.refresh_account_peers", lambda *_: None
    )
    day._terminal.discard(("u", date))
    day.begin("u")
    await day.complete_when_flat("u")
    assert day.state("u")["state"] == "done"
    assert slots.read("kotak", "account", "intraday") is None
    assert not funding.read("u", "kotak", "account")["participants"]["intraday"][
        "active"
    ]
    slots.claim(
        "next-user", "kotak", "account", "intraday", "desktop-book", "next-token"
    )
    assert slots.read("kotak", "account", "intraday")["owner_user_id"] == "next-user"
    day._terminal.discard(("u", date))
