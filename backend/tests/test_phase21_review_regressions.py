# ruff: noqa: F811, F401
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from app.services import real_funding, real_sessions, swing_real
from app.services import real_session_slots as slots
from app.services import swing_funding_store as funding

from tests.test_swing_paper_runtime import db
from tests.test_swing_real_runtime import real_book


@pytest.mark.parametrize("reverse", [False, True])
def test_restart_does_not_adopt_child_as_second_swing_book(
    real_book, db, monkeypatch, reverse
):
    from app.services import swing_portfolio_service as service

    child, _, current = real_book
    service.attach_context("u", current.portfolio_id, "RELIND", subscribe=False)
    factory = db.Table
    sessions = factory("Sessions")
    scan = sessions.scan

    def ordered_scan(**kwargs):
        page = scan(**kwargs)
        if reverse:
            page["Items"].reverse()
        return page

    monkeypatch.setattr(sessions, "scan", ordered_scan)
    monkeypatch.setattr(
        db, "Table", lambda name: sessions if name == "Sessions" else factory(name)
    )
    real_sessions._adopt_legacy()
    row = slots.read("kite", "account", "swing")
    assert row["session_id"] == child.portfolio_id
    assert not row.get("recovery_conflict"), row


def test_reconcile_cas_retry_uses_latest_allocation_baseline(real_book, monkeypatch):
    child, _, _ = real_book
    child.real_recovery_pending = False
    original = funding.apply
    injected = False

    def apply(*args, **kwargs):
        nonlocal injected
        if args[5] == "book_snapshot" and not injected:
            injected = True
            funding.change_allocation(
                "u",
                "kite",
                "account",
                "swing",
                child.portfolio_id,
                0.5,
                "allocation-edit",
            )
        return original(*args, **kwargs)

    monkeypatch.setattr(funding, "apply", apply)
    row = real_funding.reconcile(child, 100000)
    mode = row["funding"]["modes"]["swing"]
    assert mode["funding_allocation"] == 50000
    assert mode["expected_balance"] == 50000, mode


@pytest.mark.asyncio
async def test_cash_correction_supports_empty_portfolio(real_book, db, monkeypatch):
    from app.services import simulation
    from app.services import swing_portfolio_store as store

    _child, _, current = real_book
    current.contexts.clear()
    simulation._sessions.clear()
    parent = store.owned("u", current.portfolio_id)
    store.update("u", current.portfolio_id, {"contexts": {}}, parent["version"])
    preview = await swing_real.correction_preview(current, -1000, "Withdrawal")
    await swing_real.correct_shortfall(
        current, -1000, "Withdrawal", "correction", preview["funding_version"]
    )
    row = funding.read("u", "kite", "account")
    assert row["funding"]["modes"]["swing"]["capital"] == 99000
    assert row["funding_status"]["shortfall"] == 0
    await swing_real.correct_shortfall(
        current, -1000, "Withdrawal", "correction", preview["funding_version"]
    )
    assert (
        funding.read("u", "kite", "account")["funding"]["modes"]["swing"]["capital"]
        == 99000
    )


@pytest.mark.asyncio
async def test_engine_does_not_treat_unhydrated_contexts_as_empty(
    real_book, monkeypatch
):
    import asyncio

    _child, _, current = real_book
    current.contexts.clear()
    empty = AsyncMock()
    monkeypatch.setattr(swing_real, "reconcile_empty", empty)

    async def stop(*_):
        raise asyncio.CancelledError

    monkeypatch.setattr(swing_real.asyncio, "sleep", stop)
    with pytest.raises(asyncio.CancelledError):
        await swing_real.engine(current)
    empty.assert_not_awaited()


def test_partial_report_rebuild_reserves_only_unfilled_quantity(real_book):
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import order_service, real_broker_state

    child, _, _ = real_book
    local = Order(
        order_id="buy",
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        order_type=OrderType.LIMIT,
        quantity=100,
        trigger_price=100,
        limit_price=100,
        created_at=1,
        broker_order_id="broker-buy",
        reserved_amount=10000,
    )
    order_service._orders[child.session_id] = {"buy": local}
    report = {
        "symbol": "HDFCBANK",
        "exchange": "nse_cm",
        "product": "CNC",
        "broker_order_id": "broker-buy",
        "side": "BUY",
        "order_type": "LIMIT",
        "status": "open",
        "quantity": 100,
        "filled_quantity": 50,
        "filled_price": 100,
        "trigger_price": 100,
        "limit_price": 100,
        "order_time": "",
    }
    orders = real_broker_state.build_orders(child, [report])
    real_broker_state.rebuild_reservations(child, orders, [])
    rebuilt = orders["buy"]
    assert rebuilt.reserved_amount == 5000, rebuilt


def test_pending_shared_funding_blocks_new_reservations(real_book):
    from fastapi import HTTPException

    child, _, _ = real_book
    real_funding.mark_pending(child)
    with pytest.raises(HTTPException):
        real_funding.reserve(child, "new-entry", 1000)


@pytest.mark.asyncio
async def test_old_intention_with_new_unknown_submission_cannot_close(
    real_book, db, monkeypatch
):
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import order_service

    from tests.test_swing_paper_runtime import tick

    child, _, current = real_book
    old = Order(
        order_id="old-target",
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        order_type=OrderType.TARGET,
        quantity=1,
        trigger_price=100,
        limit_price=100,
        created_at=tick("2026-10-08", 100)["time"],
        recovery_state="unknown",
        analytics={"broker_tag": "tag-for-attempt-today"},
        broker_submission_at=(tick("2026-10-09", 100)["time"] - 19800) * 1000,
    )
    order_service._orders[child.session_id] = {old.order_id: old}
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch",
        AsyncMock(return_value=SimpleNamespace(orders=[], positions=[], executions=[])),
    )
    from app.services import swing_portfolio_store as store

    parent = store.owned("u", current.portfolio_id)
    db.Table("Sessions").update_item(
        Key={"session_id": current.portfolio_id},
        UpdateExpression="SET real_claim_token = :token",
        ExpressionAttributeValues={":token": "engine"},
    )
    store.update("u", current.portfolio_id, {"state": "closing"}, parent["version"])
    assert not await swing_real.verify_close(current)


@pytest.mark.asyncio
async def test_interrupted_swing_start_retains_recovery_instructions(db, monkeypatch):
    from app.routers.swing import StartPortfolio
    from app.services import execution_broker, real_accounting
    from app.services import swing_portfolio_store as store

    monkeypatch.setattr("app.dependencies.require_real_trading_access", lambda *_: None)
    monkeypatch.setattr(real_sessions, "_ready", True)
    broker = SimpleNamespace(
        is_authenticated=lambda: True, account_identity=lambda: "account"
    )
    monkeypatch.setattr(execution_broker, "get_service", lambda *_: broker)
    monkeypatch.setattr(
        real_accounting, "refresh", AsyncMock(return_value={"balance": 100000})
    )
    monkeypatch.setattr(
        funding,
        "start_participant",
        lambda *_, **__: (_ for _ in ()).throw(RuntimeError("Storage unavailable")),
    )
    with pytest.raises(RuntimeError):
        await swing_real.start(
            "u",
            StartPortfolio(
                mode="real", execution_broker="kite", capital=100000, allocation_pct=0.5
            ),
        )
    slot = slots.read("kite", "account", "swing")
    parent = store.owned("u", slot["session_id"])
    assert parent.get("allocation_pct") == 0.5, (
        "Recovery has no saved startup allocation"
    )


def test_closed_parent_children_are_not_readopted(real_book, db):
    from app.services import swing_portfolio_store as store

    _child, _, current = real_book
    db.Table("Sessions").update_item(
        Key={"session_id": current.portfolio_id},
        UpdateExpression="SET #state = :ended, real_verified_closed = :yes",
        ExpressionAttributeNames={"#state": "state"},
        ExpressionAttributeValues={":ended": "ended", ":yes": True},
    )
    db.Table("WalletLedgers").update_item(
        Key=slots.key("kite", "account", "swing"),
        UpdateExpression="SET #state = :closed",
        ExpressionAttributeNames={"#state": "state"},
        ExpressionAttributeValues={":closed": "closed"},
    )
    real_sessions._adopt_legacy()
    assert slots.read("kite", "account", "swing") is None


def test_missing_swing_parent_remains_blocked(real_book, db):
    _child, _, current = real_book
    db.Table("Sessions").delete_item(Key={"session_id": current.portfolio_id})
    real_sessions._adopt_legacy()
    assert slots.read("kite", "account", "swing")["recovery_conflict"]


def test_two_genuine_swing_roots_remain_conflicted(real_book, db):
    from app.services import swing_portfolio_store as store

    _child, _, current = real_book
    parent = store.owned("u", current.portfolio_id)
    db.Table("Sessions").put_item(
        Item=funding.encode({**parent, "session_id": "another-parent", "contexts": {}})
    )
    real_sessions._adopt_legacy()
    assert slots.read("kite", "account", "swing")["recovery_conflict"]


@pytest.mark.asyncio
async def test_missing_child_keeps_engine_unready_and_funding_pending(
    real_book, db, monkeypatch
):
    import asyncio

    from app.services import swing_portfolio_service as service
    from fastapi import HTTPException

    child, _, current = real_book
    monkeypatch.setattr("app.dependencies.require_real_trading_access", lambda *_: None)
    db.Table("WalletLedgers").update_item(
        Key=slots.key("kite", "account", "swing"),
        UpdateExpression="SET engine_until = :zero",
        ExpressionAttributeValues={":zero": 0},
    )
    db.Table("Sessions").delete_item(Key={"session_id": child.session_id})
    try:
        with pytest.raises(HTTPException, match="Saved portfolio context is missing"):
            await service.ensure("u", current.portfolio_id, subscribe=False)
        assert not current.real_ready
        assert funding.read("u", "kite", "account")["participants"]["swing"][
            "reconciliation_pending"
        ]
        assert not await swing_real.verify_close(current)
    finally:
        for task in current.tasks.values():
            task.cancel()
        await asyncio.gather(*current.tasks.values(), return_exceptions=True)


@pytest.mark.asyncio
async def test_old_interrupted_empty_start_can_recover_saved_capital(db, monkeypatch):
    import asyncio

    from app.services import execution_broker
    from app.services import swing_portfolio_service as service
    from app.services import swing_portfolio_store as store

    monkeypatch.setattr("app.dependencies.require_real_trading_access", lambda *_: None)
    pool = funding.initialize("u", "kite", "account", 100000)
    parent = store.create("u", "real", 50000, broker="kite", account="account")
    broker = SimpleNamespace(account_identity=lambda: "account")
    monkeypatch.setattr(execution_broker, "get_service", lambda *_, **__: broker)
    current = service.runtime("u", parent["session_id"])
    try:
        await service.ensure("u", parent["session_id"], subscribe=False)
        saved = store.owned("u", parent["session_id"])
        assert saved["allocation_pct"] == 0.5
        assert saved["real_funding_period"] == pool["period_id"]
        assert (
            funding.read("u", "kite", "account")["funding"]["modes"]["swing"]["capital"]
            == 50000
        )
        assert current.real_ready
    finally:
        for task in current.tasks.values():
            task.cancel()
        await asyncio.gather(*current.tasks.values(), return_exceptions=True)


@pytest.mark.asyncio
async def test_undated_closure_requires_owned_explicit_acknowledgement(
    real_book, db, monkeypatch
):
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import order_service
    from app.services import swing_portfolio_service as service
    from app.services import swing_portfolio_store as store
    from fastapi import HTTPException

    child, _, current = real_book
    unknown = Order(
        order_id="undated",
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        order_type=OrderType.TARGET,
        quantity=1,
        trigger_price=100,
        limit_price=100,
        created_at=1,
        recovery_state="unknown",
    )
    order_service._orders[child.session_id] = {unknown.order_id: unknown}
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch",
        AsyncMock(return_value=SimpleNamespace(orders=[], positions=[], executions=[])),
    )
    from app.services.real_recovery import validate_acknowledgements

    with pytest.raises(HTTPException, match="outside this book"):
        validate_acknowledgements([child], ["other-book-order"])
    parent = store.owned("u", current.portfolio_id)
    db.Table("Sessions").update_item(
        Key={"session_id": current.portfolio_id},
        UpdateExpression="SET real_claim_token = :token",
        ExpressionAttributeValues={":token": "engine"},
    )
    store.update("u", current.portfolio_id, {"state": "closing"}, parent["version"])
    assert not await swing_real.verify_close(current)
    parent = store.owned("u", current.portfolio_id)
    accepted = validate_acknowledgements([child], ["undated"])
    store.update(
        "u",
        current.portfolio_id,
        {"acknowledged_undated_submission_ids": accepted},
        parent["version"],
    )
    assert await swing_real.verify_close(current)
    ended = store.owned("u", current.portfolio_id)
    assert ended["acknowledged_undated_submission_ids"] == ["undated"]
    assert ended["history_warning"]
    assert slots.read("kite", "account", "swing") is None


def test_acknowledgement_never_overrides_current_attempt(real_book):
    from app.models.schemas import Order, TradeSide
    from app.services import order_service
    from app.services.real_recovery import closure_requirements

    from tests.test_swing_paper_runtime import tick

    child, _, _ = real_book
    order = Order(
        order_id="current",
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        quantity=1,
        trigger_price=100,
        limit_price=100,
        created_at=1,
        recovery_state="unknown",
        broker_submission_at=(tick("2026-10-09", 100)["time"] - 19800) * 1000,
    )
    order_service._orders[child.session_id] = {order.order_id: order}
    state = closure_requirements([child], ["current"])
    assert state["closure_blocked"]
    assert state["current_submission_ids"] == ["current"]


def test_partial_reversal_reserves_remaining_opening_units(real_book):
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import order_service, real_broker_state

    child, _, _ = real_book
    child.trading_style = "intraday"
    order = Order(
        order_id="reversal",
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        order_type=OrderType.LIMIT,
        quantity=150,
        trigger_price=100,
        limit_price=100,
        created_at=1,
        broker_order_id="remote",
        broker_filled_quantity=120,
    )
    real_broker_state.rebuild_reservations(
        child,
        {"reversal": order},
        [
            {
                "right": None,
                "strike": None,
                "expiry": None,
                "side": "LONG",
                "quantity": 20,
            }
        ],
    )
    assert order.reserved_amount == 600  # 30 remaining * 100 * 20% MIS margin
    order.status = order_service.OrderStatus.CANCELLED
    real_broker_state.rebuild_reservations(child, {"reversal": order}, [])
    assert order.reserved_amount == 0


@pytest.mark.asyncio
async def test_new_uncertainty_during_flat_verification_blocks_release(
    real_book, monkeypatch
):
    from app.models.schemas import Order, TradeSide
    from app.services import order_service, real_recovery

    from tests.test_swing_paper_runtime import tick

    child, _, current = real_book

    async def verification(_):
        order = Order(
            order_id="inflight",
            session_id=child.session_id,
            user_id="u",
            symbol="HDFCBANK",
            side=TradeSide.BUY,
            quantity=1,
            trigger_price=100,
            limit_price=100,
            created_at=1,
            recovery_state="unknown",
            broker_submission_at=(tick("2026-10-09", 100)["time"] - 19800) * 1000,
        )
        order_service._orders[child.session_id] = {order.order_id: order}
        return {"verified_flat": True}

    monkeypatch.setattr(real_recovery, "verify", verification)
    assert not await swing_real.verify_close(current)
    assert slots.read("kite", "account", "swing") is not None


@pytest.mark.asyncio
async def test_swing_close_endpoint_passes_owned_acknowledgements(
    real_book, monkeypatch
):
    from app.routers import swing
    from app.services import swing_portfolio_service as service
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    _child, _, current = real_book
    close = AsyncMock()
    monkeypatch.setattr(service, "close_portfolio", close)
    app = FastAPI()
    app.include_router(swing.router, prefix="/api")
    with TestClient(app) as client:
        response = client.post(
            f"/api/swing/portfolios/{current.portfolio_id}/close",
            json={"acknowledge_undated_submission_ids": ["old-order"]},
            headers={"X-User-Id": "u"},
        )
    assert response.status_code == 200
    close.assert_awaited_once_with("u", current.portfolio_id, ["old-order"], acknowledge_delivery_context_ids=[])


def test_reservation_decrease_is_allowed_while_funding_pending(real_book):
    child, _, _ = real_book
    child.real_recovery_pending = False
    real_funding.reconcile(child, 100000)
    real_funding.reserve(child, "entry", 10000)
    real_funding.mark_pending(child)
    real_funding.reserve(child, "entry", 5000, owner="broker")
    row = funding.read("u", "kite", "account")
    assert row["funding"]["reservations"][f"{child.session_id}:entry"]["amount"] == 5000
    real_funding.reserve(child, "entry", 0)
    assert not funding.read("u", "kite", "account")["funding"]["reservations"]


def test_shared_submission_cannot_bypass_swing_pause(real_book):
    from unittest.mock import Mock

    from app.models.schemas import Order, TradeSide
    from app.services import broker_order_service
    from app.services import swing_portfolio_store as store
    from fastapi import HTTPException

    child, _, current = real_book
    child.real_recovery_pending = False
    real_funding.reconcile(child, 100000)
    parent = store.owned("u", current.portfolio_id)
    store.update("u", current.portfolio_id, {"entries_paused": True}, parent["version"])
    order = Order(
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        quantity=1,
        trigger_price=100,
        limit_price=100,
        created_at=1,
    )
    method = Mock()
    with pytest.raises(HTTPException):
        broker_order_service.submit_once(child, order, method)
    method.assert_not_called()
    assert order.recovery_state is None


@pytest.mark.asyncio
async def test_edit_placement_unknown_ack_is_durable_and_not_resent(real_book, db):
    from unittest.mock import Mock

    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import broker_order_service, order_service
    from app.services.kotak_service import KotakError

    child, broker, _current = real_book
    child.broker_positions = [
        {
            "symbol": "HDFCBANK",
            "side": "LONG",
            "quantity": 10,
            "avg_entry_price": 100,
            "right": None,
            "strike": None,
            "expiry": None,
        }
    ]
    old = Order(
        order_id="local-exit",
        session_id=child.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=10,
        trigger_price=90,
        limit_price=89,
        created_at=1,
        is_stoploss=True,
    )
    order_service._orders[child.session_id] = {old.order_id: old}
    broker.place_sl_order = Mock(side_effect=TimeoutError("Lost ACK"))
    with pytest.raises(KotakError):
        await broker_order_service.sync_order_edit_async(
            child, old.model_copy(deep=True), OrderType.STOPLOSS
        )
    assert old.recovery_state == "unknown"
    assert old.broker_submission_at
    saved = db.Table("Orders").get_item(
        Key={"session_id": child.session_id, "order_id": old.order_id}
    )["Item"]
    assert saved["recovery_state"] == "unknown"
    assert saved["broker_submission_at"] == old.broker_submission_at
    with pytest.raises(KotakError):
        await broker_order_service.sync_order_edit_async(
            child, old.model_copy(deep=True), OrderType.STOPLOSS
        )
    assert broker.place_sl_order.call_count == 1


def test_unready_portfolio_never_reports_complete_pnl(real_book):
    from app.services import swing_portfolio_service as service

    _child, _, current = real_book
    current.real_ready = False
    snapshot = service.snapshot("u", current.portfolio_id)
    assert snapshot["pnl"] is None
    assert "portfolio:" + current.portfolio_id in snapshot["reconciliation_pending"]


def test_archived_swing_snapshot_does_not_read_new_funding(real_book, db, monkeypatch):
    from app.services import swing_portfolio_service as service

    _child, _, current = real_book
    db.Table("Sessions").update_item(
        Key={"session_id": current.portfolio_id},
        UpdateExpression="SET #state = :ended",
        ExpressionAttributeNames={"#state": "state"},
        ExpressionAttributeValues={":ended": "ended"},
    )

    def unexpected(*_, **__):
        raise AssertionError("Closed archive cannot inspect a new funding pool")

    monkeypatch.setattr(funding, "read", unexpected)
    snapshot = service.snapshot("u", current.portfolio_id)
    assert snapshot["wallet_balance"] is None
    assert snapshot["funding_status"] is None
    assert snapshot["allocation_pct"] is None


@pytest.mark.asyncio
async def test_day_acknowledged_flat_close_persists_warning(real_book, monkeypatch):
    from unittest.mock import Mock

    from app.models.schemas import Order, SimulationState, TradeSide
    from app.services import (
        order_service,
        real_close,
        real_recovery,
        simulation,
        strategy_service,
    )

    session = simulation.SimulationSession(
        "day-ack",
        "HDFCBANK",
        "2026-10-09",
        "09:15:00",
        1,
        user_id="u",
        session_type="real",
        execution_broker="kite",
        broker_account_id="account",
    )
    session.state = SimulationState.RUNNING
    unknown = Order(
        order_id="day-undated",
        session_id=session.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        quantity=1,
        trigger_price=100,
        limit_price=100,
        created_at=1,
        recovery_state="unknown",
    )
    order_service._orders[session.session_id] = {unknown.order_id: unknown}
    writes = Mock()
    monkeypatch.setattr(simulation, "_upsert_session_to_db", writes)
    monkeypatch.setattr(strategy_service, "cancel_all", lambda *_: None)
    monkeypatch.setattr(
        real_recovery, "verify", AsyncMock(return_value={"verified_flat": True})
    )
    monkeypatch.setattr(order_service, "cancel_order", Mock())
    finished = AsyncMock()
    monkeypatch.setattr(real_close, "finish", finished)
    await real_close.close(session, ["day-undated"])
    await real_close._jobs[session.session_id]
    finished.assert_awaited_once_with(session)
    assert session.acknowledged_undated_submission_ids == ["day-undated"]
    assert "unverified" in session.real_history_warning
    writes.assert_called_with(session, strict=True)


@pytest.mark.asyncio
async def test_day_close_reconciles_unknown_without_resubmission(
    real_book, monkeypatch
):
    from unittest.mock import Mock

    from app.models.schemas import Order, OrderStatus, SimulationState, TradeSide
    from app.services import (
        order_service,
        real_broker_state,
        real_close,
        simulation,
        strategy_service,
    )

    from tests.test_swing_paper_runtime import tick

    session = simulation.SimulationSession(
        "day-recover",
        "HDFCBANK",
        "2026-10-09",
        "09:15:00",
        1,
        user_id="u",
        session_type="real",
        execution_broker="kite",
        broker_account_id="account",
    )
    session.state = SimulationState.RUNNING
    unknown = Order(
        order_id="day-current",
        session_id=session.session_id,
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide.BUY,
        quantity=1,
        trigger_price=100,
        limit_price=100,
        created_at=1,
        recovery_state="unknown",
        broker_submission_at=(tick("2026-10-09", 100)["time"] - 19800) * 1000,
    )
    order_service._orders[session.session_id] = {unknown.order_id: unknown}
    monkeypatch.setattr(simulation, "_upsert_session_to_db", Mock())
    monkeypatch.setattr(strategy_service, "cancel_all", lambda *_: None)

    async def reconcile(*_):
        unknown.recovery_state = None
        unknown.status = OrderStatus.CANCELLED

    refresh = AsyncMock(side_effect=reconcile)
    monkeypatch.setattr(real_broker_state, "refresh", refresh)
    finished = AsyncMock()
    monkeypatch.setattr(real_close, "finish", finished)
    await real_close.close(session)
    await real_close._jobs[session.session_id]
    finished.assert_awaited_once_with(session)
    assert refresh.await_count >= 1
    assert not real_close.unresolved(session)


@pytest.mark.asyncio
async def test_retained_mode_invalid_allocation_rejects_before_claim(
    real_book, db, monkeypatch
):
    from app.routers.swing import StartPortfolio
    from app.services import execution_broker, real_accounting
    from app.services import swing_portfolio_store as store
    from fastapi import HTTPException

    _child, _, current = real_book
    parent = store.owned("u", current.portfolio_id)
    db.Table("Sessions").update_item(
        Key={"session_id": current.portfolio_id},
        UpdateExpression="SET real_claim_token = :token",
        ExpressionAttributeValues={":token": "engine"},
    )
    store.update("u", current.portfolio_id, {"state": "closing"}, parent["version"])
    store.finish_verified_close("u", current.portfolio_id)
    # Retained closed mode and a live Day participant still share the same reference.
    pool = funding.read("u", "kite", "account")

    def smaller(row):
        from app.services import swing_accounting as rules

        row["funding"] = rules.correct(
            row["funding"], "swing", 80000, 0, "Retained allocation", 80000
        )

    funding.apply(
        "u",
        "kite",
        "account",
        pool["period_id"],
        "retained-reduce",
        "allocation",
        {},
        smaller,
    )
    funding.start_participant(
        "day-user", "kite", "account", pool["period_id"], "intraday", "day", 0.2
    )
    monkeypatch.setattr("app.dependencies.require_real_trading_access", lambda *_: None)
    monkeypatch.setattr(real_sessions, "_ready", True)
    monkeypatch.setattr(
        execution_broker,
        "get_service",
        lambda *_: SimpleNamespace(
            is_authenticated=lambda: True, account_identity=lambda: "account"
        ),
    )
    monkeypatch.setattr(
        real_accounting, "refresh", AsyncMock(return_value={"balance": 100000})
    )
    with pytest.raises(HTTPException, match="allocations exceed"):
        await swing_real.start(
            "u",
            StartPortfolio(
                mode="real", execution_broker="kite", capital=100000, allocation_pct=1
            ),
        )
    assert slots.read("kite", "account", "swing") is None
