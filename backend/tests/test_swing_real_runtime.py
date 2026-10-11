# ruff: noqa: F811
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app.services import real_broker_state as state
from app.services import real_session_slots as slots
from app.services import swing_funding_store as funding
from app.services import swing_portfolio_service as service
from app.services import swing_portfolio_store as store
from app.services import swing_real, trading
from app.services.swing_real_journal import holding_positions, merge_executions
from botocore.exceptions import ClientError

from tests.test_swing_paper_runtime import (
    db,  # noqa: F401
    tick,
)


def execution(
    identifier="buy",
    order="buy-order",
    qty=10,
    price=100,
    date="2026-10-09",
    live=False,
):
    return {
        "symbol": "HDFCBANK",
        "exchange": "nse_cm",
        "product": "CNC",
        "broker_order_id": order,
        "execution_id": identifier,
        "side": "BUY",
        "quantity": qty,
        "price": price,
        "timestamp": tick(date, price)["time"],
        "_live_delta": live,
    }


def test_journal_retains_prior_day_and_deduplicates():
    old = execution()
    newer = execution("new", "new-order", date="2026-10-12")
    assert len(merge_executions([old], [old, newer])) == 2
    assert merge_executions([old], []) == [old]
    with pytest.raises(ValueError, match="Conflicting"):
        merge_executions([old], [{**old, "price": 101}])


def test_partial_report_does_not_duplicate_feed_deltas():
    feed = execution("live:buy-order:10", live=True)
    partial = execution("one", qty=5)
    assert merge_executions([feed], [partial]) == [feed]
    full = execution("two", qty=5)
    assert {r["execution_id"] for r in merge_executions([feed], [partial, full])} == {
        "one",
        "two",
    }


def test_holdings_add_day_delivery_changes():
    child = SimpleNamespace(
        symbol="HDFCBANK",
        instrument_type="equity",
        trading_style="swing",
        execution_broker="kite",
        deregister_position_observer=lambda *_: None,
    )
    holdings = [
        {
            "tradingsymbol": "HDFCBANK",
            "quantity": 10,
            "t1_quantity": 2,
            "average_price": 100,
            "used_quantity": 5,
        }
    ]
    assert (
        holding_positions(
            child, holdings, [{"quantity": 5, "side": "SHORT", "avg_entry_price": 101}]
        )[0]["quantity"]
        == 7
    )
    with pytest.raises(TypeError):
        holding_positions(child, None, [])


@pytest.fixture
def real_book(db, monkeypatch):
    monkeypatch.setattr(state, "_links", {})
    parent = store.create("u", "real", 100000, broker="kite", account="account")
    pool = funding.initialize("u", "kite", "account", 100000)
    funding.start_participant(
        "u",
        "kite",
        "account",
        pool["period_id"],
        "swing",
        parent["session_id"],
        1,
        session_record_id=parent["session_id"],
    )
    slots.claim("u", "kite", "account", "swing", parent["session_id"], "engine")
    current = service.runtime("u", parent["session_id"])
    current.real_token, current.real_valid_until = "engine", time.monotonic() + 40
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    child.created_at = 0
    broker = SimpleNamespace(
        account_identity=lambda: "account",
        get_holdings=list,
        get_limits=lambda: {"Net": 100000},
        execution_broker="kite",
        deregister_position_observer=lambda *_: None,
    )
    monkeypatch.setattr(
        "app.services.execution_broker.get_service", lambda *_, **kwargs: broker
    )
    monkeypatch.setattr(
        "app.services.real_accounting.refresh",
        AsyncMock(return_value={"balance": 99000}),
    )
    monkeypatch.setattr(
        "app.services.real_trading_day.market_date", lambda: "2026-10-09"
    )
    return child, broker, current


@pytest.mark.asyncio
async def test_buy_survives_next_day_holdings_and_restart(real_book, db, monkeypatch):
    child, broker, _current = real_book
    bundle = SimpleNamespace(
        orders=[],
        executions=[execution()],
        positions=[
            {"symbol": "HDFCBANK", "product": "CNC", "netQty": 10, "buyAvgPrc": 100}
        ],
    )
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch", AsyncMock(return_value=bundle)
    )
    await swing_real.refresh(child)
    root = child.broker_projection_id
    assert trading.get_position(child.session_id).quantity == 10
    monkeypatch.setattr(
        "app.services.real_trading_day.market_date", lambda: "2026-10-12"
    )
    broker.get_holdings = lambda: [
        {"tradingsymbol": "HDFCBANK", "quantity": 10, "average_price": 100}
    ]
    bundle.executions, bundle.positions = [], []
    await swing_real.refresh(child)
    assert child.broker_projection_id == root
    assert trading.get_position(child.session_id).quantity == 10
    assert len(trading.get_trades(child.session_id)) == 1
    assert trading.get_trades(child.session_id)[0].trading_style == "swing"
    assert trading.get_trades(child.session_id)[0].portfolio_id == child.portfolio_id
    child._fifo_executions = None
    state.restore_orders(child)
    assert len(child._fifo_executions) == 1
    assert child.broker_positions[0]["quantity"] == 10


@pytest.mark.asyncio
async def test_gap_preserves_previous_revision(real_book, monkeypatch):
    child, _broker, _current = real_book
    bundle = SimpleNamespace(
        orders=[],
        executions=[execution()],
        positions=[
            {"symbol": "HDFCBANK", "product": "CNC", "netQty": 10, "buyAvgPrc": 100}
        ],
    )
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch", AsyncMock(return_value=bundle)
    )
    await swing_real.refresh(child)
    revision = state._links[child.session_id]["revision"]
    bundle.positions[0]["netQty"] = 15
    with pytest.raises(ValueError, match="incomplete"):
        await swing_real.refresh(child)
    assert state._links[child.session_id]["revision"] == revision
    assert child.real_recovery_pending
    assert trading.get_position(child.session_id).quantity == 10


@pytest.mark.asyncio
async def test_stale_swing_engine_is_fenced(real_book, db):
    child, _broker, _current = real_book
    db.Table("WalletLedgers").update_item(
        Key=slots.key("kite", "account", "swing"),
        UpdateExpression="SET operation_id = :new",
        ExpressionAttributeValues={":new": "replacement"},
    )
    from app.services.simulation import _upsert_session_to_db

    with pytest.raises(ClientError):
        _upsert_session_to_db(child, strict=True)
    with pytest.raises(ClientError):
        swing_real.commit(
            child, {"session_id": "projection", "active_partition": "partition"}
        )


@pytest.mark.asyncio
async def test_import_is_atomic_inventory_evidence_without_fake_trade_or_cash_debit(
    real_book, db, monkeypatch
):
    child, broker, _current = real_book
    broker.get_holdings = lambda: [
        {"tradingsymbol": "HDFCBANK", "quantity": 10, "average_price": 100}
    ]
    bundle = SimpleNamespace(orders=[], executions=[], positions=[])
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch", AsyncMock(return_value=bundle)
    )
    preview = await swing_real.inventory_preview(child)
    await swing_real.import_inventory(child, preview["fingerprint"], "import-once")
    assert trading.get_trades(child.session_id) == []
    assert trading.get_position(child.session_id).quantity == 10
    pool = funding.read("u", "kite", "account")
    assert pool["funding"]["modes"]["swing"]["capital"] == 101000
    assert pool["funding"]["modes"]["swing"]["expected_balance"] == 100000
    before = pool["version"]
    await swing_real.import_inventory(child, preview["fingerprint"], "import-once")
    assert funding.read("u", "kite", "account")["version"] == before
    assert child.opening_inventory_cost == 1000


@pytest.mark.asyncio
async def test_real_entry_uses_shared_reservation_not_paper_cash(
    real_book, monkeypatch
):
    child, _broker, _current = real_book
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch",
        AsyncMock(return_value=SimpleNamespace(orders=[], executions=[], positions=[])),
    )
    monkeypatch.setattr(
        "app.services.real_accounting.refresh",
        AsyncMock(return_value={"balance": 100000}),
    )
    await swing_real.refresh(child)
    from app.models.schemas import OrderType, TradeSide
    from app.services import order_service

    order = order_service.place_order(
        child.session_id,
        child.symbol,
        TradeSide.BUY,
        OrderType.LIMIT,
        10,
        tick(child.date, 100)["time"],
        child.date,
        limit_price=100,
        user_id="u",
        wallet_ledger_kind="real",
        wallet_ledger_id=child.wallet_ledger_id,
        margin_rate=1,
    )
    assert not child.wallet_ledger_id.startswith("swing:")
    pool = funding.read("u", "kite", "account")
    assert (
        pool["funding"]["reservations"][f"{child.session_id}:{order.order_id}"][
            "amount"
        ]
        == 1000
    )


@pytest.mark.asyncio
async def test_explicit_partial_cash_correction_keeps_remaining_gap(
    real_book, monkeypatch
):
    child, _broker, current = real_book
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch",
        AsyncMock(return_value=SimpleNamespace(orders=[], executions=[], positions=[])),
    )
    monkeypatch.setattr(
        "app.services.real_accounting.refresh",
        AsyncMock(return_value={"balance": 99000}),
    )
    await swing_real.refresh(child)
    preview = await swing_real.correction_preview(current, -400, "Withdrawal at broker")
    assert preview["remaining_shortfall"] == 600
    await swing_real.correct_shortfall(
        current,
        -400,
        "Withdrawal at broker",
        "correction-once",
        preview["funding_version"],
    )
    pool = funding.read("u", "kite", "account")
    assert pool["funding_status"]["shortfall"] == 600
    assert pool["funding"]["modes"]["swing"]["capital"] == 99600
    assert pool["funding"]["corrections"][-1]["reason"] == "Withdrawal at broker"
    await swing_real.refresh(child)
    assert funding.read("u", "kite", "account")["funding_status"]["shortfall"] == 600


@pytest.mark.asyncio
async def test_recover_parent_rotates_child_lease_without_replacing_book(
    real_book, db, monkeypatch
):
    child, _broker, current = real_book
    monkeypatch.setattr(
        "app.dependencies.require_real_trading_access", lambda user: user
    )
    db.Table("WalletLedgers").update_item(
        Key=slots.key("kite", "account", "swing"),
        UpdateExpression="SET engine_until = :zero",
        ExpressionAttributeValues={":zero": 0},
    )
    import asyncio

    async def idle_engine(_current):
        await asyncio.Event().wait()

    monkeypatch.setattr(swing_real, "engine", idle_engine)
    await swing_real.bind(current, store.owned("u", current.portfolio_id))
    try:
        assert child.real_claim_token != "engine"
        assert child.session_id == current.contexts["HDFCBANK:equity"].session_id
        assert (
            store.owned("u", current.portfolio_id)["real_claim_token"]
            == child.real_claim_token
        )
        assert child.real_recovery_pending
    finally:
        current.tasks["real-engine"].cancel()
        current.tasks["real-lease"].cancel()
        await asyncio.gather(current.tasks["real-engine"], current.tasks["real-lease"], return_exceptions=True)


@pytest.mark.asyncio
async def test_verified_flat_swing_close_keeps_history_warning(
    real_book, db, monkeypatch
):
    _child, _broker, current = real_book
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch",
        AsyncMock(return_value=SimpleNamespace(orders=[], executions=[], positions=[])),
    )
    parent = store.owned("u", current.portfolio_id)
    db.Table("Sessions").update_item(
        Key={"session_id": current.portfolio_id},
        UpdateExpression="SET real_claim_token = :token",
        ExpressionAttributeValues={":token": "engine"},
    )
    store.update("u", current.portfolio_id, {"state": "closing"}, parent["version"])
    assert await swing_real.verify_close(current)
    ended = store.owned("u", current.portfolio_id)
    assert ended["state"] == "ended"
    assert "gaps remain unresolved" in ended["history_warning"]
    assert slots.read("kite", "account", "swing") is None


@pytest.mark.asyncio
async def test_unknown_broker_status_and_missing_quantity_never_verify_close(
    real_book, monkeypatch
):
    from app.services.real_recovery import verify

    child, _broker, _current = real_book
    bundle = SimpleNamespace(
        orders=[
            {
                "symbol": "HDFCBANK",
                "product": "CNC",
                "status": "unexpected exchange status",
            }
        ],
        positions=[],
        executions=[],
    )
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch", AsyncMock(return_value=bundle)
    )
    assert not (await verify(child))["verified_flat"]
    bundle.orders = []
    bundle.positions = [{"symbol": "HDFCBANK", "product": "CNC"}]
    with pytest.raises(ValueError, match="quantity is unavailable"):
        await verify(child)


@pytest.mark.asyncio
async def test_stale_engine_cannot_overwrite_shared_funding(real_book, db):
    from app.services import real_funding

    child, _broker, _current = real_book
    db.Table("WalletLedgers").update_item(
        Key=slots.key("kite", "account", "swing"),
        UpdateExpression="SET operation_id = :new",
        ExpressionAttributeValues={":new": "replacement"},
    )
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        real_funding.reserve(child, "stale-reservation", 100)
    assert error.value.status_code == 409
    assert not funding.read("u", "kite", "account")["funding"]["reservations"]


@pytest.mark.asyncio
async def test_online_renewal_uses_only_remaining_verified_protection_quantity(
    real_book, monkeypatch
):
    from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
    from app.services import order_service, simulation

    child, _broker, _current = real_book
    child.date = "2026-10-12"
    child.real_recovery_pending = False
    child.broker_positions = [
        {"side": "LONG", "quantity": 6, "avg_entry_price": 100, "right": None}
    ]
    old = Order(
        order_id="protection",
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=10,
        trigger_price=90,
        limit_price=89,
        created_at=1,
        status=OrderStatus.CANCELLED,
        broker_order_id="expired",
        broker_filled_quantity=4,
        swing_attempts=[{"state": "expired", "date": "2026-10-09"}],
    )
    order_service._orders[child.session_id] = {old.order_id: old}
    submitted = []
    monkeypatch.setattr(
        simulation,
        "_register_kotak_sl_for_order",
        lambda _session, order, _loop: submitted.append(order),
    )
    await swing_real.renew_protection_on_quote(child, tick("2026-10-12", 100))
    await swing_real.renew_protection_on_quote(child, tick("2026-10-12", 100))
    assert len(submitted) == 1
    assert submitted[0].quantity == 6
    assert submitted[0].trigger_price == 90
    assert old.swing_attempts[-1]["state"] == "renewed"


def test_import_basis_accounts_for_holdings_sold_and_rebought_during_day():
    from app.services.swing_real_journal import import_basis

    child = SimpleNamespace(
        symbol="HDFCBANK",
        instrument_type="equity",
        trading_style="swing",
        execution_broker="kite",
        brokerage_per_order=1,
        date="2026-10-09",
    )
    holdings = [
        {
            "tradingsymbol": "HDFCBANK",
            "quantity": 10,
            "average_price": 80,
            "used_quantity": 5,
        }
    ]
    positions = holding_positions(
        child, holdings, [{"side": "LONG", "quantity": 2, "avg_entry_price": 100}]
    )
    sell = {**execution("sell", "sell-order", qty=5), "side": "SELL"}
    buy = execution("buy", "buy-order", qty=7)
    buy["timestamp"] += 1
    bundle = SimpleNamespace(
        executions=[sell, buy],
        positions=[
            {"symbol": "HDFCBANK", "product": "CNC", "flBuyQty": 7, "flSellQty": 5}
        ],
    )
    rebuilt = import_basis(child, positions, bundle)
    assert rebuilt[0]["quantity"] == 12
    assert rebuilt[0]["avg_entry_price"] == pytest.approx(1100 / 12)


@pytest.mark.asyncio
async def test_empty_portfolio_can_edit_allocation_and_verify_funding(
    real_book, db, monkeypatch
):
    _child, _broker, current = real_book
    current.contexts.clear()
    from app.services import simulation

    simulation._sessions.clear()
    await swing_real.reconcile_empty(current)
    assert (
        funding.read("u", "kite", "account")["funding_status"]["state"] == "shortfall"
    )
    await swing_real.allocation(current, 0.5, "half-capital")
    pool = funding.read("u", "kite", "account")
    assert pool["funding"]["modes"]["swing"]["capital"] == 50000
    assert store.owned("u", current.portfolio_id)["session_capital"] == 50000


@pytest.mark.asyncio
async def test_entry_rechecks_actual_broker_cash_after_an_outside_withdrawal(
    real_book, monkeypatch
):
    from app.services import real_funding
    from fastapi import HTTPException

    child, broker, _current = real_book
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch",
        AsyncMock(return_value=SimpleNamespace(orders=[], executions=[], positions=[])),
    )
    monkeypatch.setattr(
        "app.services.real_accounting.refresh",
        AsyncMock(return_value={"balance": 100000}),
    )
    await swing_real.refresh(child)
    broker.get_limits = lambda: {"Net": 99000}
    with pytest.raises(HTTPException) as error:
        real_funding.require_entry(child)
    assert error.value.status_code == 409
    assert funding.read("u", "kite", "account")["funding_status"]["shortfall"] == 1000


def test_opening_inventory_capture_excludes_fills_already_in_its_basis(real_book):
    child, _broker, _current = real_book
    # Audit creation time remains unchanged; the explicit import starts future fill accounting.
    child.created_at = 0
    before = execution("old", "before-import", date="2026-10-12")
    child.opening_inventory_captured_at = (before["timestamp"] - 19800) * 1000
    after = execution("new", "after-import", date="2026-10-12")
    after["timestamp"] += 1
    _, fills = state.book_reports(child, [], [before, after])
    assert [row["execution_id"] for row in fills] == ["new"]
