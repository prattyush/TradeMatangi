import pytest
import asyncio
import json
from fastapi import HTTPException
from starlette.routing import Match
from unittest.mock import patch

from app.models.schemas import ConvertOrderRequest, OrderStatus, OrderType, PlaceOrderRequest, SimulationState, StartStrategyRequest, StrategyType, TradeSide, UpdateOrderRequest, WalletResetRequest
from app.routers import desktop_trading
from app.services.simulation import _upsert_session_to_db as persist_session
from app.services import order_service, simulation as sim_svc, trading as trading_service, wallet_service


def test_paper_start_rejects_historical_date():
    request = desktop_trading.DesktopTradingStartRequest(
        symbol="NIFTY", date="2026-05-06", start_time="09:15:00", desktop_mode="paper",
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.start_desktop_trading(request, "desktop-user"))
    assert exc.value.status_code == 400


def test_paper_switched_contract_subscribes_and_old_ticks_keep_identity(no_db):
    session = _session()
    session.session_type = "paper"
    session.paper_stream_source = "kite"
    session.paper_base_contracts = {"CE": {"strike": 24000, "expiry": session.expiry}}
    session.strike_ce = 24100
    contract = {"symbol": "NIFTY", "expiry": session.expiry, "strike": 24100,
                "right": "CE", "contract_key": f"NIFTY:{session.expiry}:24100:CE"}
    session.desktop_contracts.append(contract)
    async def subscribe():
        with patch("app.services.kite_service.fetch_options_instrument_token", return_value=123), \
             patch("app.services.kite_service.get_broadcaster") as broadcaster:
            sim_svc.subscribe_desktop_option_contract(session, contract)
            broadcaster.return_value.register.assert_called_once()
    asyncio.run(subscribe())
    tick = {"close": 99, "time": int(session.current_time), "right": "CE"}
    assert sim_svc._emit_tick_and_check_orders(session, tick, "CE") == []
    assert session.desktop_contract_quotes[f"NIFTY:{session.expiry}:24000:CE"]["price"] == 99
    assert contract["contract_key"] not in session.desktop_contract_quotes
    assert session.last_price_ce == 100


def test_desktop_trading_events_reject_other_user_session(no_db):
    _clear()
    session = _session()

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.trading_events(session.session_id, user_id="other-user"))

    assert exc.value.status_code == 404


def test_desktop_trading_events_send_initial_snapshot(no_db):
    _clear()
    session = _session()

    async def first_event():
        source = desktop_trading._desktop_trading_event_source(session, "desktop-user", None)
        return await source.__anext__()

    frame = asyncio.run(first_event())

    assert "event: snapshot" in frame
    data = json.loads(frame.split("data: ", 1)[1].strip())
    assert data["session"]["session_id"] == session.session_id
    assert data["desktop_mode"] == "stepwise"
    assert data["event_cursor"] == session.queue.latest_id()


def test_desktop_trading_events_reset_with_snapshot_after_replay_gap(no_db):
    _clear()
    session = _session()
    session.queue = sim_svc.ReplayEventQueue(maxsize=2)
    session.queue.put_nowait(json.dumps({"type": "tick", "close": 1}))
    session.queue.put_nowait(json.dumps({"type": "tick", "close": 2}))
    session.queue.put_nowait(json.dumps({"type": "tick", "close": 3}))

    async def first_event():
        source = desktop_trading._desktop_trading_event_source(session, "desktop-user", 0)
        return await source.__anext__()

    frame = asyncio.run(first_event())

    assert "id: 3" in frame
    assert "event: stream_reset" in frame
    data = json.loads(frame.split("data: ", 1)[1].strip())
    assert data["session"]["session_id"] == session.session_id
    assert data["event_cursor"] == 3


def test_desktop_trading_events_reset_with_snapshot_after_active_gap(no_db):
    _clear()
    session = _session()
    session.queue = sim_svc.ReplayEventQueue(maxsize=2)
    session.queue.put_nowait(json.dumps({"type": "tick", "close": 1}))

    async def second_event_after_gap():
        source = desktop_trading._desktop_trading_event_source(session, "desktop-user", 0)
        first = await source.__anext__()
        session.queue.put_nowait(json.dumps({"type": "tick", "close": 2}))
        session.queue.put_nowait(json.dumps({"type": "tick", "close": 3}))
        session.queue.put_nowait(json.dumps({"type": "tick", "close": 4}))
        second = await source.__anext__()
        return first, second

    first, second = asyncio.run(second_event_after_gap())

    assert "id: 1" in first
    assert "event: tick" in first
    assert json.loads(first.split("data: ", 1)[1].strip())["event_id"] == 1
    assert "id: 4" in second
    assert "event: stream_reset" in second
    data = json.loads(second.split("data: ", 1)[1].strip())
    assert data["session"]["session_id"] == session.session_id
    assert data["event_cursor"] == 4


@pytest.fixture(autouse=True)
def no_db():
    wallet_service._ledgers[("desktop-user", "sim:2026-05-06")] = 150000
    with patch("app.services.simulation._upsert_session_to_db"), \
         patch("app.services.order_service._write_order_to_db"), \
         patch("app.services.trading._write_trade_to_db"), \
         patch("app.services.wallet_service.debit"), \
         patch("app.services.wallet_service.credit"), \
         patch("app.services.wallet_service._ensure_ledger_table"), \
         patch("app.services.wallet_service._write_ledger"), \
         patch("app.routers.desktop_trading.get_settings", return_value={
             "desktop_hide_chart_labels": False,
             "desktop_order_size_mode": "quantity",
             "desktop_pnl_display_mode": "currency",
             "desktop_confirm_flatten": True,
             "context_menu_sl_mode": "longOnly",
             "target_deviation_pct": 0.01,
             "funds_ratio_l_pct": 0.03,
             "funds_ratio_m_pct": 0.06,
             "funds_ratio_h_pct": 0.12,
             "risk_ratio_l_pct": 1.0,
             "risk_ratio_m_pct": 2.0,
             "risk_ratio_h_pct": 4.0,
             "default_sl_pct": 0.20,
         }):
        yield
    wallet_service._ledgers.pop(("desktop-user", "sim:2026-05-06"), None)


def _session():
    session = sim_svc.SimulationSession(
        session_id="desktop-stepwise-test",
        symbol="NIFTY",
        date="2026-05-06",
        start_time="09:15:00",
        speed=1,
        user_id="desktop-user",
        instrument_type="options",
        strike=24000,
        strike_ce=24000,
        strike_pe=24000,
        expiry="2026-05-07",
        session_type="stepwise",
        stepwise=True,
        wallet_ledger_id="sim:2026-05-06",
    )
    session.state = SimulationState.RUNNING
    session.current_time = "1778058900"
    session.last_price = 24000
    session.last_price_ce = 100
    session.last_price_pe = 120
    session.session_capital = 150000
    session.desktop_contracts = [{"symbol": "NIFTY", "expiry": "2026-05-07", "strike": 24000, "right": "CE", "contract_key": "NIFTY:2026-05-07:24000:CE"}]
    sim_svc._sessions[session.session_id] = session
    return session


def _equity_session(session_id="desktop-equity-test", mode="stepwise"):
    session = sim_svc.SimulationSession(
        session_id=session_id,
        symbol="TATPOW",
        date="2026-05-06",
        start_time="09:15:00",
        speed=1,
        user_id="desktop-user",
        instrument_type="equity",
        session_type="stepwise" if mode == "stepwise" else "sim",
        stepwise=mode == "stepwise",
        wallet_ledger_id="sim:2026-05-06",
    )
    session.state = SimulationState.RUNNING
    session.current_time = "1778058900"
    session.last_price = 100
    session.session_capital = 150000
    session.desktop_mode = mode
    session.desktop_origin = f"desktop_{mode}"
    sim_svc._sessions[session.session_id] = session
    return session


def _clear(session_id="desktop-stepwise-test"):
    sim_svc._sessions.pop(session_id, None)
    sim_svc._sessions.pop("desktop-equity-test", None)
    order_service.clear_session(session_id)
    order_service.clear_session("desktop-equity-test")
    trading_service.clear_session(session_id)
    trading_service.clear_session("desktop-equity-test")


@pytest.mark.parametrize("action", [
    "bulk-convert",
    "bulk-update-sl",
])
def test_desktop_bulk_order_routes_match_before_dynamic_order_route(action):
    path = f"/api/desktop/v1/trading/desktop-stepwise-test/orders/{action}"
    scope = {"type": "http", "path": path, "method": "PATCH", "headers": []}
    matched_route = next(route for route in desktop_trading.router.routes if route.matches(scope)[0] is Match.FULL)

    assert matched_route.path.endswith(f"/orders/{action}")


@pytest.mark.parametrize(("strategy_type", "field", "price"), [
    (StrategyType.TARGET_PROFIT, "target_profit_value", 112.5),
    (StrategyType.LOCK_PROFIT, "lock_profit_value", 106.5),
    (StrategyType.UNDERLYING_TARGET_PROFIT, "target_profit_value", 24125),
    (StrategyType.UNDERLYING_STOPLOSS, "underlying_sl_price", 23950),
])
def test_desktop_strategy_start_forwards_chart_price_and_contract_right(no_db, strategy_type, field, price):
    _clear()
    session = _session()
    request = StartStrategyRequest(session_id="ignored", strategy_type=strategy_type, right="CE", **{field: price})
    with patch("app.routers.strategies.start_strategy", return_value={"strategy_id": "strategy-1"}) as start:
        response = asyncio.run(desktop_trading.start_strategy(session.session_id, request, user_id="desktop-user"))

    assert response == {"strategy_id": "strategy-1"}
    forwarded = start.call_args.args[0]
    assert forwarded.session_id == session.session_id
    assert forwarded.right == "CE"
    assert getattr(forwarded, field) == price


def test_desktop_bulk_convert_uses_clicked_price_for_closing_orders(no_db):
    _clear()
    session = _session()
    trading_service.record_trade(
        session_id=session.session_id,
        side=TradeSide.BUY,
        price=100,
        timestamp=1778058900,
        quantity=65,
        symbol="NIFTY",
        instrument_type="options",
        strike=24000,
        expiry="2026-05-07",
        right="CE",
        user_id="desktop-user",
        session_type="stepwise",
    )
    order = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=90,
        right="CE",
        strike=24000,
        user_id="desktop-user",
    )
    target = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.TARGET,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=110,
        right="CE",
        strike=24000,
        expiry="2026-05-07",
        user_id="desktop-user",
    )

    response = asyncio.run(desktop_trading.bulk_convert(
        session.session_id,
        desktop_trading.BulkChartConvertRequest(new_order_type=OrderType.LIMIT, right="CE", price=96.5),
        user_id="desktop-user",
    ))

    assert response["converted"] == 2
    updated = order_service.get_order(session.session_id, order.order_id)
    assert updated.order_type == OrderType.LIMIT
    assert updated.limit_price == 96.5
    assert updated.is_stoploss is False
    updated_target = order_service.get_order(session.session_id, target.order_id)
    assert updated_target.order_type == OrderType.LIMIT
    assert updated_target.limit_price == 96.5
    _clear()


def test_desktop_bulk_update_sl_only_updates_stoploss_closing_orders(no_db):
    _clear()
    session = _session()
    trading_service.record_trade(
        session_id=session.session_id,
        side=TradeSide.BUY,
        price=100,
        timestamp=1778058900,
        quantity=65,
        symbol="NIFTY",
        instrument_type="options",
        strike=24000,
        expiry="2026-05-07",
        right="CE",
        user_id="desktop-user",
        session_type="stepwise",
    )
    sl = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=90,
        right="CE",
        strike=24000,
        expiry="2026-05-07",
        user_id="desktop-user",
    )
    second_sl = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=89,
        right="CE",
        strike=24000,
        expiry="2026-05-07",
        user_id="desktop-user",
    )
    limit = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.LIMIT,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        limit_price=112,
        right="CE",
        strike=24000,
        expiry="2026-05-07",
        user_id="desktop-user",
    )

    response = asyncio.run(desktop_trading.bulk_update_sl(
        session.session_id,
        desktop_trading.BulkChartUpdateSLRequest(right="CE", strike=24000, expiry="2026-05-07", trigger_price=94.25),
        user_id="desktop-user",
    ))

    assert response["updated"] == 2
    assert order_service.get_order(session.session_id, sl.order_id).trigger_price == 94.25
    assert order_service.get_order(session.session_id, second_sl.order_id).trigger_price == 94.25
    assert order_service.get_order(session.session_id, limit.order_id).limit_price == 112
    _clear()


def test_desktop_day_pnl_marks_open_long_at_current_contract_quote(no_db):
    _clear()
    session = _session()
    session.last_price_ce = 110
    trade = trading_service.record_trade(
        session_id=session.session_id, side=TradeSide.BUY, price=100,
        timestamp=1778058900, quantity=65, symbol="NIFTY", instrument_type="options",
        strike=24000, expiry="2026-05-07", right="CE", user_id="desktop-user", session_type="stepwise",
    )

    assert desktop_trading._day_pnl(session) == round((110 - 100) * 65 - trade.commission, 2)
    _clear()


def test_desktop_day_pnl_marks_open_short_at_current_contract_quote(no_db):
    _clear()
    session = _session()
    session.last_price_ce = 90
    trade = trading_service.record_trade(
        session_id=session.session_id, side=TradeSide.SELL, price=100,
        timestamp=1778058900, quantity=65, symbol="NIFTY", instrument_type="options",
        strike=24000, expiry="2026-05-07", right="CE", user_id="desktop-user", session_type="stepwise",
    )

    assert desktop_trading._day_pnl(session) == round((100 - 90) * 65 - trade.commission, 2)
    _clear()


def test_desktop_wallet_reset_is_blocked_for_active_session(no_db):
    _clear()
    session = _session()

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.reset_wallet(session.session_id, WalletResetRequest(amount=123456), user_id="desktop-user"))
    current = asyncio.run(desktop_trading.wallet(session.session_id, user_id="desktop-user"))

    assert exc.value.status_code == 409
    assert current["balance"] == 150000
    _clear()


def test_desktop_pre_session_wallet_reset_updates_sim_ledger(no_db):
    wallet_service._ledgers.pop(("desktop-user", "sim:2026-05-06"), None)

    response = asyncio.run(desktop_trading.reset_pre_session_wallet(
        WalletResetRequest(amount=123456), date="2026-05-06", user_id="desktop-user"
    ))
    current = asyncio.run(desktop_trading.pre_session_wallet("2026-05-06", user_id="desktop-user"))

    assert response["balance"] == 123456
    assert current["balance"] == 123456
    _clear()


def test_desktop_convert_rejects_other_user_session(no_db):
    _clear()
    session = _session()
    order = order_service.place_order(
        session_id=session.session_id,
        symbol="NIFTY",
        side=TradeSide.SELL,
        order_type=OrderType.STOPLOSS,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=90,
        right="CE",
        strike=24000,
        user_id="desktop-user",
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.convert_order(
            session.session_id,
            order.order_id,
            ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.LIMIT, price=95),
            user_id="someone-else",
        ))
    assert exc.value.status_code == 404
    _clear()


def test_desktop_attach_contract_rejects_different_symbol(no_db, monkeypatch):
    _clear()
    session = _session()
    monkeypatch.setattr("app.routers.desktop_trading.simulation_router._ensure_options_data", lambda *args, **kwargs: None)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.attach_contract(
            session.session_id,
            desktop_trading.AttachContractRequest(symbol="BANKNIFTY", expiry="2026-05-07", strike=52000, right="CE"),
            user_id="desktop-user",
        ))
    assert exc.value.status_code == 400
    assert "locked to NIFTY" in exc.value.detail
    _clear()


def test_desktop_order_requires_attached_option_contract(no_db):
    _clear()
    session = _session()

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.place_order(
            session.session_id,
            PlaceOrderRequest(
                session_id=session.session_id,
                side=TradeSide.SELL,
                order_type=OrderType.STOPLOSS,
                quantity=65,
                trigger_price=91,
                right="CE",
                strike=24100,
                expiry="2026-05-07",
            ),
            user_id="desktop-user",
        ))

    assert exc.value.status_code == 400
    assert exc.value.detail == "Option contract is not attached to this Stepwise session"
    _clear()


def test_desktop_equity_buy_orders_reserve_intraday_margin_on_session_ledger(no_db):
    _clear()
    session = _equity_session()

    order = asyncio.run(desktop_trading.place_order(
        session.session_id,
        PlaceOrderRequest(
            session_id=session.session_id,
            side=TradeSide.BUY,
            order_type=OrderType.LIMIT,
            limit_price=100,
            quantity=100,
        ),
        user_id="desktop-user",
    ))

    assert order.reserved_amount == pytest.approx(2000)
    assert order.reservation_margin_rate == pytest.approx(0.20)
    assert order.wallet_ledger_id == "sim:2026-05-06"
    assert wallet_service.get_ledger_balance("desktop-user", "2026-05-06", "sim:2026-05-06") == pytest.approx(148000)

    updated = asyncio.run(desktop_trading.update_order(
        session.session_id,
        order.order_id,
        UpdateOrderRequest(limit_price=150),
        user_id="desktop-user",
    ))

    assert updated.reserved_amount == pytest.approx(3000)
    assert wallet_service.get_ledger_balance("desktop-user", "2026-05-06", "sim:2026-05-06") == pytest.approx(147000)

    cancelled = asyncio.run(desktop_trading.cancel_order(session.session_id, order.order_id, user_id="desktop-user"))
    assert cancelled.status == OrderStatus.CANCELLED
    assert wallet_service.get_ledger_balance("desktop-user", "2026-05-06", "sim:2026-05-06") == pytest.approx(150000)
    _clear()


def test_equity_anchored_desktop_session_can_place_same_underlying_option_order(no_db):
    _clear()
    session = _equity_session()
    with patch("app.routers.desktop_trading.simulation_router._ensure_options_data"):
        asyncio.run(desktop_trading.attach_contract(
            session.session_id,
            desktop_trading.AttachContractRequest(symbol="TATPOW", expiry="2026-05-07", strike=400, right="CE"),
            user_id="desktop-user",
        ))

    order = asyncio.run(desktop_trading.place_order(
        session.session_id,
        PlaceOrderRequest(
            session_id=session.session_id,
            side=TradeSide.BUY,
            order_type=OrderType.LIMIT,
            limit_price=10,
            quantity=2700,
            right="CE",
            strike=400,
            expiry="2026-05-07",
        ),
        user_id="desktop-user",
    ))

    assert session.instrument_type == "equity"
    assert order.right == "CE"
    assert order.strike == 400
    assert order.expiry == "2026-05-07"
    assert order.reserved_amount == pytest.approx(27000)
    assert order.reservation_margin_rate == pytest.approx(1.0)
    assert wallet_service.get_ledger_balance("desktop-user", "2026-05-06", "sim:2026-05-06") == pytest.approx(123000)
    _clear()


def test_desktop_limit_entry_places_matching_stoploss_on_fill(no_db):
    _clear()
    session = _session()

    order = asyncio.run(desktop_trading.place_order(
        session.session_id,
        PlaceOrderRequest(
            session_id=session.session_id,
            side=TradeSide.BUY,
            order_type=OrderType.LIMIT,
            limit_price=100,
            risk_pct=1,
            entry_sl_price=91,
            group_id="desktop-sl-group",
            right="CE",
            strike=24000,
            expiry="2026-05-07",
        ),
        user_id="desktop-user",
    ))

    sim_svc._emit_tick_and_check_orders(session, {"time": 1778058901, "open": 99, "high": 99, "low": 99, "close": 99}, "CE")

    assert order_service.get_order(session.session_id, order.order_id).status == OrderStatus.FILLED
    assert order.quantity == 130  # 1% of 150000 / (100 - 91), rounded to 2 NIFTY lots
    stoplosses = [item for item in order_service.get_open_orders(session.session_id) if item.is_stoploss]
    assert len(stoplosses) == 1
    sl = stoplosses[0]
    assert sl.side == TradeSide.SELL
    assert sl.quantity == order.quantity
    assert sl.trigger_price == 91
    assert sl.group_id == "desktop-sl-group"
    assert sl.right == "CE"
    assert sl.strike == 24000
    assert sl.expiry == "2026-05-07"
    _clear()


def test_desktop_paper_entry_places_matching_stoploss_with_paper_ledger(no_db):
    _clear("desktop-equity-test")
    session = _equity_session(mode="paper")
    session.session_type = "paper"
    session.wallet_ledger_id = "paper:2026-05-06"
    session.desktop_origin = "desktop_paper"
    wallet_service._ledgers[("desktop-user", "paper:2026-05-06")] = 150000

    with patch("app.services.paper_wallet.move") as paper_move, \
         patch("app.services.user_settings_service.get_settings", side_effect=AssertionError("desktop Paper SL should not depend on the global auto-SL setting")):
        order = order_service.place_order(
            session_id=session.session_id,
            symbol=session.symbol,
            side=TradeSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=100,
            created_at=1778058900,
            trading_date=session.date,
            limit_price=100,
            user_id=session.user_id,
            margin_rate=.2,
            entry_sl_price=106,
            group_id="desktop-paper-sl",
            source="desktop_paper",
            wallet_ledger_id=session.wallet_ledger_id,
            wallet_ledger_kind="paper",
        )

        sim_svc._emit_tick_and_check_orders(session, {"time": 1778058901, "open": 100, "high": 100, "low": 100, "close": 100}, None)

    assert order.status == OrderStatus.FILLED
    stoplosses = [item for item in order_service.get_open_orders(session.session_id) if item.is_stoploss]
    assert len(stoplosses) == 1
    sl = stoplosses[0]
    assert sl.side == TradeSide.BUY
    assert sl.trigger_price == 106
    assert sl.group_id == "desktop-paper-sl"
    assert sl.source == "desktop_paper"
    assert sl.wallet_ledger_id == "paper:2026-05-06"
    assert sl.wallet_ledger_kind == "paper"
    assert sl.reservation_margin_rate == pytest.approx(.2)
    assert paper_move.call_count >= 1
    _clear("desktop-equity-test")
    wallet_service._ledgers.pop(("desktop-user", "paper:2026-05-06"), None)


def test_desktop_target_entry_places_matching_stoploss_on_fill(no_db):
    _clear()


def test_desktop_autostop_without_explicit_stoploss_uses_fill_price_fallback(no_db):
    _clear()
    session = _session()

    order = order_service.place_order(
        session_id=session.session_id,
        symbol=session.symbol,
        side=TradeSide.BUY,
        order_type=OrderType.TARGET,
        quantity=65,
        created_at=1778058900,
        trading_date=session.date,
        trigger_price=105,
        right="CE",
        strike=24000,
        expiry="2026-05-07",
        user_id=session.user_id,
        source="desktop_stepwise",
        is_autostop=True,
    )

    sim_svc._emit_tick_and_check_orders(
        session,
        {"time": 1778058901, "open": 106, "high": 106, "low": 106, "close": 106},
        "CE",
    )

    assert order.status == OrderStatus.FILLED
    stoplosses = [item for item in order_service.get_open_orders(session.session_id) if item.is_stoploss]
    assert len(stoplosses) == 1
    assert stoplosses[0].side == TradeSide.SELL
    assert stoplosses[0].trigger_price == pytest.approx(79.5)
    assert stoplosses[0].quantity == 65
    assert stoplosses[0].expiry == "2026-05-07"
    _clear()
    session = _session()

    order = asyncio.run(desktop_trading.place_order(
        session.session_id,
        PlaceOrderRequest(
            session_id=session.session_id,
            side=TradeSide.BUY,
            order_type=OrderType.TARGET,
            trigger_price=105,
            quantity=65,
            entry_sl_price=94,
            group_id="desktop-target-sl",
            right="CE",
            strike=24000,
            expiry="2026-05-07",
        ),
        user_id="desktop-user",
    ))

    sim_svc._emit_tick_and_check_orders(session, {"time": 1778058902, "open": 106, "high": 106, "low": 106, "close": 106}, "CE")

    assert order_service.get_order(session.session_id, order.order_id).status == OrderStatus.FILLED
    stoplosses = [item for item in order_service.get_open_orders(session.session_id) if item.is_stoploss]
    assert len(stoplosses) == 1
    assert stoplosses[0].trigger_price == 94
    assert stoplosses[0].quantity == 65
    assert stoplosses[0].expiry == "2026-05-07"
    _clear()


def test_desktop_stop_removes_active_stepwise_session(no_db):
    _clear()
    session = _session()

    with patch("app.services.simulation._upsert_session_to_db"):
        response = asyncio.run(desktop_trading.stop_stepwise(session.session_id, user_id="desktop-user"))
    active = asyncio.run(desktop_trading.active_stepwise(user_id="desktop-user"))

    assert response == {"status": "stopped"}
    assert active is None
    _clear()


def test_desktop_stop_rejects_attached_website_owned_paper_session(no_db):
    _clear("desktop-equity-test")
    session = _equity_session(mode="paper")
    session.session_type = "paper"
    session.desktop_origin = None

    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.stop_stepwise(session.session_id, user_id="desktop-user"))

    assert exc.value.status_code == 409
    assert session.state == SimulationState.RUNNING
    _clear("desktop-equity-test")


def test_desktop_attached_contract_order_is_contract_scoped(no_db, monkeypatch):
    _clear()
    session = _session()
    monkeypatch.setattr("app.routers.desktop_trading.simulation_router._ensure_options_data", lambda *args, **kwargs: None)

    asyncio.run(desktop_trading.attach_contract(
        session.session_id,
        desktop_trading.AttachContractRequest(symbol="NIFTY", expiry="2026-05-07", strike=24100, right="CE"),
        user_id="desktop-user",
    ))

    order = asyncio.run(desktop_trading.place_order(
        session.session_id,
        PlaceOrderRequest(
            session_id=session.session_id,
            side=TradeSide.SELL,
            order_type=OrderType.STOPLOSS,
            quantity=65,
            trigger_price=91,
            right="CE",
            strike=24100,
            expiry="2026-05-07",
        ),
        user_id="desktop-user",
    ))

    assert order.strike == 24100
    assert order.expiry == "2026-05-07"
    assert order.source == "desktop_stepwise"
    _clear()


def test_chart_market_intent_uses_the_clicked_contract_quote(no_db, monkeypatch):
    """A second CE chart must not inherit the primary CE stream's price."""
    _clear()
    session = _session()
    second = {"symbol": "NIFTY", "expiry": "2026-05-07", "strike": 24100, "right": "CE", "contract_key": "NIFTY:2026-05-07:24100:CE"}
    session.desktop_contracts.append(second)

    def ticks(symbol, date, strike, expiry, right, start_time):
        return [{"time": 1778058900, "open": 150, "high": 150, "low": 150, "close": 150 if strike == 24100 else 100}]

    monkeypatch.setattr("app.services.options_service.options_iter_ticks", ticks)
    snapshot = desktop_trading._snapshot(session, "desktop-user")
    assert snapshot.contract_quotes[second["contract_key"]]["price"] == 150

    order = asyncio.run(desktop_trading.place_chart_order(
        session.session_id,
        desktop_trading.ChartOrderIntent(
            symbol="NIFTY", expiry="2026-05-07", strike=24100, right="CE",
            side=TradeSide.BUY, intent="market", quantity=65, entry_sl_price=120,
        ),
        user_id="desktop-user",
    ))

    assert order.strike == 24100
    assert order.limit_price == 151.5
    assert order.quote_price == 150
    assert order.quote_timestamp == 1778058900
    assert order.quote_source == "historical_stepwise"
    _clear()


@pytest.mark.parametrize("mode", ["paper", "replay", "stepwise"])
@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
@pytest.mark.parametrize("allocation", [.12, .15])
def test_desktop_chart_capital_sizing_applies_leverage_once_with_maxsize(mode, side, allocation):
    session = _equity_session(session_id=f"desktop-sizing-{mode}-{side.value}", mode=mode)
    if mode == "paper":
        session.session_type = "paper"
    session.session_capital = 100000
    session.guardrail_maxsize_enabled = True
    session.guardrail_maxsize_pct = allocation * 100
    try:
        order = asyncio.run(desktop_trading.place_chart_order(session.session_id,
            desktop_trading.ChartOrderIntent(symbol=session.symbol, side=side,
                intent="market", funds_ratio_pct=allocation,
                entry_sl_price=90 if side == TradeSide.BUY else 110),
            user_id="desktop-user"))
        price = 101 if side == TradeSide.BUY else 99
        assert order.quantity == int((100000 * allocation) / (.2 * price))
        assert order.reserved_amount == pytest.approx(round(order.quantity * price * .2, 2))
        assert order.reserved_amount <= allocation * 100000
        assert order.reservation_margin_rate == .2
    finally:
        _clear(session.session_id)


@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_desktop_chart_risk_sizing_can_legitimately_exceed_maxsize(side):
    session = _equity_session(session_id=f"desktop-risk-maxsize-{side.value}")
    session.session_capital = 100000
    session.guardrail_maxsize_enabled = True
    session.guardrail_maxsize_pct = 15
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(desktop_trading.place_chart_order(session.session_id,
                desktop_trading.ChartOrderIntent(symbol=session.symbol, side=side,
                    intent="limit", price=100, risk_pct=1,
                    entry_sl_price=99 if side == TradeSide.BUY else 101),
                user_id="desktop-user"))
        assert exc.value.status_code == 403
        assert "20,000.00" in exc.value.detail
        assert "15,000.00" in exc.value.detail
        assert order_service.get_open_orders(session.session_id) == []
    finally:
        _clear(session.session_id)


@pytest.mark.parametrize("mode", ["paper", "replay", "stepwise"])
@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_missing_sl_fills_only_gap_and_deduplicates(mode, side):
    from app.routers.orders import MissingStoplossRequest
    session = _equity_session(session_id=f"missing-sl-{mode}-{side.value}", mode=mode)
    if mode == "paper":
        session.session_type = "paper"
    closing = TradeSide.SELL if side == TradeSide.BUY else TradeSide.BUY
    trading_service.record_trade(session.session_id, side, 100, 1778058900,
        quantity=100, symbol=session.symbol, user_id=session.user_id)
    for kind, quantity in [(OrderType.STOPLOSS, 40), (OrderType.LIMIT, 20), (OrderType.TARGET, 10)]:
        order_service.place_order(session_id=session.session_id, symbol=session.symbol,
            side=closing, order_type=kind, quantity=quantity, created_at=1778058900,
            trading_date=session.date, trigger_price=90 if closing == TradeSide.SELL else 110,
            limit_price=110 if closing == TradeSide.SELL else 90, user_id=session.user_id,
            margin_rate=.2, wallet_ledger_id=session.wallet_ledger_id)
    request = MissingStoplossRequest(session_id=session.session_id, request_id="retry",
        trigger_price=90 if side == TradeSide.BUY else 110)
    try:
        result = asyncio.run(desktop_trading.fill_missing_stoploss(session.session_id, request, session.user_id))
        assert result["quantity"] == 30
        assert result["orders"][0].side == closing
        assert result["orders"][0].is_stoploss
        assert result["orders"][0].reserved_amount == 0
        retry = asyncio.run(desktop_trading.fill_missing_stoploss(session.session_id, request, session.user_id))
        assert retry["orders"][0].order_id == result["orders"][0].order_id
        with pytest.raises(HTTPException) as exc:
            asyncio.run(desktop_trading.fill_missing_stoploss(session.session_id,
                request.model_copy(update={"request_id": "another"}), session.user_id))
        assert exc.value.status_code == 409
    finally:
        _clear(session.session_id)


def test_missing_sl_concurrent_requests_recheck_gap():
    from app.routers.orders import MissingStoplossRequest
    session = _equity_session(session_id="missing-sl-concurrent")
    trading_service.record_trade(session.session_id, TradeSide.BUY, 100, 1778058900,
        quantity=100, symbol=session.symbol, user_id=session.user_id)
    async def submit():
        return await asyncio.gather(*(desktop_trading.fill_missing_stoploss(session.session_id,
            MissingStoplossRequest(session_id=session.session_id, request_id=str(i), trigger_price=90),
            session.user_id) for i in range(2)), return_exceptions=True)
    try:
        results = asyncio.run(submit())
        assert sum(isinstance(result, dict) for result in results) == 1
        assert sum(o.quantity for o in order_service.get_open_orders(session.session_id)) == 100
    finally:
        _clear(session.session_id)


@pytest.mark.parametrize("price", [100, 110])
def test_missing_sl_rejects_wrong_side_and_other_user(price):
    from app.routers.orders import MissingStoplossRequest
    session = _equity_session(session_id="missing-sl-invalid")
    trading_service.record_trade(session.session_id, TradeSide.BUY, 100, 1778058900,
        quantity=100, symbol=session.symbol, user_id=session.user_id)
    request = MissingStoplossRequest(session_id=session.session_id, request_id="invalid", trigger_price=price)
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(desktop_trading.fill_missing_stoploss(session.session_id, request, session.user_id))
        assert exc.value.status_code == 400
        with pytest.raises(HTTPException) as exc:
            asyncio.run(desktop_trading.fill_missing_stoploss(session.session_id, request, "other-user"))
        assert exc.value.status_code == 404
        assert order_service.get_open_orders(session.session_id) == []
    finally:
        _clear(session.session_id)


@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_website_missing_sl_real_equity_submits_to_broker_and_fills(side):
    from unittest.mock import Mock
    from app.routers.orders import MissingStoplossRequest, fill_missing_stoploss
    session = _equity_session(session_id=f"missing-sl-real-{side.value}")
    session.session_type = "real"
    closing = TradeSide.SELL if side == TradeSide.BUY else TradeSide.BUY
    trading_service.record_trade(session.session_id, side, 100, 1778058900,
        quantity=100, symbol=session.symbol, user_id=session.user_id)
    order_service.place_order(session_id=session.session_id, symbol=session.symbol,
        side=closing, order_type=OrderType.LIMIT, quantity=40, created_at=1778058900,
        trading_date=session.date, limit_price=110, user_id=session.user_id, margin_rate=.2)
    broker = Mock()
    broker.place_sl_order.return_value = "broker-sl"
    request = MissingStoplossRequest(session_id=session.session_id, request_id="real",
        trigger_price=90 if side == TradeSide.BUY else 110)
    try:
        with patch("app.services.kotak_service.get_service", return_value=broker):
            result = asyncio.run(fill_missing_stoploss(request, session.user_id))
            assert result["quantity"] == 60
            assert broker.place_sl_order.call_args.kwargs["qty"] == 60
            assert broker.place_sl_order.call_args.kwargs["side"] == ("S" if side == TradeSide.BUY else "B")
            assert result["orders"][0].kotak_order_id == "broker-sl"
            asyncio.run(fill_missing_stoploss(request, session.user_id))
            broker.place_sl_order.assert_called_once()
            callback = broker.register_fill_callback.call_args.args[1]
            callback("broker-sl", closing.value, 60, request.trigger_price)
            assert trading_service.get_position(session.session_id, session.symbol).quantity == 40
    finally:
        _clear(session.session_id)


def test_website_missing_sl_real_rejection_is_not_reported_as_protection():
    from unittest.mock import Mock
    from app.routers.orders import MissingStoplossRequest, fill_missing_stoploss
    from app.services.kotak_service import KotakError
    session = _equity_session(session_id="missing-sl-real-rejection")
    session.session_type = "real"
    trading_service.record_trade(session.session_id, TradeSide.BUY, 100, 1778058900,
        quantity=100, symbol=session.symbol, user_id=session.user_id)
    broker = Mock()
    broker.place_sl_order.side_effect = KotakError("rejected")
    request = MissingStoplossRequest(session_id=session.session_id, request_id="reject", trigger_price=90)
    try:
        with patch("app.services.kotak_service.get_service", return_value=broker):
            with pytest.raises(HTTPException) as exc:
                asyncio.run(fill_missing_stoploss(request, session.user_id))
            assert exc.value.status_code == 502
            assert order_service.get_open_orders(session.session_id) == []
            with pytest.raises(HTTPException) as exc:
                asyncio.run(fill_missing_stoploss(request, session.user_id))
            assert exc.value.status_code == 409
            broker.place_sl_order.assert_called_once()
    finally:
        _clear(session.session_id)


def test_missing_sl_option_contract_isolation_and_real_broker_identity():
    from unittest.mock import Mock
    from app.routers.orders import MissingStoplossRequest, fill_missing_stoploss
    session = _session()
    session.session_type = "real"
    expiry = "2026-05-14"
    strike = 24100
    session.desktop_contract_quotes = {f"NIFTY:{expiry}:{strike}:CE": {"price": 100}}
    trading_service.record_trade(session.session_id, TradeSide.BUY, 100, 1778058900,
        quantity=130, symbol=session.symbol, right="CE", strike=strike, expiry=expiry,
        instrument_type="options", user_id=session.user_id)
    order_service.place_order(session_id=session.session_id, symbol=session.symbol,
        side=TradeSide.SELL, order_type=OrderType.LIMIT, quantity=65, created_at=1778058900,
        trading_date=session.date, limit_price=110, right="CE", strike=strike,
        expiry=expiry, user_id=session.user_id)
    order_service.place_order(session_id=session.session_id, symbol=session.symbol,
        side=TradeSide.SELL, order_type=OrderType.LIMIT, quantity=65, created_at=1778058900,
        trading_date=session.date, limit_price=110, right="CE", strike=strike,
        expiry=session.expiry, user_id=session.user_id)
    broker = Mock()
    broker.place_options_sl_order.return_value = "option-sl"
    try:
        with patch("app.services.kotak_service.get_service", return_value=broker):
            result = asyncio.run(fill_missing_stoploss(MissingStoplossRequest(
                session_id=session.session_id, request_id="contract", trigger_price=90,
                right="CE", strike=strike, expiry=expiry), session.user_id))
        assert result["quantity"] == 65
        kwargs = broker.place_options_sl_order.call_args.kwargs
        assert (kwargs["right"], kwargs["strike"], kwargs["expiry"], kwargs["qty"]) == ("CE", strike, expiry, 65)
    finally:
        _clear(session.session_id)


def test_missing_sl_large_real_options_split_in_whole_lots():
    from unittest.mock import Mock
    from app.routers.orders import MissingStoplossRequest, fill_missing_stoploss
    session = _session()
    session.session_type = "real"
    trading_service.record_trade(session.session_id, TradeSide.BUY, 100, 1778058900,
        quantity=1950, symbol=session.symbol, right="CE", strike=session.strike_ce,
        expiry=session.expiry, instrument_type="options", user_id=session.user_id)
    broker = Mock()
    broker.place_options_sl_order.side_effect = ["chunk-1", "chunk-2"]
    request = MissingStoplossRequest(session_id=session.session_id, request_id="split",
        trigger_price=90, right="CE", strike=session.strike_ce, expiry=session.expiry)
    try:
        with patch("app.services.kotak_service.get_service", return_value=broker):
            result = asyncio.run(fill_missing_stoploss(request, session.user_id))
            assert result["quantity"] == 1950
            assert len(result["orders"]) == 2
            assert all(o.quantity % 65 == 0 and o.quantity <= 1800 for o in result["orders"])
            assert sum(call.kwargs["qty"] for call in broker.place_options_sl_order.call_args_list) == 1950
            asyncio.run(fill_missing_stoploss(request, session.user_id))
            assert broker.place_options_sl_order.call_count == 2
    finally:
        _clear(session.session_id)


@pytest.mark.parametrize("state", ["flat", "ended", "no-quote", "lease-lost"])
def test_missing_sl_rejects_unavailable_position_or_engine(state):
    from app.routers.orders import MissingStoplossRequest, fill_missing_stoploss
    session = _equity_session(session_id=f"missing-sl-state-{state}")
    if state != "flat":
        trading_service.record_trade(session.session_id, TradeSide.BUY, 100, 1778058900,
            quantity=100, symbol=session.symbol, user_id=session.user_id)
    if state == "ended":
        session.state = SimulationState.ENDED
    if state == "no-quote":
        session.last_price = 0
    if state == "lease-lost":
        session.paper_lease_lost = True
    try:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(fill_missing_stoploss(MissingStoplossRequest(session_id=session.session_id,
                request_id=state, trigger_price=90), session.user_id))
        assert exc.value.status_code == 409
        assert order_service.get_open_orders(session.session_id) == []
    finally:
        _clear(session.session_id)


@pytest.mark.parametrize("mode", ["paper", "replay", "stepwise"])
@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_desktop_twelve_percent_equity_entry_creates_full_quantity_stop(no_db, mode, side):
    session = _equity_session(session_id=f"desktop-capital-sl-{mode}-{side.value}", mode=mode)
    session.session_capital = 100000
    stop = 90 if side == TradeSide.BUY else 110
    try:
        order = asyncio.run(desktop_trading.place_chart_order(session.session_id,
            desktop_trading.ChartOrderIntent(symbol=session.symbol, side=side,
                intent="limit", price=100, funds_ratio_pct=.12, entry_sl_price=stop),
            user_id="desktop-user"))
        assert order.quantity == 600
        assert order.reserved_amount == 12000
        assert not any(item.is_stoploss for item in order_service.get_open_orders(session.session_id))
        sim_svc._emit_tick_and_check_orders(session,
            {"time": 1778058901, "open": 100, "high": 100, "low": 100, "close": 100}, None)
        assert order.status == OrderStatus.FILLED
        stops = [item for item in order_service.get_open_orders(session.session_id) if item.is_stoploss]
        assert len(stops) == 1
        assert stops[0].quantity == 600
        assert stops[0].side == (TradeSide.SELL if side == TradeSide.BUY else TradeSide.BUY)
        assert stops[0].trigger_price == stop
        assert stops[0].reserved_amount == 0
    finally:
        _clear(session.session_id)


@pytest.mark.parametrize("mode", ["paper", "replay", "stepwise"])
def test_session_sizing_is_captured_once_and_display_settings_stay_live(mode):
    session = _equity_session(session_id=f"sizing-freeze-{mode}", mode=mode)
    initial = {**desktop_trading.get_settings(session.user_id), "desktop_order_size_mode": "funds_ratio"}
    changed = {**initial, "desktop_order_size_mode": "risk_ratio", "funds_ratio_h_pct": .24,
               "desktop_pnl_display_mode": "percent"}
    try:
        with patch.object(desktop_trading, "get_settings", return_value=initial), \
             patch.object(sim_svc, "_upsert_session_to_db") as persist:
            first = desktop_trading._snapshot(session, session.user_id)
            persist.assert_called_once_with(session, strict=True)
        with patch.object(desktop_trading, "get_settings", return_value=changed), \
             patch.object(sim_svc, "_upsert_session_to_db") as persist:
            later = desktop_trading._snapshot(session, session.user_id)
            persist.assert_not_called()
        assert first.settings["desktop_order_size_mode"] == later.settings["desktop_order_size_mode"] == "funds_ratio"
        assert later.settings["funds_ratio_h_pct"] == .12
        assert later.settings["desktop_pnl_display_mode"] == "percent"
        other = _equity_session(session_id=f"new-sizing-{mode}", mode=mode)
        with patch.object(desktop_trading, "get_settings", return_value=changed):
            assert desktop_trading._snapshot(other, other.user_id).settings["desktop_order_size_mode"] == "risk_ratio"
    finally:
        _clear(session.session_id)
        _clear(f"new-sizing-{mode}")


def test_session_sizing_capture_failure_can_retry():
    session = _equity_session(session_id="sizing-retry")
    try:
        with patch.object(sim_svc, "_upsert_session_to_db", side_effect=RuntimeError("offline")):
            with pytest.raises(HTTPException) as exc:
                desktop_trading._snapshot(session, session.user_id)
            assert exc.value.status_code == 503
            assert session.desktop_sizing_settings is None
        desktop_trading._snapshot(session, session.user_id)
        assert session.desktop_sizing_settings["desktop_order_size_mode"] == "quantity"
    finally:
        _clear(session.session_id)


def test_session_sizing_survives_database_round_trip():
    session = _equity_session(session_id="sizing-round-trip")
    try:
        desktop_trading._session_sizing_settings(session, {"desktop_order_size_mode": "funds_ratio"})
        with patch("app.services.db.get_dynamodb_resource") as resource:
            persist_session(session, strict=True)
            record = resource.return_value.Table.return_value.put_item.call_args.kwargs["Item"]
        assert str(record["desktop_sizing_settings"]["funds_ratio_h_pct"]) == "0.12"
        with patch("app.services.guardrail_service.initialize_guardrails"), \
             patch("app.services.trading.reload_trades_from_db"):
            restored = sim_svc.rebuild_session_from_db(record, session.user_id)
        assert restored.desktop_sizing_settings == session.desktop_sizing_settings
        with patch.object(desktop_trading, "get_settings", return_value={"desktop_order_size_mode": "risk_ratio"}):
            snapshot = desktop_trading._snapshot(restored, session.user_id)
        assert snapshot.settings["desktop_order_size_mode"] == "funds_ratio"
        assert snapshot.settings["funds_ratio_h_pct"] == .12
    finally:
        _clear(session.session_id)


def test_desktop_block_snapshot_and_exact_expiry(no_db):
    _clear()
    session = _session()
    result = asyncio.run(desktop_trading.desktop_block(session.session_id, session.user_id))
    state = result['snapshot'].guardrails
    assert state['blocked'] and state['type'] == 'BLOCK'
    assert state['settings']['guardrail_block_bars'] == 3
    session.current_time = str(result['until_bar'])
    assert desktop_trading._guardrail_snapshot(session)['blocked']
    session.current_time = str(result['until_bar'] + session.strategy_interval_secs)
    assert not desktop_trading._guardrail_snapshot(session)['blocked']


def test_desktop_block_rejects_other_user_and_ban(no_db):
    _clear()
    session = _session()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.desktop_block(session.session_id, 'other-user'))
    assert exc.value.status_code == 404
    session.guardrail_ban_active = True
    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.desktop_block(session.session_id, session.user_id))
    assert exc.value.status_code == 409


def test_guardrail_settings_shared_across_desktop_and_website():
    from app.routers import guardrails
    from app.models.schemas import GuardRailSettingsUpdateRequest
    saved = {}
    def update(user_id, values):
        assert user_id == 'desktop-user'
        saved.update(values)
        return saved.copy()
    with patch('app.services.user_settings_service.get_settings', side_effect=lambda user_id: saved.copy()), \
         patch('app.services.user_settings_service.update_settings', side_effect=update):
        asyncio.run(desktop_trading.desktop_save_guardrails(GuardRailSettingsUpdateRequest(guardrail_block_bars=7), 'desktop-user'))
        assert guardrails.get_settings('desktop-user').guardrail_block_bars == 7
        guardrails.update_settings(GuardRailSettingsUpdateRequest(guardrail_block_bars=2), 'desktop-user')
        assert asyncio.run(desktop_trading.desktop_guardrail_settings('desktop-user')).guardrail_block_bars == 2
    assert 'desktop_guardrail_block_bars' not in saved


def test_desktop_snapshot_keeps_cooldown_identity(no_db):
    from app.services.guardrail_service import _emit_guardrail_event
    session = _session()
    session.guardrail_block_until_bar = int(session.current_time) + 180
    _emit_guardrail_event(session, 'COOLDOWN', 'COOLDOWN: consecutive losses', session.guardrail_block_until_bar)
    state = desktop_trading._snapshot(session, session.user_id).guardrails
    assert state['type'] == 'COOLDOWN'
    assert state['reason'] == 'COOLDOWN: consecutive losses'


@pytest.mark.parametrize('kind', ['equity', 'options'])
@pytest.mark.parametrize('restriction', ['BLOCK', 'BAN', 'MAXSIZE'])
def test_desktop_entries_use_shared_guardrail_checks(no_db, kind, restriction):
    _clear()
    session = _session() if kind == 'options' else _equity_session()
    if restriction == 'BLOCK':
        session.guardrail_block_until_bar = int(session.current_time) + 180
    elif restriction == 'BAN':
        session.guardrail_ban_active = True
    else:
        session.guardrail_maxsize_enabled = True
        session.guardrail_maxsize_mode = 'value'
        session.guardrail_maxsize_value = 1
    intent = desktop_trading.ChartOrderIntent(
        symbol=session.symbol, side=TradeSide.BUY, intent='limit', price=100, quantity=65,
        right='CE' if kind == 'options' else None,
        strike=24000 if kind == 'options' else None,
        expiry=session.expiry if kind == 'options' else None,
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(desktop_trading.place_chart_order(session.session_id, intent, session.user_id))
    assert restriction in exc.value.detail
    assert exc.value.status_code == 403
