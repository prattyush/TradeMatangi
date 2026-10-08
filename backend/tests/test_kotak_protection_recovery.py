"""Real-trading recovery scenarios with broker reports, fills and submissions mocked."""
import asyncio
from copy import deepcopy
import json
import time
from unittest.mock import MagicMock
import pytest
from app.models.schemas import Order, OrderStatus, OrderType, TradeSide, Position, SimulationState
from app.services import protection_recovery as recovery, protection_journal as journal
from app.services import order_service, simulation, trading, kotak_service, user_settings_service
from app.services.broker_order_service import register_callbacks

ORIGINAL_FRESH_QUOTE = recovery.fresh_quote


@pytest.fixture
def env(monkeypatch, isolated_protection_journal):
    s = simulation.SimulationSession(session_id='recovery-test', symbol='NIFTY', date='2026-10-06',
        start_time='09:15:00', speed=1, user_id='u', session_type='real', instrument_type='options', state=SimulationState.RUNNING)
    parent = Order(order_id='parent', session_id=s.session_id, user_id='u', symbol=s.symbol,
        side=TradeSide.SELL, quantity=130, trigger_price=40, limit_price=39.4, created_at=10,
        order_type=OrderType.STOPLOSS, status=OrderStatus.CANCELLED, is_stoploss=True,
        right='CE', strike=25000, expiry='2026-10-08', kotak_order_id='old', execution_role='exit',
        cancellation_status='cancelled', cancelled_at=time.time())
    row = dict(kotak_order_id='old', symbol='NIFTY26O0825000CE', underlying='NIFTY',
        side='SELL', quantity=130, filled_quantity=0, status='cancelled', product='MIS',
        exchange='nse_fo', trigger_price=40, limit_price=39.4, order_type='SL', tag='', reject_reason='--')
    rows = [row]
    raw_positions = [dict(trdSym=row['symbol'], sym='NIFTY', exSeg='nse_fo', prod='MIS', netQty=130, buyAvgPrc=60)]
    s.broker_positions = [dict(symbol='NIFTY', right='CE', strike=25000, expiry='2026-10-08',
        quantity=130, side='LONG', avg_entry_price=60, entry_commission=0)]
    broker = MagicMock()
    broker.account_identity.return_value = 'account'
    broker.get_order_history.side_effect = lambda: deepcopy(rows)
    broker.get_positions.side_effect = lambda: deepcopy(raw_positions)
    broker.get_trade_history.return_value = []
    def place(**kwargs):
        identifier = 'new-' + str(sum(row['kotak_order_id'].startswith('new-') for row in rows))
        rows.append({**row, 'kotak_order_id': identifier, 'status': 'trigger pending',
            'quantity': kwargs['qty'], 'trigger_price': kwargs['trigger_price'],
            'limit_price': kwargs['limit_price'], 'tag': kwargs['tag']})
        return identifier
    broker.place_options_sl_order.side_effect = place
    monkeypatch.setattr(kotak_service, 'get_service', lambda: broker)
    monkeypatch.setattr(simulation, 'get_session', lambda sid: s if sid == s.session_id else None)
    monkeypatch.setattr(order_service, '_write_order_to_db', MagicMock())
    monkeypatch.setattr(recovery, 'market_open', lambda session: True)
    monkeypatch.setattr(recovery, 'fresh_quote', lambda session, order: 50.)
    monkeypatch.setattr(user_settings_service, 'get_settings', lambda uid: {'default_sl_pct': .20, 'stoploss_limit_gap_pct': .015})
    order_service._orders[s.session_id] = {parent.order_id: parent}
    job = {'account': 'account', 'session_id': s.session_id, 'root_order_id': parent.order_id, 'attempts': 0, 'children': []}
    yield s, parent, broker, rows, raw_positions, job
    order_service._orders.pop(s.session_id, None)


async def attempt(env):
    s, parent, broker, _, _, job = env
    return await recovery._attempt(s, parent, 'op', job, broker)


def events(s):
    return [json.loads(payload) for _, payload in s.queue._dq]


@pytest.mark.asyncio
async def test_restore_cancelled_stop_for_remaining_position(env):
    assert await attempt(env)
    s, _, broker, _, _, job = env
    kwargs = broker.place_options_sl_order.call_args.kwargs
    assert kwargs['trigger_price'] == 40 and kwargs['qty'] == 130
    assert kwargs['limit_price'] == 39.4
    assert len(kwargs['tag']) == 20
    assert job['attempts'] == 1
    assert events(s)[-1]['state'] == 'restored'


@pytest.mark.asyncio
async def test_crossed_stop_uses_setting_from_current_price(env):
    env[3][0]['trigger_price'] = 55
    env[1].trigger_price = 55
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_args.kwargs['trigger_price'] == 40


@pytest.mark.asyncio
async def test_settings_override_default_twenty_percent(env, monkeypatch):
    env[3][0]['trigger_price'] = 55
    monkeypatch.setattr(user_settings_service, 'get_settings', lambda uid: {'default_sl_pct': .30, 'stoploss_limit_gap_pct': .02})
    assert await attempt(env)
    kwargs = env[2].place_options_sl_order.call_args.kwargs
    assert kwargs['trigger_price'] == 35 and kwargs['limit_price'] == 34.3


@pytest.mark.asyncio
async def test_short_stop_mirrors_long_rules(env):
    s, parent, broker, rows, positions, _ = env
    parent.side = TradeSide.BUY
    rows[0].update(side='BUY', trigger_price=45)
    positions[0].update(netQty=-130, sellAvgPrc=60)
    s.broker_positions[0].update(side='SHORT')
    assert await attempt(env)
    assert broker.place_options_sl_order.call_args.kwargs['trigger_price'] == 60
    assert broker.place_options_sl_order.call_args.kwargs['side'] == 'B'


@pytest.mark.asyncio
async def test_flat_position_does_not_create_exit(env):
    s, _, broker, _, positions, _ = env
    positions[0]['netQty'] = 0
    s.broker_positions[0].update(side='FLAT', quantity=0)
    assert await attempt(env)
    broker.place_options_sl_order.assert_not_called()
    assert events(s)[-1]['state'] == 'cleared'


@pytest.mark.asyncio
async def test_existing_partial_exit_counts_only_unfilled_quantity(env):
    rows = env[3]
    rows.append({**rows[0], 'kotak_order_id': 'other', 'status': 'open', 'quantity': 130, 'filled_quantity': 65})
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_args.kwargs['qty'] == 65


@pytest.mark.asyncio
async def test_pending_exit_fully_covers_position(env):
    env[3].append({**env[3][0], 'kotak_order_id': 'other', 'status': 'trigger pending'})
    assert await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_other_right_strike_expiry_and_product_do_not_count(env):
    row = env[3][0]
    env[3].extend([{**row, 'kotak_order_id': 'pe', 'symbol': 'NIFTY26O0825000PE', 'status': 'open'},
                  {**row, 'kotak_order_id': 'strike', 'symbol': 'NIFTY26O0825100CE', 'status': 'open'},
                  {**row, 'kotak_order_id': 'expiry', 'symbol': 'NIFTY26O1525000CE', 'status': 'open'},
                  {**row, 'kotak_order_id': 'cnc', 'product': 'NRML', 'status': 'open'}])
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_args.kwargs['qty'] == 130


@pytest.mark.asyncio
async def test_profit_limit_price_is_not_used_as_stop(env):
    env[3][0].update(order_type='LIMIT', trigger_price=0, limit_price=80)
    env[1].order_type = OrderType.LIMIT
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_args.kwargs['trigger_price'] == 40


@pytest.mark.asyncio
async def test_position_report_disagreement_defers(env):
    env[4][0]['netQty'] = 65
    with pytest.raises(recovery.Deferred, match='differ'):
        await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_closed_position_cycle_not_reprotected(env):
    env[2].get_trade_history.return_value = [
        {**env[3][0], 'quantity': 130, 'side': 'BUY', 'timestamp': 5},
        {**env[3][0], 'quantity': 130, 'side': 'SELL', 'timestamp': 11},
        {**env[3][0], 'quantity': 130, 'side': 'BUY', 'timestamp': 12}]
    assert await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_malformed_ack_does_not_allow_duplicate_submission(env):
    env[2].place_options_sl_order.side_effect = TimeoutError('timeout')
    with pytest.raises(recovery.Deferred, match='unknown'):
        await attempt(env)
    assert env[5]['children'][0]['state'] == 'unknown'
    with pytest.raises(recovery.Deferred, match='uncertain'):
        await attempt(env)
    assert env[2].place_options_sl_order.call_count == 1


@pytest.mark.asyncio
async def test_timeout_after_acceptance_reconciles_by_tag(env):
    original = env[2].place_options_sl_order.side_effect
    def accepted_then_timeout(**kwargs):
        original(**kwargs)
        raise TimeoutError('connection lost after acceptance')
    env[2].place_options_sl_order.side_effect = accepted_then_timeout
    with pytest.raises(recovery.Deferred):
        await attempt(env)
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_count == 1


@pytest.mark.asyncio
async def test_explicit_rejection_is_bounded_to_three_attempts(env):
    env[2].place_options_sl_order.side_effect = kotak_service.KotakOrderRejected('exchange rejected')
    for _ in range(3):
        with pytest.raises(recovery.Deferred, match='failed'):
            await attempt(env)
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_count == 3
    assert events(env[0])[-1]['state'] == 'needs_attention'


@pytest.mark.asyncio
async def test_fill_during_preparation_does_not_submit(env, monkeypatch):
    s = env[0]
    original = journal.store.claim
    def claim(*args):
        result = original(*args)
        s._protection_revision = 1
        return result
    monkeypatch.setattr(journal.store, 'claim', claim)
    with pytest.raises(recovery.Deferred, match='during durable'):
        await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_freeze_chunks_checkpoint_first_chunk_on_later_timeout(env, monkeypatch):
    monkeypatch.setattr(order_service, 'split_quantity', lambda *args: [65, 65])
    original = env[2].place_options_sl_order.side_effect
    calls = []
    def place(**kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            raise TimeoutError('uncertain second chunk')
        return original(**kwargs)
    env[2].place_options_sl_order.side_effect = place
    with pytest.raises(recovery.Deferred):
        await attempt(env)
    assert env[5]['children'][0]['state'] == 'acknowledged'
    assert env[5]['children'][1]['state'] == 'unknown'
    with pytest.raises(recovery.Deferred):
        await attempt(env)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_user_cancel_intent_suppresses_recovery(env):
    s, parent, broker, _, _, _ = env
    _, intent = journal.begin_cancel('account', 'old', 'user', 'user_cancel')
    s._last_exit_fill_at = time.time()
    await recovery._drive(s, parent, {'received_at': time.time(), 'raw': {}}, 'op')
    broker.place_options_sl_order.assert_not_called()
    assert parent.cancel_request_id == intent['request_id']
    assert journal.store.get('op')['state'] == 'user_cancelled'


@pytest.mark.asyncio
async def test_exit_then_unknown_cancel_repairs(env):
    s, parent, broker, _, _, _ = env
    s._last_exit_fill_at = time.time()
    await recovery._drive(s, parent, {'received_at': time.time(), 'raw': {'rejRsn': '--'}}, 'op')
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_cancel_before_exit_waits_for_correlated_fill(env):
    s, parent, broker, _, _, _ = env
    task = asyncio.create_task(recovery._drive(s, parent, {'received_at': time.time(), 'raw': {}}, 'op'))
    await asyncio.sleep(.6)
    broker.place_options_sl_order.assert_not_called()
    s._last_exit_fill_at = time.time()
    await task
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_unknown_origin_without_recent_exit_alerts(env):
    s, parent, broker, _, _, _ = env
    await recovery._drive(s, parent, {'received_at': time.time() - 31, 'raw': {}}, 'op')
    broker.place_options_sl_order.assert_not_called()
    assert events(s)[-1]['state'] == 'needs_attention'


@pytest.mark.asyncio
async def test_explicit_broker_cancellation_can_recover_without_exit(env):
    s, parent, broker, _, _, _ = env
    await recovery._drive(s, parent, {'received_at': time.time(), 'raw': {'cancelInitiator': 'RMS'}}, 'op')
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_duplicate_terminal_incident_is_not_replayed(env):
    s, parent, broker, _, _, _ = env
    s._last_exit_fill_at = time.time()
    metadata = {'received_at': time.time(), 'raw': {}}
    await recovery._drive(s, parent, metadata, 'op')
    await recovery._drive(s, parent, metadata, 'op')
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_resume_uncertain_submission_uses_existing_broker_order(env):
    s, parent, broker, _, _, job = env
    original = broker.place_options_sl_order.side_effect
    def place(**kwargs):
        original(**kwargs)
        raise TimeoutError('response lost')
    broker.place_options_sl_order.side_effect = place
    with pytest.raises(recovery.Deferred):
        await attempt(env)
    # Drop runtime orders as on restart. The journal still has submitted child identity/tag.
    order_service._orders[s.session_id] = {parent.order_id: parent}
    restored = journal.store.get('op')
    env = (s, parent, broker, env[3], env[4], restored)
    assert await attempt(env)
    assert broker.place_options_sl_order.call_count == 1


def test_fallback_rounding_rejects_invalid_tick_gap():
    assert recovery.trigger_price(40, 50, 'LONG', .2) == (40, 'restored')
    assert recovery.trigger_price(40, 39, 'LONG', .2) == (31.2, 'default_gap')
    with pytest.raises(recovery.Deferred):
        recovery.trigger_price(None, .05, 'LONG', .2)


def test_stale_quote_is_not_recovery_price(env, monkeypatch):
    monkeypatch.setattr(recovery, 'fresh_quote', ORIGINAL_FRESH_QUOTE)
    s, parent, *_ = env
    s._protection_quotes = {recovery.contract(parent): {'close': 50, 'received_at': time.time() - 6}}
    with pytest.raises(recovery.Deferred):
        recovery.fresh_quote(s, parent)


@pytest.mark.asyncio
async def test_supplied_sensex_incident_restores_thirty_two_stop_for_eighty(env):
    s, parent, broker, rows, positions, _ = env
    s.symbol = parent.symbol = 'BSESEN'
    parent.strike, parent.quantity, parent.trigger_price = 74000, 80, 32
    rows[0].update(symbol='SENSEX26O0874000CE', underlying='SENSEX', exchange='bse_fo', quantity=80, trigger_price=32)
    positions[0].update(trdSym=rows[0]['symbol'], sym='SENSEX', exSeg='bse_fo', netQty=80)
    s.broker_positions[0].update(symbol='BSESEN', strike=74000, quantity=80)
    broker.get_trade_history.return_value = [
        {**rows[0], 'side': 'BUY', 'quantity': 80, 'timestamp': 5},
        {**rows[0], 'side': 'BUY', 'quantity': 40, 'timestamp': 20},
        {**rows[0], 'side': 'SELL', 'quantity': 40, 'timestamp': 25}]
    s._last_exit_fill_at = time.time()
    await recovery._drive(s, parent, {'received_at': time.time(), 'raw': {'rejRsn': '--'}}, 'op')
    assert broker.place_options_sl_order.call_args.kwargs['trigger_price'] == 32
    assert broker.place_options_sl_order.call_args.kwargs['qty'] == 80


@pytest.mark.asyncio
async def test_fill_callback_updates_cached_position_before_exit_reconciliation(env, monkeypatch):
    from app.services import real_broker_state
    s, parent, broker, _, _, _ = env
    parent.status = OrderStatus.PENDING
    parent.quantity = 65
    registered = []
    broker.register_fill_callback.side_effect = lambda kid, callback, loop: registered.append(callback)
    monkeypatch.setattr(trading, '_write_trade_to_db', lambda *args: None)
    monkeypatch.setattr(real_broker_state, 'active_partition', lambda *args: None)
    observed = []
    monkeypatch.setattr(order_service, 'request_exit_reconciliation', lambda *args: observed.append(trading.get_position(s.session_id, right='CE', strike=25000, expiry='2026-10-08').quantity))
    register_callbacks(s, parent, broker, asyncio.get_running_loop())
    registered[0]('old', 'SELL', 65, 39.5)
    assert observed == [65]
    assert s._last_exit_fill_at > 0


@pytest.mark.asyncio
async def test_cancellation_of_replacement_during_submission_is_queued(env, monkeypatch):
    s, parent, broker, _, _, _ = env
    s._last_exit_fill_at = time.time()
    original = recovery._attempt
    cancelled_once = []
    async def attempt(session, current, operation, job, broker):
        result = await original(session, current, operation, job, broker)
        if not cancelled_once:
            replacement = order_service.get_order(s.session_id, job['children'][0]['order']['order_id'])
            replacement.status = OrderStatus.CANCELLED
            # This is the event queue race: the original operation is still running.
            recovery.note_cancel(s, replacement, {'received_at': time.time(), 'raw': {}})
            cancelled_once.append(replacement.kotak_order_id)
        return result
    monkeypatch.setattr(recovery, '_attempt', attempt)
    recovery.note_cancel(s, parent, {'received_at': time.time(), 'raw': {}})
    await asyncio.sleep(1.05)
    assert cancelled_once
    assert not recovery._pending_events
    # The queued child cancellation has its own running continuation.
    assert recovery._tasks
    await recovery.shutdown()


@pytest.mark.asyncio
async def test_duplicate_submitting_claim_prevents_broker_call(env):
    journal.store.claim(recovery.submission_key('op', 1, 0), {'state': 'submitting'})
    with pytest.raises(recovery.Deferred, match='claimed'):
        await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_incomplete_lot_and_closed_market_never_submit(env, monkeypatch):
    env[1].quantity = 1
    env[3][0]['quantity'] = 1
    with pytest.raises(recovery.Deferred, match='lot'):
        await attempt(env)
    env[1].quantity = 130
    env[3][0]['quantity'] = 130
    monkeypatch.setattr(recovery, 'market_open', lambda _: False)
    with pytest.raises(recovery.Deferred, match='Market closed'):
        await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_allocation_reconciler_uses_remaining_not_original_quantity(env, monkeypatch):
    s, parent, broker, *_ = env
    # Position 130; first order has 65 filled + 65 still open, second protects 65.
    parent.status = OrderStatus.PENDING
    parent.exit_allocation_id = 'allocation'
    parent.exit_position_side = 'LONG'
    parent.broker_filled_quantity = 65
    other = parent.model_copy(update={'order_id': 'other', 'kotak_order_id': 'other', 'quantity': 65, 'broker_filled_quantity': 0})
    order_service._orders[s.session_id]['other'] = other
    order_service.reconcile_allocated_exits(s.session_id, s.symbol, parent.right, parent.strike, parent.expiry, s.date)
    broker.cancel_order.assert_not_called()
    broker.modify_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_failed_cancel_request_does_not_suppress_unexpected_cancel(env):
    s, parent, broker, *_ = env
    key, intent = journal.begin_cancel('account', 'old', 'user', 'user_cancel')
    journal.finish_cancel(key, intent, 'failed')
    s._last_exit_fill_at = time.time()
    await recovery._drive(s, parent, {'received_at': time.time(), 'raw': {}}, 'op')
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_system_conversion_intent_is_not_undone(env):
    s, parent, broker, *_ = env
    journal.begin_cancel('account', 'old', 'system', 'conversion')
    s._last_exit_fill_at = time.time()
    await recovery._drive(s, parent, {'received_at': time.time(), 'raw': {}}, 'op')
    broker.place_options_sl_order.assert_not_called()


def test_unconfirmed_recovery_is_never_triggered_by_live_tick(env):
    s, parent, *_ = env
    pending = parent.model_copy(update={'order_id': 'unknown', 'kotak_order_id': None,
                                       'status': OrderStatus.PENDING, 'recovery_state': 'unknown'})
    order_service._orders[s.session_id]['unknown'] = pending
    triggered = order_service.check_orders(s.session_id, 35, 20, s.date,
        tick_right='CE', tick_strike=25000, tick_expiry='2026-10-08')
    assert triggered == [] and pending.status == OrderStatus.PENDING


@pytest.mark.asyncio
async def test_manual_exit_created_during_prepare_does_not_duplicate(env, monkeypatch):
    s, parent, *_ = env
    original = journal.store.claim
    def claim(*args):
        result = original(*args)
        other = parent.model_copy(update={'order_id': 'manual', 'kotak_order_id': 'manual', 'status': OrderStatus.PENDING})
        order_service._orders[s.session_id]['manual'] = other
        return result
    monkeypatch.setattr(journal.store, 'claim', claim)
    with pytest.raises(recovery.Deferred, match='Another exit'):
        await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize('action', ['cancel', 'edit', 'convert'])
async def test_unconfirmed_recovery_cannot_be_changed_into_duplicate(env, action):
    from app.routers import orders
    from app.models.schemas import UpdateOrderRequest, ConvertOrderRequest
    from fastapi import HTTPException
    s, parent, *_ = env
    parent.status = OrderStatus.PENDING
    parent.kotak_order_id = None
    parent.recovery_state = 'unknown'
    with pytest.raises(HTTPException) as error:
        if action == 'cancel':
            await orders.cancel_order(parent.order_id, s.session_id)
        elif action == 'edit':
            await orders.update_order(parent.order_id, UpdateOrderRequest(trigger_price=35), s.session_id)
        else:
            await orders.convert_order(parent.order_id, ConvertOrderRequest(session_id=s.session_id, new_order_type=OrderType.LIMIT))
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_recovery_waits_for_already_running_allocation_resizer(env):
    import threading
    s, parent, broker, *_ = env
    held = order_service.exit_mutation_lock(s.session_id, s.symbol, *recovery.contract(parent))
    held.acquire()
    s._last_exit_fill_at = time.time()
    task = asyncio.create_task(recovery._drive(s, parent, {'received_at': time.time(), 'raw': {}}, 'op'))
    try:
        await asyncio.sleep(.6)
        broker.place_options_sl_order.assert_not_called()
    finally:
        held.release()
    await task
    broker.place_options_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_acknowledgement_binds_to_registry_replaced_by_snapshot(env):
    s, parent, broker, rows, *_ = env
    original = broker.place_options_sl_order.side_effect
    def place(**kwargs):
        identifier = original(**kwargs)
        # Simulate a broker snapshot copying the prepared row while HTTP is in flight.
        order_service._orders[s.session_id] = {key: value.model_copy(deep=True)
                                               for key, value in order_service._orders[s.session_id].items()}
        return identifier
    broker.place_options_sl_order.side_effect = place
    assert await attempt(env)
    child = next(value for value in order_service.get_open_orders(s.session_id) if value.source == 'cancellation_recovery')
    assert child.kotak_order_id == 'new-0'
    assert child.recovery_state == 'acknowledged'


@pytest.mark.asyncio
async def test_unknown_ack_tag_report_supports_snapshot_imported_alias(env):
    s, parent, broker, rows, _, job = env
    original = broker.place_options_sl_order.side_effect
    def place(**kwargs):
        identifier = original(**kwargs)
        imported = parent.model_copy(update={'order_id': 'external_new', 'kotak_order_id': identifier,
            'status': OrderStatus.PENDING, 'source': 'broker_external', 'quantity': kwargs['qty']})
        order_service._orders[s.session_id][imported.order_id] = imported
        raise TimeoutError('lost acknowledgement')
    broker.place_options_sl_order.side_effect = place
    with pytest.raises(recovery.Deferred):
        await attempt(env)
    assert await attempt(env)
    assert broker.place_options_sl_order.call_count == 1
    active = [order for order in order_service.get_open_orders(s.session_id) if order.kotak_order_id == 'new-0']
    assert len(active) == 1 and active[0].source == 'cancellation_recovery'


@pytest.mark.asyncio
async def test_cancelled_broker_quantity_caps_repair_after_external_resize(env):
    env[3][0]['quantity'] = 65
    # Broker-confirmed size, not a stale local parent quantity, determines lost coverage.
    # The pre-existing unprotected half must not be silently assigned to this incident.
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_args.kwargs['qty'] == 65
    assert await attempt(env)
    assert env[2].place_options_sl_order.call_count == 1
    assert events(env[0])[-1]['state'] == 'needs_attention'


@pytest.mark.asyncio
async def test_missing_side_in_matching_pending_report_defers(env):
    env[3].append({**env[3][0], 'kotak_order_id': 'unknown_side', 'status': 'open', 'side_known': False})
    with pytest.raises(recovery.Deferred, match='side is missing'):
        await attempt(env)
    env[2].place_options_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_user_cancellation_request_rows_do_not_break_resume(env, monkeypatch):
    s, *_ = env
    journal.begin_cancel('account', 'old', 'user', 'user_cancel', {'session_id': s.session_id})
    called = MagicMock()
    monkeypatch.setattr(recovery, 'note_cancel', called)
    await recovery.resume(s)
    called.assert_not_called()
