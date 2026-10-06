"""Broker-backed exits and local entry triggers share website/desktop execution paths."""
import asyncio
from unittest.mock import MagicMock
import pytest
from fastapi import HTTPException
from app.models.schemas import OrderType, TradeSide, Position, ConvertOrderRequest, UpdateOrderRequest, PlaceOrderRequest
from app.services import simulation, order_service, trading, kotak_service
from app.routers import orders, desktop_trading

@pytest.fixture
def env(monkeypatch):
    s = simulation.SimulationSession(session_id="exit-routing", symbol="RELIANCE", date="2026-10-01",
        start_time="09:15:00", speed=1, user_id="exit-user", session_type="real", session_capital=10000)
    s.current_time = "1790826300"
    broker = MagicMock()
    broker.place_limit_order.return_value = "broker-limit"
    broker.place_sl_order.return_value = "broker-sl"
    broker.place_options_limit_order.return_value = "broker-option-limit"
    position = MagicMock(return_value=Position(symbol=s.symbol, side="LONG", quantity=10, avg_entry_price=100))
    monkeypatch.setattr(trading, "get_position", position)
    monkeypatch.setattr(simulation, "get_session", lambda sid: s)
    monkeypatch.setattr(kotak_service, "get_service", lambda: broker)
    monkeypatch.setattr(order_service, "_write_order_to_db", MagicMock())
    monkeypatch.setattr(order_service, "_adjust_buy_reservation", lambda *a, **k: None)
    monkeypatch.setattr("app.services.wallet_service.debit", lambda *a, **k: None)
    monkeypatch.setattr("app.services.guardrail_service.check_guardrails", lambda *a: (False, ""))
    monkeypatch.setattr(orders, "_wallet_balance_for_session", lambda s: 10000)
    monkeypatch.setattr(trading, "settle_wallet_for_trade", MagicMock())
    monkeypatch.setattr(trading, "record_trade", MagicMock())
    monkeypatch.setattr("app.services.strategy_service.on_tick", lambda *a, **k: None)
    monkeypatch.setattr("app.services.strategy_service.list_running", lambda *a: [])
    order_service._orders[s.session_id] = {}
    yield s, broker, position
    order_service._orders.pop(s.session_id, None)


def local(s, kind=OrderType.STOPLOSS, side=TradeSide.SELL, **kwargs):
    return order_service.place_order(session_id=s.session_id, symbol=s.symbol, side=side,
        order_type=kind, quantity=1, created_at=int(s.current_time), trading_date=s.date,
        trigger_price=90, limit_price=110, **kwargs)

@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [OrderType.LIMIT, OrderType.STOPLOSS])
@pytest.mark.parametrize("position_side,side", [("LONG", TradeSide.SELL), ("SHORT", TradeSide.BUY)])
async def test_exit_creation_is_immediate_broker_order(env, kind, position_side, side):
    s, broker, position = env
    position.return_value = Position(symbol=s.symbol, side=position_side, quantity=10, avg_entry_price=100)
    o = await orders.place_order(PlaceOrderRequest(session_id=s.session_id, side=side,
        order_type=kind, quantity=1, trigger_price=90, limit_price=110))
    method = broker.place_limit_order if kind == OrderType.LIMIT else broker.place_sl_order
    assert o.kotak_order_id == method.return_value
    assert method.call_count == 1
    assert method.call_args.kwargs["side"] == ("B" if side == TradeSide.BUY else "S")
    if kind == OrderType.LIMIT:
        assert method.call_args.kwargs["price"] == 110

@pytest.mark.asyncio
@pytest.mark.parametrize("kind", list(OrderType))
async def test_new_long_entries_stay_local_until_trigger(env, kind):
    s, broker, position = env
    position.return_value = Position(symbol=s.symbol, side="FLAT", quantity=0, avg_entry_price=0)
    o = await orders.place_order(PlaceOrderRequest(session_id=s.session_id, side=TradeSide.BUY,
        order_type=kind, quantity=1, trigger_price=100, limit_price=100))
    assert not o.kotak_order_id
    broker.place_limit_order.assert_not_called()
    broker.place_sl_order.assert_not_called()
    simulation._emit_tick_and_check_orders_real(s, {"time": int(s.current_time), "close": 100}, None, asyncio.get_running_loop())
    broker.place_limit_order.assert_called_once()
    assert o.kotak_order_id == "broker-limit"

@pytest.mark.asyncio
async def test_exit_conversion_reuses_broker_id_with_exact_limit(env):
    s, broker, _ = env
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    result = await orders.convert_order(o.order_id, ConvertOrderRequest(session_id=s.session_id,
        new_order_type=OrderType.LIMIT, price=120))
    broker.modify_sl_to_limit_order.assert_called_once_with("broker-sl", 120, 1)
    assert result.order_type == OrderType.LIMIT and result.kotak_order_id == "broker-sl"
    simulation._emit_tick_and_check_orders_real(s, {"time": int(s.current_time), "close": 121}, None, asyncio.get_running_loop())
    broker.place_limit_order.assert_not_called()
    assert result.status.value == "PENDING"

@pytest.mark.asyncio
async def test_rejected_conversion_keeps_original_stoploss(env):
    s, broker, _ = env
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    broker.modify_sl_to_limit_order.side_effect = kotak_service.KotakError("rejected")
    with pytest.raises(HTTPException) as error:
        await orders.convert_order(o.order_id, ConvertOrderRequest(session_id=s.session_id,
            new_order_type=OrderType.LIMIT, price=120))
    assert error.value.status_code == 502
    assert o.order_type == OrderType.STOPLOSS and o.trigger_price == 90 and o.kotak_order_id == "broker-sl"

@pytest.mark.asyncio
async def test_limit_drag_uses_limit_modify_and_failure_keeps_price(env):
    s, broker, _ = env
    o = local(s, OrderType.LIMIT)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    await orders.update_order(o.order_id, UpdateOrderRequest(limit_price=120), session_id=s.session_id)
    broker.modify_sl_to_limit_order.assert_called_once_with("broker-limit", 120, 1)
    broker.modify_sl_order.assert_not_called()
    broker.modify_sl_to_limit_order.side_effect = kotak_service.KotakError("reject price")
    with pytest.raises(HTTPException):
        await orders.update_order(o.order_id, UpdateOrderRequest(limit_price=125), session_id=s.session_id)
    assert o.limit_price == 120

@pytest.mark.asyncio
async def test_exact_option_contract_sent_to_broker(env):
    s, broker, position = env
    s.instrument_type = "options"
    s.symbol = "BSESEN"
    o = local(s, OrderType.LIMIT, right="PE", strike=71200, expiry="2026-10-01")
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    assert position.call_args.kwargs == {"right": "PE", "strike": 71200, "expiry": "2026-10-01"}
    broker.place_options_limit_order.assert_called_once_with(symbol="BSESEN", side="S", qty=1,
        right="PE", strike=71200, expiry="2026-10-01", price=110)

@pytest.mark.asyncio
async def test_different_contract_has_no_exit_position(env):
    s, broker, position = env
    position.side_effect = lambda *a, **k: Position(symbol=s.symbol, side="LONG" if k.get("strike") == 71200 else "FLAT", quantity=10 if k.get("strike") == 71200 else 0, avg_entry_price=100)
    o = local(s, OrderType.LIMIT, right="PE", strike=71300, expiry="2026-10-01")
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    assert not o.kotak_order_id
    broker.place_options_limit_order.assert_not_called()

@pytest.mark.asyncio
async def test_fill_callback_is_idempotent_and_persists_confirmation(env):
    s, broker, _ = env
    o = local(s, OrderType.LIMIT)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    callback = broker.register_fill_callback.call_args.args[1]
    callback("broker-limit", "S", 1, 112)
    callback("broker-limit", "S", 1, 112)
    assert o.kotak_fill_confirmed and o.filled_price == 112
    trading.record_trade.assert_called_once()
    trading.settle_wallet_for_trade.assert_not_called()  # real funds are broker-owned
    assert order_service._write_order_to_db.call_args.args[0].kotak_fill_confirmed

@pytest.mark.asyncio
async def test_desktop_bulk_conversion_uses_same_broker_path(env):
    s, broker, _ = env
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    result = await desktop_trading.bulk_convert(s.session_id,
        desktop_trading.BulkChartConvertRequest(new_order_type=OrderType.LIMIT, price=120), s.user_id)
    assert result["converted"] == 1
    broker.modify_sl_to_limit_order.assert_called_once_with("broker-sl", 120, 1)

@pytest.mark.asyncio
async def test_entry_conversion_is_local(env):
    s, broker, position = env
    position.return_value = Position(symbol=s.symbol, side="FLAT", quantity=0, avg_entry_price=0)
    o = local(s, OrderType.TARGET, TradeSide.BUY)
    await orders.convert_order(o.order_id, ConvertOrderRequest(session_id=s.session_id,
        new_order_type=OrderType.LIMIT, price=80))
    assert not o.kotak_order_id
    broker.modify_sl_to_limit_order.assert_not_called()
    broker.place_limit_order.assert_not_called()

@pytest.mark.asyncio
async def test_broker_placement_failure_cancels_local_exit(env):
    s, broker, _ = env
    broker.place_limit_order.side_effect = kotak_service.KotakError("unavailable")
    with pytest.raises(HTTPException) as error:
        await orders.place_order(PlaceOrderRequest(session_id=s.session_id, side=TradeSide.SELL,
            order_type=OrderType.LIMIT, quantity=1, limit_price=110))
    assert error.value.status_code == 502
    assert all(o.status.value == "CANCELLED" for o in order_service._orders[s.session_id].values())

@pytest.mark.asyncio
async def test_broker_cancel_failure_keeps_exit_pending(env):
    s, broker, _ = env
    o = local(s, OrderType.LIMIT)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    broker.cancel_order.side_effect = kotak_service.KotakError("cancel refused")
    with pytest.raises(HTTPException) as error:
        await orders.cancel_order(o.order_id, session_id=s.session_id)
    assert error.value.status_code == 502 and o.status.value == "PENDING"

@pytest.mark.asyncio
async def test_exit_target_conversion_cancels_broker_then_becomes_local(env):
    s, broker, _ = env
    o = local(s, OrderType.LIMIT)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    await orders.convert_order(o.order_id, ConvertOrderRequest(session_id=s.session_id,
        new_order_type=OrderType.TARGET, price=95))
    broker.cancel_order.assert_called_once_with("broker-limit", purpose="conversion")
    assert not o.kotak_order_id and o.order_type == OrderType.TARGET
    assert o.order_id not in s.kotak_order_map

@pytest.mark.asyncio
async def test_paper_exit_conversion_never_uses_broker(env):
    s, broker, _ = env
    s.session_type = "paper"
    o = local(s)
    await orders.convert_order(o.order_id, ConvertOrderRequest(session_id=s.session_id,
        new_order_type=OrderType.LIMIT, price=110))
    assert o.order_type == OrderType.LIMIT
    assert not broker.method_calls


def test_kotak_conversion_payload_is_plain_limit(env, monkeypatch):
    s, broker, _ = env
    svc, client = kotak_service.KotakNeoService(), MagicMock()
    monkeypatch.setattr(svc, "_get_client", lambda: client)
    client.modify_order.return_value = {"stat": "Ok"}
    svc.modify_sl_to_limit_order("existing", 42, 20)
    payload = client.modify_order.call_args.kwargs
    assert payload["order_type"] == "L" and payload["trigger_price"] == "0"
    assert float(payload["price"]) == 42 and payload["quantity"] == "20"


def test_short_cover_limit_reserves_no_entry_capital(env):
    s, _, position = env
    position.return_value = Position(symbol=s.symbol, side="SHORT", quantity=10, avg_entry_price=100)
    o = local(s, OrderType.LIMIT, TradeSide.BUY, wallet_ledger_kind="real")
    assert o.reserved_amount == 0
    assert order_service._reservation_for(o, 120) == 0

@pytest.mark.asyncio
async def test_real_market_entry_submits_before_any_tick(env):
    s, broker, position = env
    position.return_value = Position(symbol=s.symbol, side="FLAT", quantity=0, avg_entry_price=0)
    o = await orders.place_order(PlaceOrderRequest(session_id=s.session_id, side=TradeSide.BUY,
        order_type=OrderType.LIMIT, quantity=1, limit_price=101, execute_immediately=True, entry_sl_price=90))
    broker.place_limit_order.assert_called_once()
    assert o.kotak_order_id and o.execution_role == 'entry' and o.entry_sl_price == 90
    assert o.status.value == 'PENDING'

@pytest.mark.asyncio
async def test_strategy_limit_price_edit_retains_broker_limit_type(env):
    from app.services.strategy_service import _update_exit_order_price
    s, broker, _ = env
    o = local(s, OrderType.LIMIT)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    _update_exit_order_price(s, o, 125)
    broker.modify_sl_to_limit_order.assert_called_once_with('broker-limit', 125, 1)
    broker.modify_sl_order.assert_not_called()
    assert o.limit_price == 125

@pytest.mark.asyncio
async def test_late_cancel_callback_does_not_cancel_converted_local_target(env):
    s, broker, _ = env
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    callback = broker.register_reject_callback.call_args.args[1]
    await orders.convert_order(o.order_id, ConvertOrderRequest(session_id=s.session_id, new_order_type=OrderType.TARGET, price=120))
    callback('broker-sl', 'cancelled')
    assert o.status.value == 'PENDING' and o.order_type == OrderType.TARGET and o.kotak_order_id is None

@pytest.mark.asyncio
async def test_slow_broker_edit_does_not_block_loop(env):
    import threading
    s, broker, _ = env
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    started, release = threading.Event(), threading.Event()
    loop_thread = threading.get_ident()
    worker_threads = []
    def modify(*args):
        worker_threads.append(threading.get_ident())
        started.set()
        assert release.wait(2)
        return o.kotak_order_id
    broker.modify_sl_order.side_effect = modify
    edit = asyncio.create_task(orders.update_order(o.order_id, UpdateOrderRequest(trigger_price=95), session_id=s.session_id))
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(.001)
        assert started.is_set() and not edit.done()
        assert worker_threads[0] != loop_thread
        assert o.trigger_price == 90
    finally:
        release.set()
        await edit
    assert o.trigger_price == 95


@pytest.mark.asyncio
async def test_fill_during_edit_is_not_resurrected(env):
    import threading
    from app.models.schemas import OrderStatus
    s, broker, _ = env
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    started, release = threading.Event(), threading.Event()
    def modify(*args):
        started.set()
        assert release.wait(2)
        return o.kotak_order_id
    broker.modify_sl_order.side_effect = modify
    edit = asyncio.create_task(orders.update_order(o.order_id, UpdateOrderRequest(trigger_price=95), session_id=s.session_id))
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(.001)
        assert started.is_set()
        o.status = OrderStatus.FILLED
        o.broker_filled_quantity = o.quantity
        o.kotak_fill_confirmed = True
    finally:
        release.set()
        result = await edit
    assert result.status == OrderStatus.FILLED
    assert result.trigger_price == 90


@pytest.mark.asyncio
async def test_replacement_callbacks_registered_on_loop(env):
    import threading
    s, broker, _ = env
    o = local(s)
    simulation._register_kotak_sl_for_order(s, o, asyncio.get_running_loop())
    loop_thread = threading.get_ident()
    threads = []
    broker.modify_sl_order.return_value = 'replacement'
    broker.register_fill_callback.side_effect = lambda *args: threads.append(threading.get_ident())
    result = await orders.update_order(o.order_id, UpdateOrderRequest(trigger_price=95), session_id=s.session_id)
    assert result.kotak_order_id == 'replacement'
    assert threads == [loop_thread]
    assert s.kotak_order_map[o.order_id] == 'replacement'


@pytest.mark.asyncio
async def test_persistence_reconciles_fill_received_during_write(env, monkeypatch):
    from app.services.broker_order_service import persist_order_async
    from app.models.schemas import OrderStatus
    import threading
    s, _, _ = env
    o = local(s)
    started, release = threading.Event(), threading.Event()
    saved = []
    def write(snapshot):
        saved.append(snapshot.status)
        if len(saved) == 1:
            started.set()
            assert release.wait(2)
    monkeypatch.setattr(order_service, '_write_order_to_db', write)
    task = asyncio.create_task(persist_order_async(o))
    try:
        for _ in range(200):
            if started.is_set():
                break
            await asyncio.sleep(.001)
        assert started.is_set()
        o.status = OrderStatus.FILLED
    finally:
        release.set()
        await task
    assert saved == [OrderStatus.PENDING, OrderStatus.FILLED]
