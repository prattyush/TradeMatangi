import asyncio
from datetime import datetime
from unittest.mock import Mock

import pytest

from app.config import EQUITY_MIS_MARGIN_RATE
from app.models.schemas import OrderType, OrderStatus, SimulationState, TradeSide
from app.routers import desktop_trading
from app.services import order_service, simulation as sim_svc, trading as trading_service, wallet_service


USER = "leverage-user"
DATE = "2026-05-06"
SESSION = "equity-leverage-session"
LEDGER = f"sim:{DATE}"


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    order_service.clear_session(SESSION)
    trading_service.clear_session(SESSION)
    sim_svc._sessions.pop(SESSION, None)
    wallet_service._wallets.clear()
    wallet_service._ledgers.clear()
    monkeypatch.setattr("app.services.simulation._upsert_session_to_db", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.order_service._write_order_to_db", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.trading._write_trade_to_db", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.wallet_service._write_wallet_to_db", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.wallet_service._write_ledger", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.wallet_service._ensure_ledger_table", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.services.guardrail_service.on_trade_record", lambda *args: None)
    monkeypatch.setattr("app.services.strategy_service.on_tick", lambda *args, **kwargs: None)
    monkeypatch.setattr("app.routers.desktop_trading._historical_context_trades", lambda *args: [])
    monkeypatch.setattr("app.routers.desktop_trading.get_settings", lambda *args: {})
    yield
    order_service.clear_session(SESSION)
    trading_service.clear_session(SESSION)
    sim_svc._sessions.pop(SESSION, None)
    wallet_service._wallets.clear()
    wallet_service._ledgers.clear()


def _equity_session(capital: float = 100_000.0) -> sim_svc.SimulationSession:
    wallet_service.reset_ledger(USER, DATE, LEDGER, capital, "sim")
    session = sim_svc.SimulationSession(
        session_id=SESSION,
        symbol="TATPOW",
        date=DATE,
        start_time="09:15:00",
        speed=1,
        user_id=USER,
        instrument_type="equity",
        session_type="sim",
        wallet_ledger_id=LEDGER,
    )
    session.state = SimulationState.RUNNING
    session.current_time = "1778058900"
    session.last_price = 100
    session.session_capital = capital
    sim_svc._sessions[SESSION] = session
    return session


def test_equity_funds_ratio_uses_five_x_buying_power():
    qty = order_service.compute_funds_ratio_quantity(
        "TATPOW",
        price=100,
        session_capital=100_000,
        funds_ratio_pct=0.24,
        current_wallet=100_000,
        lot_size=1,
        margin_rate=EQUITY_MIS_MARGIN_RATE,
    )

    assert qty == 1200


def test_leveraged_equity_round_trip_uses_actual_wallet_margin():
    session = _equity_session()
    quantity = order_service.compute_funds_ratio_quantity(
        "TATPOW",
        price=100,
        session_capital=session.session_capital,
        funds_ratio_pct=0.24,
        current_wallet=wallet_service.get_ledger_balance(USER, DATE, LEDGER, "sim"),
        lot_size=1,
        margin_rate=EQUITY_MIS_MARGIN_RATE,
    )

    buy = order_service.place_order(
        SESSION,
        "TATPOW",
        TradeSide.BUY,
        OrderType.LIMIT,
        quantity,
        1778058900,
        DATE,
        limit_price=100,
        user_id=USER,
        margin_rate=EQUITY_MIS_MARGIN_RATE,
        wallet_ledger_id=LEDGER,
        wallet_ledger_kind="sim",
    )

    assert quantity == 1200
    assert buy.reserved_amount == pytest.approx(24_000)
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER, "sim") == pytest.approx(76_000)

    sim_svc._emit_tick_and_check_orders(session, {"time": 1778058901, "open": 100, "high": 100, "low": 100, "close": 100}, None)

    sell = order_service.place_order(
        SESSION,
        "TATPOW",
        TradeSide.SELL,
        OrderType.LIMIT,
        quantity,
        1778058902,
        DATE,
        limit_price=100,
        user_id=USER,
        margin_rate=EQUITY_MIS_MARGIN_RATE,
        wallet_ledger_id=LEDGER,
        wallet_ledger_kind="sim",
    )
    assert sell.reserved_amount == 0

    sim_svc._emit_tick_and_check_orders(session, {"time": 1778058903, "open": 100, "high": 100, "low": 100, "close": 100}, None)

    assert trading_service.get_position(SESSION, symbol="TATPOW").side == "FLAT"
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER, "sim") == pytest.approx(100_000)


def _fill(session, side, price, quantity, **kwargs):
    trading_service.settle_wallet_for_trade(session, side, price, quantity, **kwargs)
    return trading_service.record_trade(
        SESSION, side, price, 1778058900, quantity=quantity,
        symbol=session.symbol, instrument_type="options" if kwargs.get("right") else "equity",
        right=kwargs.get("right"), strike=kwargs.get("strike"), expiry=kwargs.get("expiry"),
        user_id=USER, session_type=session.session_type,
    )


@pytest.mark.parametrize("entry_side,exit_side,exit_price", [
    (TradeSide.BUY, TradeSide.SELL, 70),
    (TradeSide.SELL, TradeSide.BUY, 130),
])
def test_close_debits_losses_exceeding_entry_margin(entry_side, exit_side, exit_price):
    session = _equity_session()
    _fill(session, entry_side, 100, 100)
    _fill(session, exit_side, exit_price, 100)
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == pytest.approx(97_000)


@pytest.mark.parametrize("entry_side,exit_side,expected", [
    (TradeSide.BUY, TradeSide.SELL, 105_000),
    (TradeSide.SELL, TradeSide.BUY, 95_000),
])
def test_partial_closes_settle_fifo_entry_cost(entry_side, exit_side, expected):
    session = _equity_session()
    _fill(session, entry_side, 100, 100)
    _fill(session, entry_side, 200, 100)
    _fill(session, exit_side, 150, 100)
    _fill(session, exit_side, 200, 100)
    assert trading_service.get_position(SESSION, session.symbol).side == "FLAT"
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == pytest.approx(expected)


@pytest.mark.parametrize("quantity,expected", [(50, 99_000), (100, 100_000), (150, 99_000)])
def test_reserved_buy_releases_cover_reservation(quantity, expected):
    session = _equity_session()
    _fill(session, TradeSide.SELL, 100, 100)
    order = order_service.place_order(
        SESSION, session.symbol, TradeSide.BUY, OrderType.LIMIT, quantity, 1778058900, DATE,
        limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER,
    )
    _fill(session, TradeSide.BUY, 100, quantity, entry_reserved=True, reserved_amount=order.reserved_amount)
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == pytest.approx(expected)


@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_desktop_stop_restores_leveraged_wallet(side):
    session = _equity_session()
    session.desktop_mode = "replay"
    _fill(session, side, 100, 100)
    desktop_trading._flatten_positions_for_stop(session, USER)
    assert trading_service.get_position(SESSION, session.symbol).side == "FLAT"
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == pytest.approx(100_000)


def _attach_option(session):
    contract = {"symbol": session.symbol, "right": "CE", "strike": 400, "expiry": "2026-05-07",
                "contract_key": f"{session.symbol}:2026-05-07:400:CE"}
    session.desktop_contracts = [contract]
    session.strike_ce = 400
    session.expiry = contract["expiry"]
    return contract


def _tick(price, timestamp=1778058901):
    return {"time": timestamp, "open": price, "high": price, "low": price, "close": price}


@pytest.mark.parametrize("stepwise", [False, True])
def test_equity_engine_fills_attached_options_and_stop_closes_both(monkeypatch, stepwise):
    session = _equity_session()
    session.stepwise = stepwise
    session.session_type = "stepwise" if stepwise else "sim"
    session.speed = 0
    session.desktop_mode = "stepwise" if stepwise else "replay"
    session.resume_event.set()
    contract = _attach_option(session)
    monkeypatch.setattr(sim_svc, "iter_ticks", lambda *args: iter([_tick(100)]))
    monkeypatch.setattr("app.services.options_service.options_iter_ticks", lambda *args: iter([_tick(10)]))
    equity = order_service.place_order(SESSION, session.symbol, TradeSide.BUY, OrderType.LIMIT, 100,
        1778058900, DATE, limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER)
    option = order_service.place_order(SESSION, session.symbol, TradeSide.BUY, OrderType.LIMIT, 2700,
        1778058900, DATE, limit_price=10, user_id=USER, wallet_ledger_id=LEDGER,
        right=contract["right"], strike=contract["strike"], expiry=contract["expiry"])

    asyncio.run(sim_svc._run_session(session))

    assert equity.status == option.status == OrderStatus.FILLED
    trades = trading_service.get_trades(SESSION)
    assert [trade.instrument_type for trade in trades] == ["equity", "options"]
    assert trades[1].strike == 400 and trades[1].expiry == contract["expiry"]
    assert session.last_price_ce == 10
    assert desktop_trading._day_pnl(session) == pytest.approx(-sum(t.commission for t in trades), abs=.01)
    desktop_trading._flatten_positions_for_stop(session, USER)
    assert trading_service.get_position(SESSION, session.symbol).side == "FLAT"
    assert trading_service.get_position(SESSION, session.symbol, "CE", 400, contract["expiry"]).side == "FLAT"
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == pytest.approx(100_000)
    assert trading_service.get_trades(SESSION)[-1].instrument_type == "options"


@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_mixed_flatten_uses_quotes_and_correct_ledger_without_new_reservation(monkeypatch, side):
    session = _equity_session()
    session.desktop_mode = "replay"
    contract = _attach_option(session)
    monkeypatch.setattr("app.services.options_service.options_iter_ticks", lambda *args: iter([_tick(10, 1778058900), _tick(10)]))
    _fill(session, side, 100, 100)
    _fill(session, TradeSide.BUY, 10, 2700, right="CE", strike=400, expiry=contract["expiry"])
    result = asyncio.run(desktop_trading.flatten(SESSION, desktop_trading.FlattenRequest(emergency_offset_pct=.001), USER))
    assert len(result["created"]) == 2
    for order in order_service.get_open_orders(SESSION):
        assert order.wallet_ledger_id == LEDGER
        assert order.reserved_amount == 0
        expected_price = 9.99 if order.right else (99.9 if side == TradeSide.BUY else 100.1)
        assert order.limit_price == pytest.approx(expected_price)
    sim_svc._emit_tick_and_check_orders(session, _tick(100), None)
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == pytest.approx(100_000)


@pytest.mark.parametrize("failure", ["rejected", "submission"])
def test_real_order_failure_refunds_owning_ledger(monkeypatch, failure):
    from app.services.kotak_service import KotakError
    session = _equity_session()
    session.session_type = "real"
    broker = Mock()
    if failure == "submission":
        broker.place_limit_order.side_effect = KotakError("failed")
    else:
        broker.place_limit_order.return_value = "broker-id"
    monkeypatch.setattr("app.services.kotak_service.get_service", lambda: broker)
    order = order_service.place_order(SESSION, session.symbol, TradeSide.BUY, OrderType.LIMIT, 100,
        1778058900, DATE, limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER)
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 98_000
    sim_svc._emit_tick_and_check_orders_real(session, _tick(100), None, Mock())
    if failure == "rejected":
        callback = broker.register_reject_callback.call_args.args[1]
        callback("broker-id", "rejected")
    assert order.status == OrderStatus.CANCELLED
    assert order.reserved_amount == 0
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 100_000


@pytest.mark.parametrize("source", ["kite", "kotak", "fyers", "breeze"])
def test_paper_option_subscription_routes_identity_and_cleans_up(monkeypatch, source):
    session = _equity_session()
    session.session_type = "paper"
    session.paper_stream_source = source
    contract = _attach_option(session)
    provider = Mock()
    order = order_service.place_order(SESSION, session.symbol, TradeSide.BUY, OrderType.LIMIT, 2700,
        1778058900, DATE, limit_price=10, user_id=USER, wallet_ledger_id=LEDGER,
        right="CE", strike=400, expiry=contract["expiry"], wallet_ledger_kind="paper")
    if source == "kite":
        monkeypatch.setattr("app.services.kite_service.get_broadcaster", lambda: provider)
        monkeypatch.setattr("app.services.kite_service.fetch_options_instrument_token", lambda *args: 123)
    elif source == "kotak":
        monkeypatch.setattr("app.services.kotak_service.get_kotak_broadcaster", lambda: provider)
        monkeypatch.setattr("app.services.kotak_service.fetch_kotak_options_instrument_token", lambda *args: ("123", "nse_fo"))
    elif source == "fyers":
        monkeypatch.setattr("app.services.fyers_service.get_fyers_broadcaster", lambda: provider)
        monkeypatch.setattr("app.services.fyers_service._fyers_options_symbol", lambda *args: "option-symbol")
    else:
        monkeypatch.setattr("app.services.breeze_service.BreezeStreamManager", lambda: provider)
    async def subscribe_and_receive():
        sim_svc.subscribe_desktop_option_contract(session, contract)
        sim_svc.subscribe_desktop_option_contract(session, contract)
        queue = provider.start.call_args.args[0] if source == "breeze" else provider.register.call_args.args[-2]
        queue.put_nowait(_tick(10))
        return await session.paper_tick_queue.get()
    payload = asyncio.run(subscribe_and_receive())
    assert payload["contract_key"] == contract["contract_key"]
    assert payload["strike"] == 400 and payload["expiry"] == contract["expiry"]
    sim_svc._emit_tick_and_check_orders(session, payload, "CE")
    assert order.status == OrderStatus.FILLED
    assert trading_service.get_trades(SESSION)[0].instrument_type == "options"
    assert desktop_trading._last_price_for_right(session, "CE", 400, contract["expiry"]) == 10
    if source == "breeze":
        provider.start.assert_called_once()
    else:
        provider.register.assert_called_once()
    sim_svc._stop_desktop_option_subscriptions(session)
    assert session.desktop_option_subscriptions == {}
    if source == "breeze":
        provider.stop.assert_called_once()
    else:
        provider.unregister.assert_called_once()


def test_eod_closes_mixed_positions_using_each_contract_tick(monkeypatch):
    session = _equity_session()
    contract = _attach_option(session)
    timestamp = int(datetime.fromisoformat(f"{DATE}T15:09:00+00:00").timestamp())
    monkeypatch.setattr("app.services.options_service.options_iter_ticks", lambda *args: iter([_tick(10, timestamp)]))
    _fill(session, TradeSide.BUY, 100, 100)
    _fill(session, TradeSide.BUY, 10, 2700, right="CE", strike=400, expiry=contract["expiry"])
    order_service.place_order(SESSION, session.symbol, TradeSide.SELL, OrderType.LIMIT, 100,
        1778058900, DATE, limit_price=200, user_id=USER, wallet_ledger_id=LEDGER)
    session.current_time = str(timestamp)
    sim_svc._emit_tick_and_check_orders(session, _tick(100, timestamp), None)
    assert trading_service.get_position(SESSION, session.symbol).side == "FLAT"
    assert trading_service.get_position(SESSION, session.symbol, "CE", 400, contract["expiry"]).side == "FLAT"
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == pytest.approx(100_000)


def test_stepwise_attaches_option_after_engine_has_started(monkeypatch):
    session = _equity_session()
    session.session_type = "stepwise"
    session.stepwise = True
    session.desktop_mode = "stepwise"
    session.resume_event.set()
    second_timestamp = 1778058900 + 180
    monkeypatch.setattr(sim_svc, "iter_ticks", lambda *args: iter([_tick(100, 1778058900), _tick(100, second_timestamp)]))
    monkeypatch.setattr("app.services.options_service.options_iter_ticks", lambda *args: iter([_tick(10, second_timestamp)]))
    monkeypatch.setattr(desktop_trading.simulation_router, "_ensure_options_data", lambda *args: None)

    async def run():
        task = asyncio.create_task(sim_svc._run_session(session))
        try:
            await asyncio.wait_for(session.bar_paused_event.wait(), 2)
            await desktop_trading.attach_contract(SESSION, desktop_trading.AttachContractRequest(
                symbol=session.symbol, right="CE", strike=400, expiry="2026-05-07"), USER)
            order = order_service.place_order(SESSION, session.symbol, TradeSide.BUY, OrderType.LIMIT, 2700,
                1778058900, DATE, limit_price=10, user_id=USER, wallet_ledger_id=LEDGER,
                right="CE", strike=400, expiry="2026-05-07")
            session.step_event.set()
            await asyncio.wait_for(task, 2)
            return order
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    order = asyncio.run(run())
    assert order.status == OrderStatus.FILLED
    assert trading_service.get_position(SESSION, session.symbol, "CE", 400, "2026-05-07").quantity == 2700


@pytest.mark.parametrize("mode", ["paper", "sim", "stepwise"])
@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_equity_pending_entries_reserve_and_release_both_directions(mode, side):
    session = _equity_session()
    session.session_type = mode
    order = order_service.place_order(SESSION, session.symbol, side, OrderType.LIMIT,
        100, 1778058900, DATE, limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER)
    assert order.reserved_amount == 2_000
    order_service.update_order(SESSION, order.order_id, DATE, limit_price=110)
    assert order.reserved_amount == 2_200
    order_service.convert_order(SESSION, order.order_id, OrderType.TARGET, DATE, price=100)
    assert order.reserved_amount == pytest.approx(2_020 if side == TradeSide.BUY else 1_980)
    order_service.cancel_order(SESSION, order.order_id, DATE)
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 100_000
    assert order.reserved_amount == 0


@pytest.mark.parametrize("side,exit_side", [(TradeSide.BUY, TradeSide.SELL), (TradeSide.SELL, TradeSide.BUY)])
def test_close_reserves_no_fresh_margin_and_reversal_only_reserves_opening_part(side, exit_side):
    session = _equity_session()
    _fill(session, side, 100, 100)
    close = order_service.place_order(SESSION, session.symbol, exit_side, OrderType.LIMIT,
        100, 1778058900, DATE, limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER)
    assert close.reserved_amount == 0
    order_service.cancel_order(SESSION, close.order_id, DATE)
    reversal = order_service.place_order(SESSION, session.symbol, exit_side, OrderType.LIMIT,
        150, 1778058900, DATE, limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER)
    assert reversal.reserved_amount == 1_000
    sim_svc._emit_tick_and_check_orders(session, _tick(100), None)
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 99_000
    position = trading_service.get_position(SESSION, session.symbol)
    assert position.quantity == 50
    assert position.side == ("SHORT" if side == TradeSide.BUY else "LONG")


def test_equity_risk_never_forces_an_unaffordable_share():
    with pytest.raises(ValueError, match="Risk budget"):
        order_service.compute_risk_ratio_quantity("TATPOW", 100, 50, 100, .045, 100, margin_rate=.2)
    assert order_service.compute_risk_ratio_quantity("TATPOW", 100, 99, 100_000, .045, 100_000, margin_rate=.2) == 4500
    assert order_service.compute_funds_ratio_quantity("TATPOW", 100, 100_000, .24, 100_000, margin_rate=.2) == 1200


def test_paper_contract_attachment_works_when_historical_provider_fails(monkeypatch):
    session = _equity_session()
    session.session_type = "paper"
    session.paper_stream_source = "kite"
    monkeypatch.setattr(desktop_trading.simulation_router, "_ensure_options_data", Mock(side_effect=RuntimeError("historical offline")))
    subscription = Mock()
    monkeypatch.setattr(sim_svc, "subscribe_desktop_option_contract", subscription)
    contract = desktop_trading.AttachContractRequest(symbol=session.symbol, right="CE", strike=400, expiry="2026-05-07")
    asyncio.run(desktop_trading.attach_contract(SESSION, contract, USER))
    assert subscription.call_count == 1
    assert session.desktop_contracts[0]["strike"] == 400


def test_failed_paper_subscription_does_not_register_contract(monkeypatch):
    from fastapi import HTTPException
    session = _equity_session()
    session.session_type = "paper"
    session.paper_stream_source = "kite"
    monkeypatch.setattr(desktop_trading.simulation_router, "_ensure_options_data", lambda *args: None)
    monkeypatch.setattr(sim_svc, "subscribe_desktop_option_contract", Mock(side_effect=RuntimeError("live offline")))
    contract = desktop_trading.AttachContractRequest(symbol=session.symbol, right="CE", strike=400, expiry="2026-05-07")
    with pytest.raises(HTTPException):
        asyncio.run(desktop_trading.attach_contract(SESSION, contract, USER))
    assert not session.desktop_contracts
    assert session.strike_ce is None


@pytest.mark.parametrize("maxsize_mode", ["percentage", "value"])
@pytest.mark.parametrize("mode", ["sim", "stepwise", "paper"])
@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_website_fifteen_percent_equity_order_uses_margin_for_maxsize(mode, side, maxsize_mode):
    from app.models.schemas import PlaceOrderRequest
    from app.routers import orders
    from app.services import guardrail_service
    session = _equity_session()
    session.session_type = mode
    session.guardrail_maxsize_enabled = True
    session.guardrail_maxsize_pct = 20
    session.guardrail_maxsize_mode = maxsize_mode
    session.guardrail_maxsize_value = 20_000
    order = asyncio.run(orders.place_order(PlaceOrderRequest(session_id=SESSION, side=side,
        order_type=OrderType.LIMIT, limit_price=100, funds_ratio_pct=.15)))
    assert order.quantity == 750  # ₹75,000 notional, with leverage applied once.
    assert order.reserved_amount == 15_000
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 85_000
    sim_svc._emit_tick_and_check_orders(session, _tick(100), None)
    assert guardrail_service._get_capital_in_use(session) == 15_000
    assert trading_service.get_position(SESSION, session.symbol).side == ("LONG" if side == TradeSide.BUY else "SHORT")


@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_website_direct_fifteen_percent_equity_trade_uses_margin_for_maxsize(side):
    from app.models.schemas import TradeRequest
    from app.routers import trading
    session = _equity_session()
    session.guardrail_maxsize_enabled = True
    session.guardrail_maxsize_pct = 20
    route = trading.buy if side == TradeSide.BUY else trading.sell
    trade = asyncio.run(route(TradeRequest(session_id=SESSION, funds_ratio_pct=.15)))
    assert trade.quantity == 750
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 85_000


@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
def test_website_equity_maxsize_still_blocks_margin_above_limit(side):
    from fastapi import HTTPException
    from app.models.schemas import PlaceOrderRequest
    from app.routers import orders
    session = _equity_session()
    session.guardrail_maxsize_enabled = True
    session.guardrail_maxsize_pct = 20
    with pytest.raises(HTTPException) as exc:
        asyncio.run(orders.place_order(PlaceOrderRequest(session_id=SESSION, side=side,
            order_type=OrderType.LIMIT, limit_price=100, funds_ratio_pct=.25)))
    assert exc.value.status_code == 403
    assert "25,000.00" in exc.value.detail
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 100_000
    assert order_service.get_open_orders(SESSION) == []


@pytest.mark.parametrize("side,stop", [(TradeSide.BUY, 96), (TradeSide.SELL, 104)])
def test_website_risk_sizing_is_not_multiplied_by_leverage(side, stop):
    from app.models.schemas import PlaceOrderRequest
    from app.routers import orders
    session = _equity_session()
    session.guardrail_maxsize_enabled = True
    session.guardrail_maxsize_pct = 6
    order = asyncio.run(orders.place_order(PlaceOrderRequest(session_id=SESSION, side=side,
        order_type=OrderType.LIMIT, limit_price=100, risk_pct=1, entry_sl_price=stop)))
    assert order.quantity == 250  # ₹1,000 risk / ₹4 distance, with no 5x risk scaling.
    assert order.reserved_amount == 5_000


@pytest.mark.parametrize("entry,close", [(TradeSide.BUY, "SELL"), (TradeSide.SELL, "BUY")])
def test_equity_maxsize_allows_reducing_position_above_limit(entry, close):
    from app.services import guardrail_service
    session = _equity_session()
    _fill(session, entry, 100, 750)
    session.guardrail_maxsize_enabled = True
    session.guardrail_maxsize_pct = 10
    assert guardrail_service.check_maxsize(session, 100, 100, close) == (False, "")
    # Reversal leaves a new position whose margin still exceeds the limit.
    blocked, reason = guardrail_service.check_maxsize(session, 100, 1550, close)
    assert blocked and "16,000.00" in reason
    blocked, reason = guardrail_service.check_maxsize(session, 100, 1300, close)
    assert blocked and "11,000.00" in reason


def test_maxsize_mixed_contracts_preserves_other_positions_when_closing(monkeypatch):
    from app.services import guardrail_service
    monkeypatch.setattr("app.services.options_service.get_underlying_price_at", lambda *args: 100)
    session = _equity_session()
    _fill(session, TradeSide.BUY, 100, 750)
    _fill(session, TradeSide.BUY, 10, 100, right="CE", strike=400, expiry="2026-05-07")
    _fill(session, TradeSide.BUY, 20, 100, right="CE", strike=450, expiry="2026-05-07")
    assert guardrail_service._get_capital_in_use(session) == 18_000
    assert guardrail_service._simulate_post_trade_capital(session, 100, 750, "SELL") == 3_000
    assert guardrail_service._simulate_post_trade_capital(session, 10, 100, "SELL", "CE", 400, "2026-05-07") == 17_000


@pytest.mark.parametrize("side", [TradeSide.BUY, TradeSide.SELL])
@pytest.mark.parametrize("fraction", [0, -0.15, 1.15, 0.000001])
def test_direct_equity_invalid_or_sub_share_allocation_is_client_error(side, fraction):
    from fastapi import HTTPException
    from app.models.schemas import TradeRequest
    from app.routers import trading
    _equity_session()
    route = trading.buy if side == TradeSide.BUY else trading.sell
    with pytest.raises(HTTPException) as exc:
        asyncio.run(route(TradeRequest(session_id=SESSION, funds_ratio_pct=fraction)))
    assert exc.value.status_code == 400
    assert wallet_service.get_ledger_balance(USER, DATE, LEDGER) == 100_000


@pytest.mark.parametrize("side,close,exit_price", [(TradeSide.BUY, TradeSide.SELL, 110), (TradeSide.SELL, TradeSide.BUY, 90)])
def test_equity_display_capital_includes_pending_and_open_committed_funds(side, close, exit_price):
    from app.routers.wallet import _session_wallet_metrics
    session = _equity_session()
    order = order_service.place_order(SESSION, session.symbol, side, OrderType.LIMIT,
        750, 1778058900, DATE, limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER)
    balance = wallet_service.get_ledger_balance(USER, DATE, LEDGER)
    assert balance == 85_000
    assert _session_wallet_metrics(session, balance)["capital_balance"] == 100_000
    sim_svc._emit_tick_and_check_orders(session, _tick(100), None)
    assert order.status == OrderStatus.FILLED
    assert _session_wallet_metrics(session, balance)["capital_balance"] == 100_000
    _fill(session, close, exit_price, 750)
    balance = wallet_service.get_ledger_balance(USER, DATE, LEDGER)
    assert balance == 107_500
    assert _session_wallet_metrics(session, balance)["capital_balance"] == 107_500


def test_equity_display_capital_does_not_increase_on_reservation_cancel():
    from app.routers.wallet import _session_wallet_metrics
    session = _equity_session()
    order = order_service.place_order(SESSION, session.symbol, TradeSide.SELL, OrderType.LIMIT,
        750, 1778058900, DATE, limit_price=100, user_id=USER, margin_rate=.2, wallet_ledger_id=LEDGER)
    order_service.cancel_order(SESSION, order.order_id, DATE)
    balance = wallet_service.get_ledger_balance(USER, DATE, LEDGER)
    assert balance == 100_000
    assert _session_wallet_metrics(session, balance)["capital_balance"] == 100_000
