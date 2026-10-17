# ruff: noqa: F811 — pytest fixtures are injected by name
"""Regressions from the Phase 21 self-review; synthetic broker evidence only."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from app.models.schemas import Order, OrderStatus, OrderType, Trade, TradeSide
from app.services import (
    broker_order_service,
    futures_real,
    futures_risk,
    order_service,
    simulation,
    swing_real,
    trading,
)
from app.services import real_broker_state as state

from tests.test_swing_paper_runtime import db  # noqa: F401
from tests.test_swing_real_runtime import execution, real_book  # noqa: F401


def intent(side="SELL", role="exit", created=11):
    return Order(
        order_id="owned",
        session_id="s",
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide(side),
        order_type=OrderType.STOPLOSS,
        quantity=10,
        created_at=created,
        trigger_price=107,
        limit_price=107,
        broker_order_id="broker",
        expiry="2026-10-27",
        execution_role=role,
        status=OrderStatus.CANCELLED,
        swing_attempts=[{"state": "expired", "date": "2026-10-13"}],
        analytics={
            "futures": {
                "fee_profile": futures_risk.FeeProfile().model_dump(mode="json"),
                "margin": 200,
            }
        },
    )


def fill(side, timestamp, quantity=10, identity=None):
    return Trade(
        trade_id=identity or str(timestamp),
        session_id="s",
        user_id="u",
        symbol="HDFCBANK",
        side=TradeSide(side),
        quantity=quantity,
        price=100,
        timestamp=timestamp,
        instrument_type="futures",
        expiry="2026-10-27",
    )


@pytest.mark.asyncio
async def test_owned_future_overnight_refresh_and_projection_restart(
    real_book, monkeypatch
):
    child, _, _ = real_book
    child.instrument_type = "futures"
    child.expiry = "2026-10-27"
    child.future_contract = {
        "symbol": "HDFCBANK",
        "exchange": "NFO",
        "expiry": child.expiry,
        "provider": "kite",
        "trading_symbol": "HDFCBANK26OCTFUT",
        "lot_size": 5,
        "tick_size": 0.05,
        "instrument_token": "42",
        "category": "stock",
    }
    owned = intent("BUY", "entry").model_copy(
        update={
            "session_id": child.session_id,
            "broker_order_id": "buy-order",
            "status": OrderStatus.FILLED,
        }
    )
    order_service._orders[child.session_id] = {owned.order_id: owned}
    row = {
        **execution(),
        "symbol": "HDFCBANK26OCTFUT",
        "exchange": "nse_fo",
        "product": "NRML",
    }
    bundle = SimpleNamespace(
        orders=[],
        executions=[row],
        positions=[
            {
                "symbol": "HDFCBANK26OCTFUT",
                "exchange": "nse_fo",
                "product": "NRML",
                "netQty": 10,
                "buyAvgPrc": 100,
            }
        ],
    )
    monkeypatch.setattr(
        "app.services.kotak_reports.fetch", AsyncMock(return_value=bundle)
    )
    await swing_real.refresh(child)
    assert len(trading.get_trades(child.session_id)) == 1
    monkeypatch.setattr(
        "app.services.real_trading_day.market_date", lambda: "2026-10-12"
    )
    bundle.executions = []
    await swing_real.refresh(child)
    assert not child.real_recovery_pending
    assert trading.get_position(child.session_id, expiry=child.expiry).quantity == 10
    child._fifo_executions = None
    state.restore_orders(child)
    await swing_real.refresh(child)
    assert len(trading.get_trades(child.session_id)) == 1
    assert (
        futures_real.ledger.values(futures_real.ledger.read(child)["ledger"])[
            "held_margin"
        ]
        == 200
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "side,role,position,fills,expected",
    [
        ("SELL", "entry", "SHORT", [fill("SELL", 10)], 0),
        ("SELL", "exit", "SHORT", [fill("SELL", 10)], 0),
        ("BUY", "exit", "LONG", [fill("BUY", 10)], 0),
        ("SELL", "exit", "LONG", [fill("BUY", 10)], 1),
        ("BUY", "exit", "SHORT", [fill("SELL", 10)], 1),
        (
            "SELL",
            "exit",
            "LONG",
            [fill("BUY", 10), fill("SELL", 20), fill("BUY", 30)],
            0,
        ),
        (
            "BUY",
            "exit",
            "SHORT",
            [fill("SELL", 10), fill("BUY", 20), fill("SELL", 30)],
            0,
        ),
        ("BUY", "exit", "SHORT", [fill("SELL", 10), fill("BUY", 20, quantity=5)], 1),
        ("SELL", "exit", "LONG", [], 0),
    ],
)
@pytest.mark.parametrize("covered", [0, 5])
async def test_only_current_cycle_verified_future_exits_are_renewed(
    monkeypatch, side, role, position, fills, expected, covered
):
    child = SimpleNamespace(
        session_id="s",
        user_id="u",
        portfolio_id="p",
        symbol="HDFCBANK",
        instrument_type="futures",
        date="2026-10-14",
        expiry="2026-10-27",
        broker_refresh_events=None,
        real_recovery_pending=False,
    )
    old = intent(side, role)
    monkeypatch.setattr("app.services.swing_paper_recovery.day_window", lambda _: True)
    monkeypatch.setattr(swing_real.store, "owned", lambda *a: {"state": "running"})
    monkeypatch.setattr(order_service, "get_all_orders", lambda _: [old])
    quantity = (
        abs(sum(t.quantity * (1 if t.side == TradeSide.BUY else -1) for t in fills))
        if fills
        else 10
    )
    coverage = (
        intent(side).model_copy(
            update={"quantity": covered, "broker_filled_quantity": 0}
        )
        if covered
        else None
    )
    monkeypatch.setattr(
        order_service, "get_open_orders", lambda _: [coverage] if coverage else []
    )
    monkeypatch.setattr(order_service, "get_order", lambda *a: None)
    monkeypatch.setattr(
        trading,
        "get_position",
        lambda *a: SimpleNamespace(side=position, quantity=quantity),
    )
    monkeypatch.setattr(trading, "get_trades", lambda _: fills)
    renew = AsyncMock()
    monkeypatch.setattr(futures_real, "renew_exit", renew)
    await swing_real.renew_protection_on_quote(
        child, {"time": 50, "close": 100, "expiry": child.expiry}
    )
    expected = expected if quantity > covered else 0
    assert renew.await_count == expected
    if expected:
        assert renew.await_args.args[2] == min(10, quantity - covered)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "side,tick,expected", [("SELL", 0.1, 105.4), ("BUY", 0.5, 108.5)]
)
async def test_initial_cached_future_sl_uses_configured_gap_and_listed_tick(
    monkeypatch, side, tick, expected
):
    order = intent(side).model_copy(
        update={"status": OrderStatus.PENDING, "broker_order_id": None}
    )
    child = SimpleNamespace(
        session_id="s",
        symbol="HDFCBANK",
        session_type="real",
        instrument_type="futures",
        future_contract={"tick_size": tick},
        broker_refresh_events=None,
        real_funding_period=None,
        kotak_order_map={},
    )
    monkeypatch.setitem(simulation._sessions, "s", child)
    monkeypatch.setattr(
        "app.services.execution_price_service.gap_for", lambda *a: 0.015
    )
    monkeypatch.setattr(broker_order_service, "require_entry_allowed", lambda *a: None)
    monkeypatch.setattr(order_service, "get_order", lambda *a: order)
    monkeypatch.setattr(
        "app.services.execution_broker.get_service",
        lambda _: SimpleNamespace(place_sl_order=Mock()),
    )
    monkeypatch.setattr(simulation, "_is_position_exit", lambda *a: True)
    submit = Mock(return_value="mock-id")
    monkeypatch.setattr(broker_order_service, "submit_once", submit)
    monkeypatch.setattr(broker_order_service, "register_callbacks", lambda *a: None)
    await broker_order_service.sync_order_edit_async(
        child, order, OrderType.STOPLOSS, reprice=True
    )
    assert submit.call_args.kwargs["trigger_price"] == 107
    assert submit.call_args.kwargs["limit_price"] == expected
    assert order.execution_gap_pct == 0.015
