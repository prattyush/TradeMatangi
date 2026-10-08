"""Protection accounting and burst control, with broker I/O mocked."""
import asyncio
import copy
import time
from unittest.mock import AsyncMock, Mock
import pytest
from app.models.schemas import Order, OrderType, OrderStatus, TradeSide, SimulationState
from app.services import kotak_protection as manager, kotak_reports, protection_recovery as recovery
from app.services import order_service, simulation
from app.services import entry_sl_watcher
from tests.test_phase19_broker_snapshot import env, execution, broker_order, reported_position


def entry(s, identifier, quantity, *, stop=30, created=1, user=None):
    order = Order(order_id=identifier, user_id=user or s.user_id, session_id=s.session_id,
        symbol=s.symbol, right='PE', strike=71100, expiry=s.expiry, side=TradeSide.BUY,
        order_type=OrderType.LIMIT, quantity=quantity, limit_price=40, trigger_price=40,
        created_at=created, execution_role='entry', kotak_order_id=identifier,
        entry_sl_price=stop, broker_filled_quantity=quantity, filled_price=40,
        status=OrderStatus.FILLED)
    order_service._orders[s.session_id][identifier] = order
    return order


def exit_order(s, identifier, quantity, *, owner=None, kind=OrderType.STOPLOSS):
    order = Order(order_id=identifier, user_id=s.user_id, session_id=s.session_id,
        symbol=s.symbol, right='PE', strike=71100, expiry=s.expiry, side=TradeSide.SELL,
        order_type=kind, quantity=quantity, limit_price=30, trigger_price=30,
        created_at=10, execution_role='exit', kotak_order_id=identifier,
        protection_group=owner)
    order_service._orders[s.session_id][identifier] = order
    return order


@pytest.mark.parametrize('first', [40, 20])
def test_two_entries_cannot_borrow_each_others_protection(env, first):
    s, _, _ = env
    a = entry(s, 'a', first)
    b = entry(s, 'b', 60-first, created=2)
    exit_order(s, 'sl-a', first, owner='a')
    fills = [execution(order='a', qty=first), execution('b', order='b', qty=60-first, time='13:53:28')]
    rows = [broker_order('sl-a', 'trigger pending', 'SELL', first, 0)]
    gaps, _ = manager.allocations(s, fills, rows)
    assert [(o.order_id, missing) for o, _, _, missing in gaps] == [('b', b.quantity)]


def test_manual_stop_and_target_count_once_and_fifo_exits_reduce_entitlement(env):
    s, _, _ = env
    entry(s, 'a', 40)
    entry(s, 'b', 20, created=2)
    fills = [execution(order='a', qty=40), execution('b', 'b', qty=20, time='13:53:28'),
             execution('exit', 'exit', qty=20, side='SELL', time='13:53:29')]
    manual = exit_order(s, 'manual', 20, kind=OrderType.LIMIT)
    rows = [broker_order('manual', 'open', 'SELL', 20, 0)]
    gaps, assigned = manager.allocations(s, fills, rows)
    assert [(o.order_id, missing) for o, _, _, missing in gaps] == [('b', 20)]
    assert assigned[manual.order_id] == {'a': 20}


def test_closed_cycles_unprotected_entries_and_other_users_are_not_repaired(env):
    s, _, _ = env
    entry(s, 'a', 20)
    entry(s, 'b', 20, stop=None)
    entry(s, 'other-user', 20, user='other-user')
    fills = [execution(order='a'), execution('exit', 'exit', side='SELL', time='13:53:28'),
             execution('b', 'b', time='13:53:29'), execution('other', 'other-user', time='13:53:30')]
    assert manager.allocations(s, fills, [])[0] == []


@pytest.mark.asyncio
async def test_manual_exclusion_survives_missing_broker_order_and_can_rollback(env, isolated_protection_journal):
    s, _, _ = env
    entry(s, 'a', 40)
    stop = exit_order(s, 'sl', 40, owner='a')
    stop.protection_allocations = {'a': 40}
    previous = await manager.suppress(s, stop, 20)
    exclusions = isolated_protection_journal.get(f'entry-exclusions:{s.session_id}')
    # The order need not remain in the broker day book after restart.
    order_service._orders[s.session_id].pop('sl')
    gaps, _ = manager.allocations(s, [execution(order='a', qty=40)], [], exclusions)
    assert gaps[0][-1] == 20
    await manager.rollback_suppression(stop, previous)
    exclusions = isolated_protection_journal.get(f'entry-exclusions:{s.session_id}')
    assert manager.allocations(s, [execution(order='a', qty=40)], [], exclusions)[0][0][-1] == 40


@pytest.mark.parametrize('mode,broker', [('paper','KotakNeo'), ('sim','KotakNeo'), ('real','Kite')])
def test_kotak_execution_gate(env, mode, broker):
    s, _, _ = env
    entry(s, 'a', 20)
    s.session_type, s.execution_broker = mode, broker
    assert not manager.enabled(s)
    assert manager.entries(s) == []


@pytest.mark.asyncio
async def test_five_fills_share_one_leading_window(env, monkeypatch):
    s, broker, _ = env
    s.state = SimulationState.RUNNING
    entry(s, 'a', 20)
    audit = AsyncMock()
    monkeypatch.setattr(manager, 'audit', audit)
    for _ in range(5):
        manager.request(s, reason='entry_fill', delay=.01)
    await asyncio.sleep(.05)
    audit.assert_awaited_once_with(s, broker)
    assert not manager._pending
    await manager.shutdown()


@pytest.mark.asyncio
async def test_coalesced_account_reports_and_repeated_refresh_clicks(env, monkeypatch):
    s, broker, _ = env
    monkeypatch.setattr(kotak_reports, 'MIN_INTERVAL', .04)
    def slow():
        time.sleep(.02)
        return []
    broker.get_order_history.side_effect = slow
    results = await asyncio.gather(*(kotak_reports.fetch(broker) for _ in range(5)))
    assert all(item is results[0] for item in results)
    assert broker.get_order_history.call_count == broker.get_positions.call_count == broker.get_trade_history.call_count == 1
    kotak_reports.invalidate(broker)
    await kotak_reports.fetch(broker, background=True)
    assert kotak_reports.state(broker).bundle.started >= results[0].started + .04


@pytest.mark.asyncio
async def test_canceled_waiter_does_not_duplicate_sdk_requests(env):
    _, broker, _ = env
    def slow():
        time.sleep(.03)
        return []
    broker.get_positions.side_effect = slow
    waiter = asyncio.create_task(kotak_reports.fetch(broker))
    await asyncio.sleep(.005)
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    await kotak_reports.fetch(broker)
    broker.get_positions.assert_called_once()


@pytest.mark.asyncio
async def test_background_reports_yield_to_foreground_operations(env):
    _, broker, _ = env
    account = kotak_reports.state(broker)
    account.foreground = 1
    task = asyncio.create_task(kotak_reports.fetch(broker, background=True))
    await asyncio.sleep(.01)
    broker.get_positions.assert_not_called()
    account.foreground = 0
    await task
    broker.get_positions.assert_called_once()


@pytest.mark.asyncio
async def test_partial_entry_uses_confirmed_fill_and_reconciles_before_submission(env, monkeypatch, isolated_protection_journal):
    s, broker, _ = env
    s.state = SimulationState.RUNNING
    order = entry(s, 'a', 20)
    order.quantity = 40
    broker.get_order_history.return_value = [broker_order('a', 'open', 'BUY', 40, 20)]
    broker.get_trade_history.return_value = [execution(order='a')]
    broker.get_positions.return_value = [reported_position()]
    monkeypatch.setattr(recovery, 'market_open', lambda s: True)
    monkeypatch.setattr(recovery, 'fresh_quote', lambda *args: 40.)
    monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda uid: {})
    def place(**kwargs):
        row = broker_order('new', 'trigger pending', 'SELL', kwargs['qty'], 0)
        row.update(order_type='SL', trigger_price=kwargs['trigger_price'], limit_price=kwargs['limit_price'], tag=kwargs['tag'])
        broker.get_order_history.return_value.append(row)
        return 'new'
    broker.place_options_sl_order.side_effect = place
    with pytest.raises(recovery.Deferred):
        await manager.audit(s, broker)
    await manager.audit(s, broker)
    broker.place_options_sl_order.assert_called_once()
    assert broker.place_options_sl_order.call_args.kwargs['qty'] == 20
    assert order.quantity == 40
    assert isolated_protection_journal.get(manager.intent_key(s, order))['state'] == 'restored'
    await manager.shutdown()


@pytest.mark.asyncio
async def test_full_40_plus_20_entries_each_receive_their_own_stop(env, monkeypatch, isolated_protection_journal):
    s, broker, _ = env
    s.state = SimulationState.RUNNING
    entry(s, 'a', 40, stop=30)
    entry(s, 'b', 20, stop=32, created=2)
    broker.get_trade_history.return_value = [execution(order='a', qty=40), execution('b', 'b', time='13:53:28')]
    broker.get_positions.return_value = [reported_position(60)]
    broker.get_order_history.return_value = [broker_order('a', qty=40, filled=40), broker_order('b')]
    book = broker.get_order_history.return_value
    broker.get_order_history.side_effect = lambda: copy.deepcopy(book)
    monkeypatch.setattr(recovery, 'market_open', lambda s: True)
    monkeypatch.setattr(recovery, 'fresh_quote', lambda *args: 40.)
    monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda uid: {})
    def place(**kwargs):
        identifier = f"stop-{broker.place_options_sl_order.call_count}"
        row = broker_order(identifier, 'trigger pending', 'SELL', kwargs['qty'], 0)
        row.update(order_type='SL', trigger_price=kwargs['trigger_price'], limit_price=kwargs['limit_price'], tag=kwargs['tag'])
        broker.get_order_history.return_value.append(row)
        return identifier
    broker.place_options_sl_order.side_effect = place
    with pytest.raises(recovery.Deferred):
        await manager.audit(s, broker)
    assert broker.place_options_sl_order.call_count == 2
    await manager.audit(s, broker)
    assert [(c.kwargs['qty'], c.kwargs['trigger_price']) for c in broker.place_options_sl_order.call_args_list] == [(40, 30), (20, 32)]
    await manager.shutdown()


@pytest.mark.asyncio
async def test_five_entries_submit_from_one_snapshot_and_share_one_verification(env, monkeypatch, isolated_protection_journal):
    s, broker, _ = env
    s.state = SimulationState.RUNNING
    for index in range(5):
        entry(s, f'entry-{index}', 20, created=index)
    fills = [execution(str(index), f'entry-{index}', time=f'13:53:{20+index}') for index in range(5)]
    book = [broker_order(f'entry-{index}') for index in range(5)]
    broker.get_order_history.side_effect = lambda: copy.deepcopy(book)
    broker.get_trade_history.return_value = fills
    broker.get_positions.return_value = [reported_position(100)]
    monkeypatch.setattr(recovery, 'market_open', lambda s: True)
    monkeypatch.setattr(recovery, 'fresh_quote', lambda *args: 40.)
    monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda uid: {})
    def place(**kwargs):
        row = broker_order(f'stop-{len(book)}', 'trigger pending', 'SELL', kwargs['qty'], 0)
        row.update(order_type='SL', trigger_price=kwargs['trigger_price'], limit_price=kwargs['limit_price'], tag=kwargs['tag'])
        book.append(row)
        return row['kotak_order_id']
    broker.place_options_sl_order.side_effect = place
    with pytest.raises(recovery.Deferred):
        await manager.audit(s, broker)
    assert broker.place_options_sl_order.call_count == 5
    assert broker.get_order_history.call_count == broker.get_trade_history.call_count == broker.get_positions.call_count == 1
    await manager.audit(s, broker)
    assert broker.place_options_sl_order.call_count == 5
    assert broker.get_order_history.call_count == broker.get_trade_history.call_count == broker.get_positions.call_count == 2
    await manager.shutdown()


def test_unknown_cancellation_routes_to_entry_manager_without_origin_gate(env, monkeypatch):
    s, _, _ = env
    entry(s, 'a', 20)
    canceled = exit_order(s, 'cancelled', 20, owner='a')
    canceled.status = OrderStatus.CANCELLED
    request = Mock()
    monkeypatch.setattr(manager, 'request', request)
    recovery.note_cancel(s, canceled, {'raw_reason': '--', 'raw': {}})
    request.assert_called_once_with(s, reason='cancel', delay=.75)
    assert not recovery._tasks


@pytest.mark.asyncio
async def test_canceling_unfilled_entry_remainder_keeps_partial_fill_protection(env, isolated_protection_journal):
    s, _, _ = env
    partial = entry(s, 'a', 20)
    partial.quantity = 40
    partial.status = OrderStatus.PENDING
    assert await manager.suppress(s, partial, 20) is None
    assert manager.allocations(s, [execution(order='a')], [])[0][0][-1] == 20


def test_equity_entry_protection_retains_legacy_path(env, monkeypatch):
    s, _, _ = env
    order = entry(s, 'a', 20)
    s.instrument_type = 'equity'
    timer, legacy = Mock(), Mock()
    monkeypatch.setattr(entry_sl_watcher, '_schedule_delayed_sl', timer)
    monkeypatch.setattr(entry_sl_watcher, '_place_legacy_real_protection', legacy)
    monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda uid: {'entry_auto_sl_delay_sec': 3})
    entry_sl_watcher.on_entry_filled(order, s)
    timer.assert_called_once_with(order, s, 3, None)
    entry_sl_watcher._place_real_protection(order, s)
    legacy.assert_called_once_with(order, s)


@pytest.mark.asyncio
async def test_account_reports_reuse_accounting_reads_without_extra_requests(env, monkeypatch):
    _, broker, _ = env
    monkeypatch.setattr(kotak_reports, 'MIN_INTERVAL', 1)
    await kotak_reports.fetch(broker, include_orders=False)
    broker.get_order_history.assert_not_called()
    await kotak_reports.fetch(broker)
    broker.get_order_history.assert_called_once()
    broker.get_trade_history.assert_called_once()
    broker.get_positions.assert_called_once()


@pytest.mark.asyncio
async def test_account_backoff_is_shared_and_honors_retry_after(env):
    _, broker, _ = env
    from app.services.kotak_service import KotakError
    broker.get_positions.side_effect = KotakError('rate limited')
    for delay in (2, 5, 10):
        account = kotak_reports.state(broker)
        account.cooldown = 0  # Advance past the prior cooldown without sleeping.
        with pytest.raises(KotakError):
            await kotak_reports.fetch(broker)
        assert delay - .1 <= account.cooldown - time.monotonic() <= delay
    error = KotakError('rate limited')
    error.retry_after = 30
    broker.get_positions.side_effect = error
    account.cooldown = 0
    with pytest.raises(KotakError):
        await kotak_reports.fetch(broker)
    assert account.cooldown - time.monotonic() > 29


def test_manual_exclusion_is_consumed_when_its_entry_lots_exit(env):
    s, _, _ = env
    entry(s, 'a', 40)
    fills = [execution(order='a', qty=40), execution('exit', 'exit', side='SELL', qty=20, time='13:53:28')]
    exclusions = {'manual': {'contract': ['bse_fo', 'MIS', 'PE', 71100, s.expiry],
        'allocations': {'a': 20}, 'remaining': {'a': 40}, 'state': 'requested'}}
    assert manager.allocations(s, fills, [], exclusions)[0][0][-1] == 20


@pytest.mark.asyncio
async def test_uncertain_submission_reconciles_after_runtime_restart_without_duplicate(env, monkeypatch, isolated_protection_journal):
    s, broker, _ = env
    s.state = SimulationState.RUNNING
    original = entry(s, 'a', 20)
    broker.get_trade_history.return_value = [execution(order='a')]
    broker.get_positions.return_value = [reported_position()]
    broker.get_order_history.return_value = [broker_order('a')]
    monkeypatch.setattr(recovery, 'market_open', lambda s: True)
    monkeypatch.setattr(recovery, 'fresh_quote', lambda *args: 40.)
    monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda uid: {})
    def accepted_but_timeout(**kwargs):
        row = broker_order('accepted', 'trigger pending', 'SELL', kwargs['qty'], 0)
        row.update(order_type='SL', trigger_price=kwargs['trigger_price'], limit_price=kwargs['limit_price'], tag=kwargs['tag'])
        broker.get_order_history.return_value.append(row)
        raise TimeoutError('response lost after acceptance')
    broker.place_options_sl_order.side_effect = accepted_but_timeout
    with pytest.raises(recovery.Deferred):
        await manager.audit(s, broker)
    root = manager.intent_key(s, original)
    stale_index = isolated_protection_journal.get(root)
    stale_index.update(children=[], attempts=0, state='pending')
    isolated_protection_journal.put(root, stale_index)
    order_service._orders[s.session_id] = {original.order_id: original}
    await manager.audit(s, broker)
    broker.place_options_sl_order.assert_called_once()
    assert order_service.get_open_orders(s.session_id)[0].kotak_order_id == 'accepted'
    assert order_service.get_open_orders(s.session_id)[0].protection_group == 'a'
    assert isolated_protection_journal.get(manager.intent_key(s, original))['state'] == 'restored'
    await manager.shutdown()


@pytest.mark.asyncio
async def test_partial_cached_reports_are_not_relabelled_after_a_manual_change(env, monkeypatch):
    _, broker, _ = env
    monkeypatch.setattr(kotak_reports, 'MIN_INTERVAL', .02)
    await kotak_reports.fetch(broker, include_orders=False)
    account = kotak_reports.state(broker)
    account.foreground = 1
    task = asyncio.create_task(kotak_reports.fetch(broker, background=True))
    await asyncio.sleep(.005)
    kotak_reports.invalidate(broker)
    broker.get_positions.return_value = [{'netQty': 20}]
    account.foreground = 0
    fresh = await task
    assert fresh.positions == [{'netQty': 20}]
    assert broker.get_positions.call_count == 2


@pytest.mark.asyncio
async def test_regular_audit_verifies_in_memory_without_rewriting_history(env, monkeypatch):
    from app.services import real_broker_state, fifo_positions
    s, broker, _ = env
    entry(s, 'a', 20)
    broker.get_trade_history.return_value = [execution(order='a')]
    broker.get_positions.return_value = [reported_position()]
    broker.get_order_history.return_value = [broker_order('a')]
    s._fifo_executions = fifo_positions.unique_executions(s, broker.get_trade_history.return_value)
    s.broker_positions = fifo_positions.positions(s, s._fifo_executions)
    s._fifo_account = broker.account_identity()
    rewrite = AsyncMock(side_effect=AssertionError('Normal confirmed fills must not rewrite the day history'))
    monkeypatch.setattr(real_broker_state, 'refresh', rewrite)
    _, ledger = await manager.snapshot(s, broker)
    assert len(ledger) == 1
    rewrite.assert_not_awaited()


@pytest.mark.asyncio
async def test_rounded_cumulative_fill_average_keeps_lightweight_audit(env, monkeypatch):
    from app.services import real_broker_state, fifo_positions
    s, broker, _ = env
    entry(s, 'a', 40)
    local = execution(order='a', qty=40, price=38.58)
    s._fifo_executions = fifo_positions.unique_executions(s, [local])
    s.broker_positions = fifo_positions.positions(s, s._fifo_executions)
    s._fifo_account = broker.account_identity()
    broker.get_trade_history.return_value = [execution('first', 'a', price=38.55),
        execution('second', 'a', price=38.60, time='13:53:28')]
    broker.get_positions.return_value = [reported_position(40, 38.58)]
    broker.get_order_history.return_value = [broker_order('a', qty=40, filled=40, price=38.58)]
    rewrite = AsyncMock(side_effect=AssertionError('SDK average rounding is not a missing execution'))
    monkeypatch.setattr(real_broker_state, 'refresh', rewrite)
    _, ledger = await manager.snapshot(s, broker)
    assert len(ledger) == 2
    rewrite.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_execution_falls_back_to_one_shared_full_refresh(env, monkeypatch):
    from app.services import real_broker_state, fifo_positions
    s, broker, _ = env
    entry(s, 'a', 20)
    old = [execution(order='a')]
    s._fifo_executions = fifo_positions.unique_executions(s, old)
    s.broker_positions = fifo_positions.positions(s, s._fifo_executions)
    s._fifo_account = broker.account_identity()
    broker.get_trade_history.return_value = old + [execution('new', 'external', time='13:53:28')]
    broker.get_positions.return_value = [reported_position(40)]
    broker.get_order_history.return_value = [broker_order('a'), broker_order('external')]
    rewrite = AsyncMock(wraps=real_broker_state.refresh)
    monkeypatch.setattr(real_broker_state, 'refresh', rewrite)
    await manager.snapshot(s, broker)
    rewrite.assert_awaited_once()
    assert s.broker_positions[0]['quantity'] == 40
    broker.get_positions.assert_called_once()


def test_repeated_disagreements_are_spaced_in_account_queue(env):
    s, broker, _ = env
    # Exercise within an application loop because coordinator state owns Tasks.
    async def check():
        scope = s.session_id
        for delay in (2, 5, 10, 10):
            assert kotak_reports.disagree(broker, scope) == delay
            assert kotak_reports.state(broker).cooldown - time.monotonic() >= delay - .1
        kotak_reports.consistent(broker, scope)
        assert scope not in kotak_reports.state(broker).disagreements
    asyncio.run(check())


@pytest.mark.asyncio
async def test_background_history_staging_does_not_block_foreground_and_discards_stale_result(env, monkeypatch):
    from app.services import real_broker_state
    s, broker, _ = env
    entry(s, 'a', 20)
    broker.get_trade_history.return_value = [execution(order='a')]
    broker.get_positions.return_value = [reported_position()]
    broker.get_order_history.return_value = [broker_order('a')]
    stage = real_broker_state.stage
    original_orders = order_service._orders[s.session_id]
    def intervening_action(*args):
        assert getattr(s, 'broker_refresh_events', None) is None
        staged = stage(*args)
        s._protection_revision = getattr(s, '_protection_revision', 0) + 1
        return staged
    monkeypatch.setattr(real_broker_state, 'stage', intervening_action)
    with pytest.raises(recovery.Deferred, match='Trading changed during background staging'):
        await real_broker_state.refresh(s, broker, protection=True)
    assert order_service._orders[s.session_id] is original_orders
    assert s.broker_refresh_events is None
