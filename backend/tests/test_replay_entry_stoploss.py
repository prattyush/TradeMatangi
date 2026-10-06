"""Explicit website stops must survive risk sizing and the replay fill pipeline."""

from datetime import datetime, timezone
from unittest.mock import Mock

import pytest

from app.models.schemas import (
    Order,
    OrderStatus,
    OrderType,
    PlaceOrderRequest,
    TradeSide,
)
from app.routers import orders as routes
from app.services import (
    entry_sl_watcher,
    order_service,
    simulation,
    strategy_service,
    trading,
)


@pytest.fixture
def replay(monkeypatch):
    timestamp = int(datetime(2026, 9, 15, 10, tzinfo=timezone.utc).timestamp())
    session = simulation.SimulationSession(
        session_id="explicit-web-sl",
        user_id="replay-user",
        symbol="NIFTY",
        date="2026-09-15",
        start_time="10:00:00",
        speed=1,
        session_type="sim",
        session_capital=100000,
        instrument_type="options",
        strike=24500,
        strike_ce=24500,
        strike_pe=24500,
        expiry="2026-09-15",
    )
    session.current_time = str(timestamp)
    session.last_price = 25000
    session.last_price_ce = session.last_price_pe = 100
    monkeypatch.setattr(
        simulation,
        "get_session",
        lambda sid: session if sid == session.session_id else None,
    )
    monkeypatch.setattr(order_service, "_write_order_to_db", Mock())
    monkeypatch.setattr(trading, "_write_trade_to_db", Mock())
    monkeypatch.setattr(trading, "settle_wallet_for_trade", Mock())
    monkeypatch.setattr("app.services.wallet_service.debit", Mock())
    monkeypatch.setattr("app.services.wallet_service.credit", Mock())
    monkeypatch.setattr(
        "app.services.guardrail_service.check_guardrails", lambda *a, **k: (False, "")
    )
    monkeypatch.setattr(
        "app.services.guardrail_service.check_maxsize", lambda *a, **k: (False, "")
    )
    monkeypatch.setattr("app.services.guardrail_service.on_trade_record", Mock())
    monkeypatch.setattr(routes, "_wallet_balance_for_session", lambda s: 100000)
    monkeypatch.setattr(strategy_service, "on_tick", Mock())
    monkeypatch.setattr(strategy_service, "list_running", lambda sid: [])
    monkeypatch.setattr(
        "app.services.user_settings_service.get_settings",
        lambda uid: {"entry_auto_sl_enabled": False},
    )
    order_service.clear_session(session.session_id)
    trading._trades.pop(session.session_id, None)
    yield session, timestamp
    order_service.clear_session(session.session_id)
    trading._trades.pop(session.session_id, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("right", ["CE", "PE"])
async def test_two_risk_sized_use_as_sl_market_entries_are_protected(replay, right):
    session, timestamp = replay
    entries = []
    for index, (risk, stop) in enumerate([(2, 80), (3, 85)]):
        session.current_time = str(timestamp + index)
        entry = await routes.place_order(
            PlaceOrderRequest(
                session_id=session.session_id,
                side=TradeSide.BUY,
                order_type=OrderType.LIMIT,
                market_order=True,
                limit_price=101,
                risk_pct=risk,
                entry_sl_price=stop,
                group_id=f"entry-{index}",
                right=right,
            )
        )
        entries.append(entry)
        events = simulation._emit_tick_and_check_orders(
            session,
            {
                "time": timestamp + index,
                "close": 100,
                "right": right,
                "strike": 24500,
                "expiry": session.expiry,
            },
            right,
        )
        assert entry.status == OrderStatus.FILLED
        stops = [
            o
            for o in order_service.get_open_orders(session.session_id)
            if o.order_type == OrderType.STOPLOSS
        ]
        assert len(stops) == index + 1
        protective = next(o for o in stops if o.group_id == entry.group_id)
        assert (
            protective.quantity == entry.quantity and protective.side == TradeSide.SELL
        )
        assert (protective.right, protective.strike, protective.expiry) == (
            right,
            24500,
            session.expiry,
        )
        assert protective.trigger_price == stop
        assert any(
            e["type"] == "order_placed" and e["order_id"] == protective.order_id
            for e in events
        )
    assert [e.quantity for e in entries] == [65, 130]
    # Another strike cannot trigger either protective order.
    simulation._emit_tick_and_check_orders(
        session,
        {
            "time": timestamp + 2,
            "close": 75,
            "right": right,
            "strike": 24550,
            "expiry": session.expiry,
        },
        right,
    )
    assert len(order_service.get_open_orders(session.session_id)) == 2
    events = simulation._emit_tick_and_check_orders(
        session,
        {
            "time": timestamp + 3,
            "close": 75,
            "right": right,
            "strike": 24500,
            "expiry": session.expiry,
        },
        right,
    )
    assert len([e for e in events if e["type"] == "order_filled"]) == 2
    assert (
        trading.get_position(
            session.session_id, "NIFTY", right, 24500, session.expiry
        ).quantity
        == 0
    )


@pytest.mark.parametrize("mode", ["sim", "paper", "stepwise"])
@pytest.mark.parametrize("settings_state", ["disabled", "unavailable"])
def test_retired_setting_cannot_disable_protection(
    replay, monkeypatch, mode, settings_state
):
    session, timestamp = replay
    session.session_type = mode
    entry = Order(
        session_id=session.session_id,
        user_id=session.user_id,
        symbol="NIFTY",
        side=TradeSide.BUY,
        order_type=OrderType.LIMIT,
        quantity=65,
        trigger_price=101,
        limit_price=101,
        created_at=timestamp,
        entry_sl_price=80,
        right="CE",
        strike=24500,
        expiry=session.expiry,
        status=OrderStatus.FILLED,
        filled_price=100,
        filled_at=timestamp,
    )
    settings = Mock(
        return_value={"entry_auto_sl_enabled": False},
        side_effect=(
            RuntimeError("offline") if settings_state == "unavailable" else None
        ),
    )
    monkeypatch.setattr("app.services.user_settings_service.get_settings", settings)
    entry_sl_watcher.on_entry_filled(entry, session)
    settings.assert_not_called()
    assert len(order_service.get_open_orders(session.session_id)) == 1


def test_direct_market_risk_sizing_without_an_attached_stop_does_not_create_one(replay):
    session, timestamp = replay
    entry = Order(
        session_id=session.session_id,
        user_id=session.user_id,
        symbol="NIFTY",
        side=TradeSide.BUY,
        order_type=OrderType.LIMIT,
        market_order=True,
        quantity=65,
        trigger_price=101,
        limit_price=101,
        created_at=timestamp,
        right="CE",
        strike=24500,
        expiry=session.expiry,
        status=OrderStatus.FILLED,
        filled_price=100,
        filled_at=timestamp,
        analytics={"sizing_method": "RISK", "initial_stop": 80},
    )
    entry_sl_watcher.on_entry_filled(entry, session)
    assert order_service.get_open_orders(session.session_id) == []
