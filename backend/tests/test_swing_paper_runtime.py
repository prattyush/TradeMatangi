from datetime import datetime, timezone
import boto3
from moto import mock_aws
import pytest
from app.models.schemas import TradeSide, OrderType, OrderStatus
from app.services import (
    swing_portfolio_store as store,
    swing_portfolio_service as service,
)
from app.services import simulation, order_service, trading


@pytest.fixture
def db(monkeypatch):
    with mock_aws():
        resource = boto3.resource("dynamodb", region_name="ap-south-1")
        client = boto3.client("dynamodb", region_name="ap-south-1")
        for name, keys in [
            ("WalletLedgers", ["user_id", "ledger_id"]),
            ("Sessions", ["session_id"]),
            ("Orders", ["session_id", "order_id"]),
            ("Trades", ["session_id", "trade_id"]),
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
        monkeypatch.setattr(simulation, "_sessions", {})
        monkeypatch.setattr(order_service, "_orders", {})
        monkeypatch.setattr(trading, "_trades", {})
        monkeypatch.setattr(service, "_runtimes", {})
        monkeypatch.setattr(
            "app.services.guardrail_service.on_trade_record", lambda *a: None
        )
        monkeypatch.setattr(
            order_service, "request_exit_reconciliation", lambda *a, **k: None
        )
        monkeypatch.setattr(
            "app.services.entry_sl_watcher.on_entry_filled", lambda *a, **k: None
        )
        monkeypatch.setattr(
            "app.services.swing_paper_recovery.observations", lambda *a: []
        )
        monkeypatch.setattr(
            "app.services.breeze_master.listed_option_contract",
            lambda symbol, strike, expiry, right: {
                "strike": strike,
                "expiry": expiry,
                "right": right,
                "lot_size": 10,
            },
        )
        yield resource


def tick(date, price):
    stamp = int(
        datetime.fromisoformat(date + "T15:00:00")
        .replace(tzinfo=timezone.utc)
        .timestamp()
    )
    return {
        "type": "tick",
        "time": stamp,
        "open": price,
        "high": price,
        "low": price,
        "close": price,
    }


def entry(child, price, qty=10):
    return order_service.place_order(
        child.session_id,
        child.symbol,
        TradeSide.BUY,
        OrderType.LIMIT,
        qty,
        1,
        child.date,
        limit_price=price,
        user_id=child.user_id,
        margin_rate=1,
        wallet_ledger_id=child.wallet_ledger_id,
        wallet_ledger_kind="paper",
    )


@pytest.mark.asyncio
async def test_multi_symbol_positions_and_cash_survive_day_boundary(db):
    parent = store.create("u", "paper", 100000)
    first = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    second = service.attach_context("u", parent["session_id"], "INFY", subscribe=False)
    order = entry(first, 100)
    current = service.runtime("u", parent["session_id"])
    await service.on_tick(current, first, tick("2026-11-02", 100))
    await service.on_tick(current, second, tick("2026-11-02", 200))
    assert order.status == OrderStatus.FILLED
    await service.on_tick(current, first, tick("2026-11-03", 110))
    snapshot = service.snapshot("u", parent["session_id"])
    assert len(snapshot["contexts"]) == 2
    assert snapshot["positions"][0]["quantity"] == 10
    assert first.date == "2026-11-03"
    assert snapshot["portfolio"]["date"] == parent["date"]
    assert (
        snapshot["wallet_balance"] < 99000
    )  # Full purchase value plus actual paper fee.
    assert snapshot["pnl"] > 0
    assert snapshot["trades"][0]["trading_style"] == "swing"


@pytest.mark.asyncio
async def test_pause_blocks_pending_entries_but_allows_position_exit(db):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    current = service.runtime("u", parent["session_id"])
    entry(child, 100)
    await service.on_tick(current, child, tick("2026-11-02", 100))
    pending = entry(child, 90, 1)
    store.pause_entries("u", parent["session_id"], True)
    with pytest.raises(Exception):
        entry(child, 90, 1)
    exit_order = order_service.place_order(
        child.session_id,
        child.symbol,
        TradeSide.SELL,
        OrderType.LIMIT,
        10,
        2,
        child.date,
        limit_price=90,
        user_id="u",
        margin_rate=1,
        wallet_ledger_id=child.wallet_ledger_id,
        wallet_ledger_kind="paper",
    )
    await service.on_tick(current, child, tick("2026-11-03", 90))
    assert pending.status == OrderStatus.PENDING
    assert exit_order.status == OrderStatus.FILLED
    assert not service.snapshot("u", parent["session_id"])["positions"]


@pytest.mark.asyncio
async def test_shared_loss_guard_runs_before_a_pending_entry_and_reset_preserves_history(
    db,
):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    current = service.runtime("u", parent["session_id"])
    entry(child, 100)
    await service.on_tick(current, child, tick("2026-11-02", 100))
    pending = entry(child, 90, 1)
    row = store.owned("u", parent["session_id"])
    store.update("u", parent["session_id"], {"loss_limit_pct": 0.001}, row["version"])
    await service.on_tick(current, child, tick("2026-11-03", 90))
    assert pending.status == OrderStatus.PENDING
    assert store.owned("u", parent["session_id"])["guardrail_ban"]
    pnl = service.snapshot("u", parent["session_id"])["pnl"]
    store.reset_guardrail_reference("u", parent["session_id"], 100000, pnl)
    assert len(trading.get_trades(child.session_id)) == 1
    assert not store.owned("u", parent["session_id"])["guardrail_ban"]


@pytest.mark.asyncio
async def test_expiry_quote_closes_paper_option_without_closing_equity_context(db):
    parent = store.create("u", "paper", 100000)
    option = service.attach_context(
        "u",
        parent["session_id"],
        "CANBK",
        "options",
        125.5,
        "2026-11-03",
        "CE",
        subscribe=False,
    )
    equity = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    order_service.place_order(
        option.session_id,
        option.symbol,
        TradeSide.BUY,
        OrderType.LIMIT,
        10,
        1,
        option.date,
        limit_price=10,
        right="CE",
        strike=125.5,
        expiry="2026-11-03",
        user_id="u",
        wallet_ledger_id=option.wallet_ledger_id,
        wallet_ledger_kind="paper",
    )
    current = service.runtime("u", parent["session_id"])
    quote = {
        **tick("2026-11-02", 10),
        "right": "CE",
        "strike": 125.5,
        "expiry": "2026-11-03",
    }
    await service.on_tick(current, option, quote)
    assert (
        trading.get_position(
            option.session_id, option.symbol, "CE", 125.5, "2026-11-03"
        ).quantity
        == 10
    )
    await service.on_tick(
        current,
        option,
        {
            **tick("2026-11-03", 8),
            "time": tick("2026-11-03", 8)["time"] + 900,
            "right": "CE",
            "strike": 125.5,
            "expiry": "2026-11-03",
        },
    )
    assert not service.snapshot("u", parent["session_id"])["positions"]
    assert store.owned("u", parent["session_id"])["state"] == "running"
    assert equity.state.value == "running"


@pytest.mark.asyncio
async def test_ending_one_swing_book_does_not_release_another_users_slot(db):
    first = store.create("u", "paper", 100000)
    other = store.create("other", "paper", 100000)
    row = store.owned("u", first["session_id"])
    store.update("u", first["session_id"], {"state": "closing"}, row["version"])
    store.finish_verified_close("u", first["session_id"])
    assert store.active("u", "paper") is None
    assert store.active("other", "paper")["session_id"] == other["session_id"]


@pytest.mark.asyncio
async def test_restart_restores_pending_orders_and_repairs_committed_fill_once(
    db, monkeypatch
):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    current = service.runtime("u", parent["session_id"])
    filled = entry(child, 100)
    pending = entry(child, 90, 1)
    original = trading.record_trade

    def crash(*args, **kwargs):
        raise RuntimeError("Interrupted after confirmed cash settlement")

    monkeypatch.setattr(trading, "record_trade", crash)
    with pytest.raises(RuntimeError):
        await service.on_tick(current, child, tick("2026-11-02", 100))
    persisted = db.Table("Orders").get_item(
        Key={"session_id": child.session_id, "order_id": filled.order_id}
    )["Item"]
    assert persisted["status"] == "FILLED"
    monkeypatch.setattr(trading, "record_trade", original)
    service._runtimes.clear()
    simulation._sessions.clear()
    trading._trades.clear()
    order_service._orders.clear()
    await service.ensure("u", parent["session_id"], subscribe=False)
    restored = service.snapshot("u", parent["session_id"])
    assert len(restored["trades"]) == 1
    assert restored["positions"][0]["quantity"] == 10
    assert restored["open_orders"][0]["order_id"] == pending.order_id
    balance = restored["wallet_balance"]
    service._runtimes.clear()
    simulation._sessions.clear()
    trading._trades.clear()
    order_service._orders.clear()
    await service.ensure("u", parent["session_id"], subscribe=False)
    assert service.snapshot("u", parent["session_id"])["wallet_balance"] == balance


@pytest.mark.asyncio
async def test_stop_limit_gap_waits_for_executable_price_and_survives_restart(db):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    current = service.runtime("u", parent["session_id"])
    entry(child, 100)
    await service.on_tick(current, child, tick("2026-11-02", 100))
    stop = order_service.place_order(
        child.session_id,
        child.symbol,
        TradeSide.SELL,
        OrderType.STOPLOSS,
        10,
        2,
        child.date,
        trigger_price=95,
        user_id="u",
        wallet_ledger_id=child.wallet_ledger_id,
        wallet_ledger_kind="paper",
    )
    await service.on_tick(current, child, tick("2026-11-03", 90))
    assert stop.status == OrderStatus.PENDING
    assert stop.stop_triggered_at
    service._runtimes.clear()
    simulation._sessions.clear()
    trading._trades.clear()
    order_service._orders.clear()
    current = await service.ensure("u", parent["session_id"], subscribe=False)
    restored = current.contexts["HDFCBANK:equity"]
    await service.on_tick(current, restored, tick("2026-11-04", 96))
    assert not service.snapshot("u", parent["session_id"])["positions"]
    assert trading.get_trades(restored.session_id)[-1].price == 96


@pytest.mark.asyncio
async def test_overlapping_exits_cannot_create_a_short_position(db):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    current = service.runtime("u", parent["session_id"])
    entry(child, 100)
    await service.on_tick(current, child, tick("2026-11-02", 100))
    for _ in range(2):
        order_service.place_order(
            child.session_id,
            child.symbol,
            TradeSide.SELL,
            OrderType.LIMIT,
            10,
            2,
            child.date,
            limit_price=110,
            user_id="u",
            wallet_ledger_id=child.wallet_ledger_id,
            wallet_ledger_kind="paper",
        )
    await service.on_tick(current, child, tick("2026-11-03", 110))
    assert not service.snapshot("u", parent["session_id"])["positions"]
    assert len(trading.get_trades(child.session_id)) == 2


@pytest.mark.asyncio
async def test_backend_startup_restores_running_books_without_a_screen(db, monkeypatch):
    active = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", active["session_id"], "HDFCBANK", subscribe=False
    )
    pending = entry(child, 100)
    closed = store.create("other", "paper", 100000)
    row = store.owned("other", closed["session_id"])
    store.update("other", closed["session_id"], {"state": "closing"}, row["version"])
    store.finish_verified_close("other", closed["session_id"])
    service._runtimes.clear()
    simulation._sessions.clear()
    trading._trades.clear()
    order_service._orders.clear()
    ensure = service.ensure

    async def quiet_restore(user, pid):
        return await ensure(user, pid, subscribe=False)

    monkeypatch.setattr(service, "ensure", quiet_restore)
    await service.restore_active_portfolios()
    assert active["session_id"] in service._runtimes
    assert closed["session_id"] not in service._runtimes
    assert (
        service.snapshot("u", active["session_id"])["open_orders"][0]["order_id"]
        == pending.order_id
    )


@pytest.mark.asyncio
async def test_zero_quote_cannot_create_a_free_paper_position(db):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    order = entry(child, 100)
    await service.on_tick(
        service.runtime("u", parent["session_id"]), child, tick("2026-11-02", 0)
    )
    assert order.status == OrderStatus.PENDING
    assert not trading.get_trades(child.session_id)
    assert not service.snapshot("u", parent["session_id"])["positions"]
