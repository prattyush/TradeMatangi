"""Real protection quantities, session timer and broker outcome recovery."""
import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.services import real_protection as protection, order_service, simulation


@pytest.fixture
def env(monkeypatch):
    session = simulation.SimulationSession(session_id="protection-test", symbol="BSESEN",
        user_id="owner", date="2026-10-05", start_time="09:15:00", speed=1,
        session_type="real", instrument_type="options", expiry="2026-10-08")
    session.broker_positions = []
    session.protection_executions = []
    simulation._sessions[session.session_id] = session
    order_service._orders[session.session_id] = {}
    broker = MagicMock()
    broker.account_identity.return_value = "account"
    counter = [0]
    def submit(**kwargs):
        counter[0] += 1
        return f"SL-{counter[0]}"
    broker.place_options_sl_order.side_effect = submit
    monkeypatch.setattr(protection, "_save", AsyncMock())
    monkeypatch.setattr(protection, "_verify_fresh", AsyncMock())
    monkeypatch.setattr(protection, "_claim", lambda *_: {"lease": "test"})
    monkeypatch.setattr(protection, "_release", lambda *_: None)
    monkeypatch.setattr(protection, "_renew", lambda *_: None)
    monkeypatch.setattr(protection, "_pending", lambda *_, **__: None)
    monkeypatch.setattr("app.services.user_settings_service.get_settings", lambda *_: {"stoploss_limit_gap_pct": 0.015})
    yield session, broker
    protection.cancel(session.session_id)
    simulation._sessions.pop(session.session_id, None)
    order_service._orders.pop(session.session_id, None)


def entry(session, identity, quantity, *, strike=71100, source=None, sl=30, side="BUY"):
    order = Order(order_id=identity, session_id=session.session_id, user_id=session.user_id,
        symbol=session.symbol, side=TradeSide(side), order_type=OrderType.LIMIT,
        quantity=quantity, trigger_price=40, limit_price=40, created_at=1,
        right="PE", strike=strike, expiry=session.expiry, execution_role="entry",
        broker_exchange="bse_fo", broker_product="MIS", source=source,
        broker_filled_quantity=quantity, kotak_order_id=identity, filled_price=40,
        entry_sl_price=sl, group_id=identity, status=OrderStatus.FILLED)
    order_service._orders[session.session_id][identity] = order
    session.protection_executions.append(dict(kotak_order_id=identity, exchange="bse_fo", product="MIS",
        symbol=f"SENSEX26O08{strike}PE", side=side, quantity=quantity, price=40,
        timestamp=len(session.protection_executions) + 1, execution_id=identity))
    return order


def held(session, quantity, *, strike=71100, side="LONG"):
    session.broker_positions.append(dict(exchange="bse_fo", product="MIS", right="PE", strike=strike,
        expiry=session.expiry, side=side, quantity=quantity, avg_entry_price=40))


def exit_order(session, identity, quantity, *, source="broker_external", filled=0, strike=71100):
    order = Order(order_id=identity, session_id=session.session_id, user_id=session.user_id,
        symbol=session.symbol, side=TradeSide.SELL, order_type=OrderType.STOPLOSS,
        quantity=quantity, trigger_price=30, limit_price=29, created_at=1,
        right="PE", strike=strike, expiry=session.expiry, execution_role="exit",
        broker_exchange="bse_fo", broker_product="MIS", source=source,
        broker_filled_quantity=filled, kotak_order_id=identity)
    order_service._orders[session.session_id][identity] = order
    return order


@pytest.mark.asyncio
async def test_two_entry_groups_fill_60_with_prior_exit_20_adds_40(env):
    s, broker = env
    entry(s, "first", 20)
    second = entry(s, "second", 40)
    held(s, 60)
    exit_order(s, "old-exit", 20)
    result = await protection._repair(s, broker, "account")
    assert broker.place_options_sl_order.call_args.kwargs["qty"] == 40
    assert result[0]["missing"] == 0
    created = [o for o in order_service.get_all_orders(s.session_id) if o.source == "entry_protection"]
    assert created[0].protection_entry_allocations == {second.order_id: 40}
    await protection._repair(s, broker, "account")
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_partial_fills_20_40_60_never_use_minimum_lot_as_total(env):
    s, broker = env
    e = entry(s, "buy", 20)
    e.quantity = 60
    held(s, 20)
    for total in (20, 40, 60):
        e.broker_filled_quantity = total
        s.broker_positions[0]["quantity"] = total
        s.protection_executions[0]["quantity"] = total
        await protection._repair(s, broker, "account")
    assert [call.kwargs["qty"] for call in broker.place_options_sl_order.call_args_list] == [20, 20, 20]
    assert sum(o.quantity for o in order_service.get_all_orders(s.session_id) if o.execution_role == "exit") == 60


@pytest.mark.asyncio
async def test_cancelled_old_exit_cannot_suppress_replacement(env):
    s, broker = env
    entry(s, "buy", 40)
    held(s, 40)
    old = exit_order(s, "old", 20, source="entry_protection")
    old.status = OrderStatus.CANCELLED
    await protection._repair(s, broker, "account")
    assert broker.place_options_sl_order.call_args.kwargs["qty"] == 40


@pytest.mark.asyncio
async def test_manual_entry_requires_refresh_but_manual_exit_counts(env):
    s, broker = env
    entry(s, "app", 40)
    manual = entry(s, "manual", 20, source="broker_external", sl=None)
    held(s, 60)
    exit_order(s, "manual-stop", 40)
    await protection._repair(s, broker, "account")
    broker.place_options_sl_order.assert_not_called()
    await protection._repair(s, broker, "account", enroll_manual=True)
    assert manual.protection_enrolled
    assert broker.place_options_sl_order.call_args.kwargs["qty"] == 20
    assert broker.place_options_sl_order.call_args.kwargs["trigger_price"] == 30


@pytest.mark.asyncio
async def test_existing_exit_for_different_strike_does_not_cover_entry(env):
    s, broker = env
    entry(s, "buy", 40)
    held(s, 40)
    exit_order(s, "other", 40, strike=71200)
    await protection._repair(s, broker, "account")
    assert broker.place_options_sl_order.call_args.kwargs["qty"] == 40


@pytest.mark.asyncio
async def test_partial_exit_resize_uses_filled_plus_remaining_and_preserves_manual(env):
    s, broker = env
    entry(s, "buy", 60)
    held(s, 40)
    own = exit_order(s, "own", 60, source="entry_protection", filled=20)
    exit_order(s, "manual", 20)
    s.protection_executions.append(dict(kotak_order_id="own", exchange="bse_fo", product="MIS",
        symbol="SENSEX26O0871100PE", side="SELL", quantity=20, price=35, timestamp=2, execution_id="exit"))
    broker.modify_sl_order.return_value = "own"
    await protection._repair(s, broker, "account")
    assert broker.modify_sl_order.call_args.args[-1] == 40  # 20 filled + 20 remaining
    assert own.quantity == 40
    broker.cancel_order.assert_not_called()


@pytest.mark.asyncio
async def test_reversal_cancels_old_managed_exit_before_covering_new_side(env):
    s, broker = env
    entry(s, "buy", 20)
    entry(s, "sell-reversal", 60, side="SELL", sl=50)
    held(s, 40, side="SHORT")
    old = exit_order(s, "old-long-sl", 20, source="entry_protection")
    await protection._repair(s, broker, "account")
    broker.cancel_order.assert_called_once_with("old-long-sl")
    assert old.status == OrderStatus.CANCELLED
    assert broker.place_options_sl_order.call_args.kwargs["side"] == "B"
    assert broker.place_options_sl_order.call_args.kwargs["qty"] == 40


@pytest.mark.asyncio
async def test_one_timer_all_strikes_no_deadline_postponement(env):
    s, _ = env
    first = entry(s, "one", 20)
    second = entry(s, "two", 20, strike=71200)
    protection.request(s, order=first, delay=100)
    timer = protection._states[s.session_id].timer
    protection.request(s, order=second, delay=101)
    assert protection._states[s.session_id].timer is timer
    assert len([state for state in protection._states.values() if state.session is s]) == 1


@pytest.mark.asyncio
async def test_covered_pass_stops_and_later_fill_wakes_again(env, monkeypatch):
    s, _ = env
    check = AsyncMock(return_value=[{"missing": 0, "status": "covered"}])
    monkeypatch.setattr(protection, "reconcile_now", check)
    protection.request(s, delay=0)
    await asyncio.sleep(.02)
    state = protection._states[s.session_id]
    assert state.timer is None and state.task is None
    protection.request(s, order=entry(s, "new", 40), delay=100)
    assert state.timer is not None


@pytest.mark.asyncio
async def test_events_during_pass_cannot_start_overlapping_task(env, monkeypatch):
    s, _ = env
    entered, release = asyncio.Event(), asyncio.Event()
    async def check(*args):
        entered.set()
        await release.wait()
        return [{"missing": 0, "status": "covered"}]
    monkeypatch.setattr(protection, "reconcile_now", check)
    protection.request(s)
    await entered.wait()
    state = protection._states[s.session_id]
    task = state.task
    protection.request(s, reason="fill")
    assert state.task is task and state.timer is None
    release.set()
    await task
    assert state.timer is not None


@pytest.mark.asyncio
async def test_submission_timeout_is_durable_and_never_blindly_retried(env):
    s, broker = env
    entry(s, "buy", 40)
    held(s, 40)
    broker.place_options_sl_order.side_effect = TimeoutError("outcome unknown")
    with pytest.raises(TimeoutError):
        await protection._repair(s, broker, "account")
    unknown = next(o for o in order_service.get_all_orders(s.session_id) if o.source == "entry_protection")
    assert unknown.protection_submission == "unknown" and unknown.broker_client_tag
    result = await protection._repair(s, broker, "account")
    assert result[0]["status"] == "unknown"
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_broker_gateway_error_is_also_an_unknown_outcome(env):
    from app.services.kotak_service import KotakError
    s, broker = env
    entry(s, "buy", 40)
    held(s, 40)
    broker.place_options_sl_order.side_effect = KotakError("Kotak API error: gateway failure (code 500)")
    with pytest.raises(KotakError):
        await protection._repair(s, broker, "account")
    assert next(o for o in order_service.get_all_orders(s.session_id) if o.source == "entry_protection").protection_submission == "unknown"
    await protection._repair(s, broker, "account")
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_no_http_when_intent_cannot_be_persisted(env, monkeypatch):
    s, broker = env
    entry(s, "buy", 40)
    held(s, 40)
    monkeypatch.setattr(protection, "_save", AsyncMock(side_effect=RuntimeError("storage failed")))
    with pytest.raises(RuntimeError, match="storage failed"):
        await protection._repair(s, broker, "account")
    broker.place_options_sl_order.assert_not_called()


def test_broker_tag_restores_identity_after_acknowledgement_was_lost():
    from app.services import real_broker_state
    s = simulation.SimulationSession(session_id="recover", symbol="BSESEN", date="2026-10-05",
        start_time="09:15:00", speed=1, session_type="real", instrument_type="options")
    pending = Order(session_id=s.session_id, user_id=s.user_id, symbol=s.symbol, side=TradeSide.SELL,
        quantity=40, trigger_price=30, limit_price=29, created_at=0, right="PE", strike=71100,
        expiry="2026-10-08", source="entry_protection", broker_client_tag="tmSLtest",
        protection_operation_id="op", protection_submission="unknown")
    order_service._orders[s.session_id] = {pending.order_id: pending}
    row = dict(kotak_order_id="SL", status="trigger pending", order_type="SL", side="SELL",
        symbol="SENSEX26O0871100PE", quantity=40, trigger_price=30, limit_price=29,
        filled_quantity=0, filled_price=0, product="MIS", exchange="bse_fo", client_tag="tmSLtest")
    try:
        result = real_broker_state.build_orders(s, [row])
        assert result[pending.order_id].kotak_order_id == "SL"
        assert result[pending.order_id].protection_submission == "accepted"
    finally:
        order_service._orders.pop(s.session_id, None)


@pytest.mark.asyncio
async def test_lease_revalidation_detects_a_new_manual_exit_before_submission():
    s = simulation.SimulationSession(session_id="fresh", symbol="BSESEN", date="2026-10-05",
        start_time="09:15:00", speed=1, session_type="real", instrument_type="options")
    broker = MagicMock()
    broker.get_positions.return_value = [dict(trdSym="SENSEX26O0871100PE", exSeg="bse_fo", prod="MIS", netQty=40, avgPrc=40)]
    broker.get_order_history.return_value = [dict(kotak_order_id="manual-stop", symbol="SENSEX26O0871100PE",
        exchange="bse_fo", product="MIS", status="trigger pending", side="SELL", quantity=40, filled_quantity=0)]
    with pytest.raises(ValueError, match="exits changed"):
        await protection._verify_fresh(s, broker, ("bse_fo", "MIS", "PE", 71100, "2026-10-08"), 40, "SELL", [])


@pytest.mark.asyncio
async def test_retry_budget_stops_after_three_retries(env, monkeypatch):
    s, _ = env
    monkeypatch.setattr(protection, "reconcile_now", AsyncMock(side_effect=RuntimeError("broker unavailable")))
    state = protection._state(s)
    delays = []
    monkeypatch.setattr(protection, "request", lambda *args, **kwargs: delays.append(kwargs["delay"]))
    for _ in range(4):
        await protection._run(state)
    assert delays == [10, 20, 40]
    assert state.timer is None


@pytest.mark.asyncio
async def test_snapshot_reads_coalesce_across_same_account(env):
    _, broker = env
    broker.get_order_history.return_value = []
    broker.get_trade_history.return_value = []
    broker.get_positions.return_value = []
    await protection.broker_facts(broker, "coalesce")
    await protection.broker_facts(broker, "coalesce")
    broker.get_order_history.assert_called_once()
    broker.get_trade_history.assert_called_once()
    broker.get_positions.assert_called_once()


def test_busy_distributed_lease_does_not_authorize_placement(monkeypatch):
    from botocore.exceptions import ClientError
    table = MagicMock()
    table.get_item.return_value = {}
    table.update_item.side_effect = ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
    db = MagicMock()
    db.Table.return_value = table
    monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: db)
    s = MagicMock(date="2026-10-05")
    assert protection._claim("account", s, ("bse_fo", "MIS", "PE", 71100, "2026-10-08"), "owner") is None


def test_expired_lease_with_unknown_pending_tag_still_blocks_duplicate(monkeypatch):
    table, db = MagicMock(), MagicMock()
    table.get_item.return_value = {"Item": {"protection_expires": 0, "protection_pending_tags": {"tmSLunknown"}}}
    db.Table.return_value = table
    monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: db)
    s = MagicMock(date="2026-10-05", symbol="BSESEN")
    key = ("bse_fo", "MIS", "PE", 71100, "2026-10-08")
    assert protection._claim("account", s, key, "new-owner") is None
    table.update_item.assert_not_called()
    assert protection._claim("account", s, key, "new-owner", {"tmSLunknown"}) is not None
    assert table.update_item.call_count == 2


@pytest.mark.asyncio
async def test_automatic_rejection_does_not_reset_exhausted_retry_budget(env):
    s, _ = env
    order = exit_order(s, "rejected-child", 20, source="entry_protection")
    state = protection._state(s)
    state.failures = 4
    protection.request(s, order=order, reason="broker_cancel_or_reject")
    assert state.timer is None and state.failures == 4
    protection.request(s, reason="manual_refresh")
    assert state.timer is not None and state.failures == 0


@pytest.mark.asyncio
async def test_trade_publication_failure_cannot_lose_fill_recovery(env, monkeypatch):
    from app.services.broker_order_service import register_callbacks
    s, broker = env
    order = entry(s, "buy", 40)
    order.broker_filled_quantity = 0
    monkeypatch.setattr("app.services.order_service._write_order_to_db", MagicMock())
    monkeypatch.setattr("app.services.trading.record_trade", MagicMock(side_effect=RuntimeError("trade storage failed")))
    register_callbacks(s, order, broker, asyncio.get_running_loop())
    callback = broker.register_fill_callback.call_args.args[1]
    with pytest.raises(RuntimeError, match="trade storage failed"):
        callback("buy", "BUY", 40, 40)
    assert protection._states[s.session_id].timer is not None


def test_manual_sl_gap_uses_remaining_broker_exits_and_exact_product(env):
    from app.routers.orders import _stoploss_available_quantity
    s, _ = env
    held(s, 60)
    s.broker_positions.append({**s.broker_positions[0], "product": "NRML", "quantity": 100})
    exit_order(s, "partial-stop", 60, filled=20)
    local = exit_order(s, "waiting-target", 20)
    local.order_type, local.kotak_order_id = OrderType.TARGET, None
    assert _stoploss_available_quantity(s, "PE", 71100, s.expiry) == (20, 60)


@pytest.mark.asyncio
async def test_desktop_explicit_refresh_uses_shared_real_path_and_checks_owner(env, monkeypatch):
    from fastapi import HTTPException
    from app.routers import desktop_trading, kotak
    s, _ = env
    reconcile = AsyncMock()
    monkeypatch.setattr(kotak, "kotak_reconcile", reconcile)
    monkeypatch.setattr(desktop_trading, "_snapshot", lambda *_: {"session_id": s.session_id})
    assert await desktop_trading.reconcile_real_orders(s.session_id, s.user_id) == {"session_id": s.session_id}
    reconcile.assert_awaited_once_with(session_id=s.session_id, user_id=s.user_id)
    with pytest.raises(HTTPException) as exc:
        await desktop_trading.reconcile_real_orders(s.session_id, "other-owner")
    assert exc.value.status_code == 404
    s.session_type = "paper"
    with pytest.raises(HTTPException) as exc:
        await desktop_trading.reconcile_real_orders(s.session_id, s.user_id)
    assert exc.value.status_code == 400
