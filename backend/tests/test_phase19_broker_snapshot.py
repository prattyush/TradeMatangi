"""Broker-day replacement, execution identity and protection regressions (no live orders)."""
import asyncio
import copy
from types import SimpleNamespace
from unittest.mock import MagicMock, AsyncMock
import pytest
from app.models.schemas import Order, OrderType, TradeSide, Position
from app.services import broker_reports as reports, real_broker_state as state
from app.services import simulation, trading, order_service, kotak_service, entry_sl_watcher, broker_order_service


class Table:
    def __init__(self, name):
        self.name, self.items, self.fail = name, {}, False
    def key(self, row):
        suffix = {"Trades": "trade_id", "Orders": "order_id", "TradeLabels": "round_trip_index"}.get(self.name)
        return (row['session_id'], row.get(suffix)) if suffix else row['session_id']
    def get_item(self, Key, **kwargs):
        row = self.items.get(self.key(Key))
        return {"Item": copy.deepcopy(row)} if row else {}
    def put_item(self, Item):
        if self.fail:
            raise RuntimeError('storage unavailable')
        self.items[self.key(Item)] = copy.deepcopy(Item)
    def update_item(self, Key, ExpressionAttributeValues, **kwargs):
        if self.fail:
            raise RuntimeError('link unavailable')
        row = self.items.setdefault(self.key(Key), dict(Key))
        if ':resolved' in ExpressionAttributeValues:
            row['protection_pending_tags'] = set(row.get('protection_pending_tags', [])) - ExpressionAttributeValues[':resolved']
            return
        if ':tag' in ExpressionAttributeValues:
            tags = set(row.get('protection_pending_tags', []))
            if kwargs.get('UpdateExpression', '').startswith('DELETE'):
                tags -= ExpressionAttributeValues[':tag']
            else:
                tags |= ExpressionAttributeValues[':tag']
            row['protection_pending_tags'] = tags
            return
        if ':expires' in ExpressionAttributeValues:
            row.update(protection_owner=ExpressionAttributeValues[':owner'], protection_expires=ExpressionAttributeValues[':expires'])
            return
        row.update(broker_projection_id=ExpressionAttributeValues[':root'], broker_projection_owner=ExpressionAttributeValues[':owner'])
    def delete_item(self, Key, **kwargs):
        self.items.pop(self.key(Key), None)
    def query(self, KeyConditionExpression, **kwargs):
        if isinstance(KeyConditionExpression, str):
            values = kwargs['ExpressionAttributeValues']
            name, value = ('session_id', values[':sid']) if ':sid' in values else ('user_id', values[':uid'])
            return {'Items': [copy.deepcopy(r) for r in self.items.values() if r.get(name) == value]}
        expression = KeyConditionExpression.get_expression()['values']
        name, value = expression[0].name, expression[1]
        return {'Items': [copy.deepcopy(r) for r in self.items.values() if r.get(name) == value]}


@pytest.fixture
def env(monkeypatch):
    session = simulation.SimulationSession(session_id='snapshot-test', symbol='BSESEN', date='2026-10-01',
        start_time='09:15:00', speed=1, user_id='snapshot-user', session_type='real', instrument_type='options',
        strike=71500, strike_ce=71500, strike_pe=71500, expiry='2026-10-01')
    session.current_time = str(reports.wall_time('2026-10-01 14:46:06'))
    tables = {name: Table(name) for name in ('Sessions', 'Trades', 'Orders', 'TradeLabels')}
    db = SimpleNamespace(Table=lambda name: tables[name])
    monkeypatch.setattr('app.services.db.get_dynamodb_resource', lambda: db)
    monkeypatch.setattr(simulation, 'get_session', lambda sid: session if sid == session.session_id else None)
    monkeypatch.setattr('app.services.real_accounting.refresh', AsyncMock(return_value={
        'balance': 900, 'display_balance': 800, 'session_capital': 18000}))
    monkeypatch.setattr(simulation, '_upsert_session_to_db', MagicMock())
    monkeypatch.setattr('app.services.guardrail_service.on_trade_record', MagicMock())
    monkeypatch.setattr(order_service, 'request_exit_reconciliation', MagicMock())
    tables['Sessions'].put_item(Item=dict(session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
        date=session.date, session_type='real', instrument_type='options'))
    broker = MagicMock()
    broker.account_identity.return_value = 'account-a'
    broker.get_funds.return_value = 900
    broker.get_order_history.return_value = []
    broker.get_trade_history.return_value = []
    broker.get_positions.return_value = []
    monkeypatch.setattr(kotak_service, 'get_service', lambda: broker)
    order_service._orders[session.session_id] = {}
    trading._trades[session.session_id] = []
    yield session, broker, tables
    order_service._orders.pop(session.session_id, None)
    trading._trades.pop(session.session_id, None)
    state._links.clear()
    state._locks.clear()
    from app.services.real_protection import cancel
    cancel(session.session_id)


def test_broker_timestamp_formats_preserve_ist_wall_clock():
    expected = reports.wall_time('2026-10-01 13:53:27')
    assert reports.wall_time('01-Oct-2026 13:53:27') == expected
    assert reports.wall_time('2026-10-01T08:23:27Z') == expected
    assert reports.wall_time('2026-10-01T13:53:27+05:30') == expected


def test_invalid_broker_timestamp_has_context():
    with pytest.raises(ValueError, match='Cannot parse broker timestamp') as error:
        reports.wall_time('unexpected broker date')
    assert 'unexpected broker date' in str(error.value)
    assert isinstance(error.value.__cause__, ValueError)


def execution(identifier='fill-a', order='broker-a', qty=20, price=38.6, side='BUY', time='13:53:27', strike=71100):
    return reports.normalize_execution(dict(flId=identifier, nOrdNo=order, fldQty=qty, flPrc=price, trnsTp='B' if side == 'BUY' else 'S',
        trdSym=f'SENSEX26O01{strike}PE', exSeg='bse_fo', flDt='01-Oct-2026', flTm=time))


def broker_order(order='broker-a', status='complete', side='BUY', qty=20, filled=20, price=38.6):
    return reports.normalize_order(dict(nOrdNo=order, ordSt=status, trnsTp='B' if side == 'BUY' else 'S',
        qty=qty, fldQty=filled, avgPrc=price, trdSym='SENSEX26O0171100PE', exSeg='bse_fo', prcTp='L', prc=40,
        ordDtTm='01-Oct-2026 13:53:00'))


@pytest.mark.asyncio
async def test_refresh_replaces_duplicates_with_exact_execution_contract_and_time(env):
    s, broker, tables = env
    trading._trades[s.session_id] = [MagicMock(trade_id='old-duplicate')]
    broker.get_trade_history.return_value = [execution(), execution(), execution('fill-b', qty=20, price=40)]
    broker.get_order_history.return_value = [broker_order(qty=40, filled=40)]
    first = await state.refresh(s, broker)
    second = await state.refresh(s, broker)
    assert len(first['trades']) == len(second['trades']) == 1
    row = second['trades'][0]
    assert row['strike'] == 71100 and row['quantity'] == 40 and row['price'] == pytest.approx(39.3)
    assert row['timestamp'] == reports.wall_time('2026-10-01 13:53:27')
    assert row['trade_id'] == first['trades'][0]['trade_id']
    assert row['broker_execution_ids'] == ['fill-a', 'fill-b']
    assert row['commission'] == trading.compute_commission(TradeSide.BUY, 39.3, 40, s.brokerage_per_order)
    assert state.read_projection(s.session_id)[0]['trade_id'] == row['trade_id']
    assert second['wallet_balance'] == 900
    assert second['wallet_display_balance'] == 800
    assert second['session_capital'] == s.session_capital == 18000


@pytest.mark.asyncio
async def test_refresh_includes_other_strikes_same_underlying_and_excludes_other_underlying(env):
    s, broker, _ = env
    other = execution('nifty', order='nifty')
    other['symbol'] = 'NIFTY26O0122500PE'
    broker.get_trade_history.return_value = [execution(), execution('other-strike', 'other', strike=71500), other]
    result = await state.refresh(s, broker)
    assert {r['strike'] for r in result['trades']} == {71100, 71500}


@pytest.mark.asyncio
async def test_order_refresh_includes_all_rights_strikes_expiries_and_statuses(env):
    s, broker, _ = env
    rows = []
    for identifier, symbol, status in [
        ('pe-a', 'SENSEX26O0171100PE', 'trigger pending'),
        ('ce-b', 'SENSEX26O0171500CE', 'open'),
        ('ce-next', 'SENSEX26O0871800CE', 'cancelled'),
        ('other', 'NIFTY26O0122500PE', 'open'),
    ]:
        row = broker_order(identifier, status=status, filled=0)
        row['symbol'] = symbol
        rows.append(row)
    broker.get_order_history.return_value = rows
    result = await state.refresh(s, broker)
    assert {r['kotak_order_id'] for r in result['orders']} == {'pe-a', 'ce-b', 'ce-next'}
    assert {r['right'] for r in result['orders']} == {'CE', 'PE'}
    assert {r['strike'] for r in result['orders']} == {71100, 71500, 71800}
    assert {r['expiry'] for r in result['orders']} == {'2026-10-01', '2026-10-08'}


@pytest.mark.asyncio
async def test_empty_report_is_authoritative_and_preserves_local_entry(env):
    s, broker, _ = env
    local = Order(session_id=s.session_id, user_id=s.user_id, symbol=s.symbol, side=TradeSide.BUY, order_type=OrderType.LIMIT,
        quantity=20, limit_price=30, trigger_price=30, created_at=1, right='CE', strike=71500, expiry=s.expiry)
    order_service._orders[s.session_id][local.order_id] = local
    result = await state.refresh(s, broker)
    assert result['trades'] == []
    assert result['local_entry_orders'][0]['order_id'] == local.order_id


@pytest.mark.asyncio
async def test_report_failure_leaves_previous_revision_and_memory(env):
    s, broker, _ = env
    broker.get_trade_history.return_value = [execution()]
    first = await state.refresh(s, broker)
    broker.get_trade_history.side_effect = kotak_service.KotakError('report failed')
    with pytest.raises(kotak_service.KotakError):
        await state.refresh(s, broker)
    assert state._links[s.session_id]['revision'] == first['snapshot_revision']
    assert len(trading.get_trades(s.session_id)) == 1
    assert s.broker_refresh_events is None


@pytest.mark.asyncio
async def test_staging_failure_never_publishes_revision(env):
    s, broker, tables = env
    broker.get_trade_history.return_value = [execution()]
    first = await state.refresh(s, broker)
    tables['Trades'].fail = True
    with pytest.raises(RuntimeError):
        await state.refresh(s, broker)
    assert state._links[s.session_id]['revision'] == first['snapshot_revision']


@pytest.mark.asyncio
async def test_link_failure_does_not_advance_manifest(env):
    s, broker, tables = env
    first = await state.refresh(s, broker)
    tables['Sessions'].fail = True
    with pytest.raises(RuntimeError):
        await state.refresh(s, broker)
    root = state.projection_id(s, 'account-a')
    assert tables['Sessions'].items[root]['revision'] == first['snapshot_revision']


@pytest.mark.asyncio
async def test_wallet_failure_preserves_valid_snapshot(env):
    s, broker, _ = env
    from app.services import real_accounting
    real_accounting.refresh.side_effect = RuntimeError('funds unavailable')
    result = await state.refresh(s, broker)
    assert result['wallet_balance'] is None and result['wallet_error']
    assert result['snapshot_revision']


@pytest.mark.asyncio
async def test_refresh_imports_modified_sl_and_restores_broker_identity(env):
    s, broker, _ = env
    row = broker_order(status='trigger_pending', side='SELL', filled=0)
    row.update(order_type='SL', trigger_price=32, limit_price=31.5)
    broker.get_order_history.return_value = [row]
    result = await state.refresh(s, broker)
    assert result['application_orders'][0]['trigger_price'] == 32
    order_service._orders[s.session_id] = {}
    state.restore_orders(s)
    restored = order_service.get_all_orders(s.session_id)[0]
    assert restored.kotak_order_id == 'broker-a' and restored.trigger_price == 32
    assert s.kotak_order_map[restored.order_id] == 'broker-a'


def test_position_amount_fallback_and_carry(env):
    s, _, _ = env
    rows = state.normalize_positions(s, [dict(trdSym='SENSEX26O0171100PE', cfBuyQty='20', flBuyQty='20',
        cfBuyAmt='600', flBuyAmt='1000', cfSellQty='20', flSellQty='0')])
    assert rows[0]['quantity'] == 20 and rows[0]['avg_entry_price'] == 40
    s.broker_positions = rows
    assert trading.get_position(s.session_id, s.symbol, 'PE', 71100, s.expiry).quantity == 20
    assert trading.get_position(s.session_id, s.symbol, 'PE', 71500, s.expiry).quantity == 0


@pytest.mark.asyncio
async def test_partial_fill_is_cumulative_idempotent_and_deferred_during_refresh(env, monkeypatch):
    s, broker, _ = env
    order = Order(session_id=s.session_id, user_id=s.user_id, symbol=s.symbol, side=TradeSide.BUY, order_type=OrderType.LIMIT,
        quantity=40, trigger_price=40, limit_price=40, created_at=1, right='PE', strike=71100, expiry=s.expiry,
        execution_role='entry', kotak_order_id='broker-a')
    order_service._orders[s.session_id][order.order_id] = order
    monkeypatch.setattr(trading, '_write_trade_to_db', MagicMock())
    broker_order_service.register_callbacks(s, order, broker, asyncio.get_running_loop())
    callback = broker.register_fill_callback.call_args.args[1]
    s.broker_refresh_events = []
    callback('broker-a', 'BUY', 20, 38)
    assert order.broker_filled_quantity == 0
    events, s.broker_refresh_events = s.broker_refresh_events, None
    for cb, args in events:
        cb(*args)
    callback('broker-a', 'BUY', 20, 38)
    assert not order.kotak_fill_confirmed
    callback('broker-a', 'BUY', 40, 39)
    assert order.kotak_fill_confirmed
    assert len(trading.get_trades(s.session_id)) == 1
    assert trading.get_trades(s.session_id)[0].quantity == 40
    assert trading.get_trades(s.session_id)[0].price == 39


@pytest.mark.asyncio
async def test_explicit_real_sl_ignores_auto_toggle_and_preserves_entry_quantity(env, monkeypatch):
    s, broker, _ = env
    broker.place_options_sl_order.return_value = 'protect-a'
    monkeypatch.setattr('app.services.user_settings_service.get_settings', lambda uid: {'entry_auto_sl_enabled': False, 'entry_auto_sl_delay_sec': 0})
    order = Order(session_id=s.session_id, symbol=s.symbol, user_id=s.user_id, side=TradeSide.BUY,
        order_type=OrderType.LIMIT, quantity=40, trigger_price=40, limit_price=40, created_at=1, right='PE',
        strike=71100, expiry=s.expiry, execution_role='entry', broker_filled_quantity=20, filled_price=40,
        entry_sl_price=30, group_id='entry-group', kotak_order_id='entry-a')
    order_service._orders[s.session_id][order.order_id] = order
    s.broker_positions = [dict(symbol=s.symbol, side='LONG', quantity=20, avg_entry_price=40, right='PE', strike=71100, expiry=s.expiry)]
    from app.services import real_protection
    monkeypatch.setattr(real_protection, '_verify_fresh', AsyncMock())
    s.protection_executions = [execution(order='entry-a', qty=20)]
    s.broker_positions[0].update(exchange='bse_fo', product='MIS')
    entry_sl_watcher.on_entry_filled(order, s, asyncio.get_running_loop())
    assert real_protection._states[s.session_id].timer is not None
    real_protection.cancel(s.session_id)
    await real_protection._repair(s, broker, 'account-a')
    assert order.quantity == 40
    broker.place_options_sl_order.assert_called_once()
    assert broker.place_options_sl_order.call_args.kwargs['qty'] == 20
    await real_protection._repair(s, broker, 'account-a')
    broker.place_options_sl_order.assert_called_once()


def test_labels_remap_only_exact_round_trip(env):
    s, _, _ = env
    new = state.aggregate(s, [execution(), execution('sell', 'exit', side='SELL', price=40.4, time='13:54:53')], 'account-a')
    old = [{**t.model_dump(mode='json'), 'trade_id': 'legacy-' + str(i)} for i, t in enumerate(new)]
    labels = [dict(round_trip_index=0, entry_tag='pattern')]
    assert state.remap_labels(old, labels, new)[0]['entry_tag'] == 'pattern'
    old[0]['timestamp'] += 60
    old[0]['kotak_order_id'] = None
    assert state.remap_labels(old, labels, new) == []


@pytest.mark.parametrize('payload', [{'stat': 'Not_Ok', 'errMsg': 'failed'}, {}, {'data': {}}, {'data': [None]}])
def test_failed_or_malformed_report_never_becomes_empty(payload):
    broker = kotak_service.KotakNeoService()
    client = MagicMock()
    client.trade_report.return_value = payload
    broker._get_client = lambda: client
    with pytest.raises(kotak_service.KotakError):
        broker.get_trade_history()


def test_valid_empty_report_is_accepted():
    broker = kotak_service.KotakNeoService()
    client = MagicMock()
    client.trade_report.return_value = {'data': []}
    broker._get_client = lambda: client
    assert broker.get_trade_history() == []

@pytest.mark.asyncio
async def test_protection_splits_sensex_freeze_and_retries_only_uncovered_quantity(env, monkeypatch):
    s, broker, _ = env
    broker.place_options_sl_order.side_effect = ['protect-1', kotak_service.KotakError('Kotak API error: rejected (code 400)'), 'protect-2']
    order = Order(session_id=s.session_id, user_id=s.user_id, symbol=s.symbol, side=TradeSide.BUY,
        order_type=OrderType.LIMIT, quantity=1020, trigger_price=40, limit_price=40, created_at=1,
        right='PE', strike=71100, expiry=s.expiry, entry_sl_price=30, group_id='large-entry',
        execution_role='entry', broker_filled_quantity=1020, filled_price=40, kotak_fill_confirmed=True, kotak_order_id='entry-large')
    order_service._orders[s.session_id][order.order_id] = order
    s.broker_positions = [dict(symbol=s.symbol, side='LONG', quantity=1020, avg_entry_price=40, right='PE', strike=71100, expiry=s.expiry)]
    from app.services import real_protection
    monkeypatch.setattr(real_protection, '_verify_fresh', AsyncMock())
    s.protection_executions = [execution(order='entry-large', qty=1020)]
    s.broker_positions[0].update(exchange='bse_fo', product='MIS')
    with pytest.raises(kotak_service.KotakError):
        await real_protection._repair(s, broker, 'account-a')
    assert [c.kwargs['qty'] for c in broker.place_options_sl_order.call_args_list] == [1000, 20]
    await real_protection._repair(s, broker, 'account-a')
    assert [c.kwargs['qty'] for c in broker.place_options_sl_order.call_args_list] == [1000, 20, 20]
    assert sum(o.quantity for o in order_service.get_open_orders(s.session_id) if o.kotak_order_id and o.execution_role == 'exit') == 1020

@pytest.mark.parametrize('report', ['order_report', 'positions'])
def test_malformed_fact_row_is_not_an_authoritative_empty_report(report):
    broker = kotak_service.KotakNeoService()
    client = MagicMock()
    getattr(client, report).return_value = {'data': [{}]}
    broker._get_client = lambda: client
    with pytest.raises(kotak_service.KotakError):
        broker.get_order_history() if report == 'order_report' else broker.get_positions()


def test_projection_identity_separates_users_and_accounts(env):
    s, _, _ = env
    first = state.projection_id(s, 'account-a')
    assert first != state.projection_id(s, 'account-b')
    s.user_id = 'another-user'
    assert first != state.projection_id(s, 'account-a')


def test_read_projection_restores_hot_write_pointer_after_restart(env):
    s, _, tables = env
    manifest, members = state.stage(s, 'account-a', state.aggregate(s, [execution()], 'account-a'), [], [], [], {})
    state.commit(s, manifest, members)
    state._links.clear()
    assert state.read_projection(s.session_id)
    assert state.active_partition(s.session_id) == manifest['active_partition']

@pytest.mark.asyncio
async def test_label_read_edit_delete_and_stats_follow_rebuilt_day(env, monkeypatch):
    from app.services import trade_label_service as labels
    s, broker, tables = env
    monkeypatch.setattr(labels, '_table', lambda: tables['TradeLabels'])
    broker.get_trade_history.return_value = [execution(), execution('sell', 'exit', side='SELL', price=40.4, time='13:54:53')]
    original = state.aggregate(s, broker.get_trade_history.return_value, 'account-a')
    for index, trade in enumerate(original):
        tables['Trades'].put_item(Item={**trade.model_dump(mode='json'), 'trade_id': 'old-' + str(index)})
    tables['TradeLabels'].put_item(Item=dict(session_id=s.session_id, round_trip_index=0, user_id=s.user_id,
        symbol=s.symbol, date=s.date, session_type='real', entry_tag='pattern'))
    await state.refresh(s, broker)
    assert labels.get_labels_for_session(s.session_id)[0]['entry_tag'] == 'pattern'
    labels.update_label(s.session_id, 0, {'entry_tag': 'updated'})
    assert labels.get_labels_for_session(s.session_id)[0]['entry_tag'] == 'updated'
    assert labels.get_stats(s.user_id)['total_trades'] == 1
    await state.refresh(s, broker)
    assert labels.get_labels_for_session(s.session_id)[0]['entry_tag'] == 'updated'
    labels.delete_label(s.session_id, 0)
    assert labels.get_labels_for_session(s.session_id) == []

@pytest.mark.asyncio
async def test_imported_sl_coverage_prevents_duplicate_protection(env):
    s, broker, _ = env
    entry = Order(session_id=s.session_id, user_id=s.user_id, symbol=s.symbol, side=TradeSide.BUY,
        order_type=OrderType.LIMIT, quantity=20, trigger_price=40, limit_price=40, created_at=1,
        right='PE', strike=71100, expiry=s.expiry, entry_sl_price=30, group_id='entry-group',
        execution_role='entry', broker_filled_quantity=20, filled_price=40, kotak_fill_confirmed=True)
    order_service._orders[s.session_id][entry.order_id] = entry
    row = broker_order('external-sl', status='trigger pending', side='SELL', filled=0)
    row.update(order_type='SL', trigger_price=30, limit_price=29.5)
    broker.get_order_history.return_value = [row]
    broker.get_positions.return_value = [dict(trdSym='SENSEX26O0171100PE', netQty=20, avgPrc=40)]
    await state.refresh(s, broker)
    from app.services.real_protection import _repair
    await _repair(s, broker, "account-a")
    broker.place_options_sl_order.assert_not_called()

def test_partial_cancel_dispatches_confirmed_fill_before_rejection():
    broker = kotak_service.KotakNeoService()
    loop, fill, rejected = MagicMock(), MagicMock(), MagicMock()
    broker.register_fill_callback('partial', fill, loop)
    broker.register_reject_callback('partial', rejected, loop)
    broker._on_message({'type': 'order_feed', 'data': {'type': 'order', 'data': {
        'nOrdNo': 'partial', 'ordSt': 'cancelled', 'fldQty': '20', 'qty': '40', 'avgPrc': '38', 'trnsTp': 'B'}}})
    calls = loop.call_soon_threadsafe.call_args_list
    assert calls[0].args == (fill, 'partial', 'BUY', 20, 38)
    assert calls[1].args[0] is rejected

@pytest.mark.asyncio
async def test_refresh_retries_reports_that_straddle_a_fill(env):
    s, broker, _ = env
    broker.get_order_history.return_value = [broker_order(qty=40, filled=40)]
    broker.get_trade_history.side_effect = [[execution()], [execution(), execution('fill-b', qty=20, price=40)]]
    result = await state.refresh(s, broker)
    assert result['trades'][0]['quantity'] == 40
    assert broker.get_trade_history.call_count == 2

@pytest.mark.asyncio
async def test_incoherent_report_does_not_erase_last_good_history(env):
    s, broker, _ = env
    broker.get_trade_history.return_value = [execution()]
    first = await state.refresh(s, broker)
    broker.get_order_history.return_value = [broker_order(qty=40, filled=40)]
    with pytest.raises(ValueError, match='still updating'):
        await state.refresh(s, broker)
    assert state._links[s.session_id]['revision'] == first['snapshot_revision']
    assert trading.get_trades(s.session_id)[0].quantity == 20

def test_execution_identity_is_scoped_to_broker_order(env):
    s, _, _ = env
    trades = state.aggregate(s, [execution(), execution(order='other-order', strike=71500)], 'account-a')
    assert len(trades) == 2 and {t.strike for t in trades} == {71100, 71500}
