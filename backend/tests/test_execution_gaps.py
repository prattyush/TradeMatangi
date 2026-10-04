"""Real broker payloads retain the account's independent execution gaps."""
import asyncio
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException
from pydantic import ValidationError

from app.models.schemas import Order, OrderType, TradeSide, Position, PlaceOrderRequest, UpdateOrderRequest, UserSettingsUpdateRequest
from app.services import execution_price_service as prices, order_service, simulation, trading, kotak_service, user_settings_service, strategy_service
from app.routers import orders, desktop_trading, trading as trade_routes

WRITE_ORDER = order_service._write_order_to_db


@pytest.fixture
def real(monkeypatch):
    session = simulation.SimulationSession(session_id='execution-gaps', symbol='RELIANCE', date='2026-10-01',
        start_time='09:15:00', speed=1, user_id='gap-user', session_type='real', session_capital=10000)
    session.current_time = '1790826300'
    session.last_price = 100
    settings = dict(user_settings_service.DEFAULT_SETTINGS)
    broker = MagicMock()
    broker.place_sl_order.return_value = 'sl-broker'
    broker.place_limit_order.return_value = 'limit-broker'
    broker.modify_sl_order.return_value = None
    broker.modify_sl_to_limit_order.return_value = None
    monkeypatch.setattr(simulation, 'get_session', lambda sid: session if sid == session.session_id else None)
    monkeypatch.setattr(user_settings_service, 'get_settings', lambda uid: dict(settings))
    monkeypatch.setattr(desktop_trading, 'get_settings', lambda uid: dict(settings))
    monkeypatch.setattr(kotak_service, 'get_service', lambda: broker)
    monkeypatch.setattr(order_service, '_write_order_to_db', MagicMock())
    monkeypatch.setattr(order_service, '_adjust_buy_reservation', lambda *a, **k: None)
    monkeypatch.setattr('app.services.wallet_service.debit', lambda *a, **k: None)
    monkeypatch.setattr(trading, 'get_position', lambda *a, **k: Position(symbol=session.symbol, side='LONG', quantity=10, avg_entry_price=100))
    monkeypatch.setattr('app.services.guardrail_service.check_guardrails', lambda *a: (False, ''))
    monkeypatch.setattr('app.services.guardrail_service.check_maxsize', lambda *a, **k: (False, ''))
    monkeypatch.setattr(strategy_service, 'on_tick', lambda *a, **k: None)
    monkeypatch.setattr(strategy_service, 'list_running', lambda *a: [])
    order_service._orders[session.session_id] = {}
    yield session, broker, settings
    order_service._orders.pop(session.session_id, None)


def create(session, kind=OrderType.STOPLOSS, side=TradeSide.SELL, **kwargs):
    return order_service.place_order(session_id=session.session_id, user_id=session.user_id,
        symbol=session.symbol, side=side, order_type=kind, quantity=1, created_at=int(session.current_time),
        trading_date=session.date, trigger_price=100, limit_price=100, **kwargs)


@pytest.mark.parametrize('side,expected', [('BUY', 101.5), ('SELL', 98.5)])
def test_stoploss_default_and_submission(real, side, expected):
    session, broker, _ = real
    order = create(session, side=TradeSide(side))
    assert order.execution_gap_pct == 0.015
    assert order.limit_price == expected
    # Force exit detection for a BUY cover as well.
    with patch.object(simulation, '_is_position_exit', return_value=True):
        simulation._register_kotak_sl_for_order(session, order, MagicMock())
    assert broker.place_sl_order.call_args.kwargs['limit_price'] == expected
    assert broker.place_sl_order.call_args.kwargs['trigger_price'] == 100


@pytest.mark.parametrize('side,expected', [('BUY', 101), ('SELL', 99)])
def test_target_ignores_stale_client_setting_and_forwarding_does_not_add_gap(real, side, expected):
    session, broker, settings = real
    order = create(session, OrderType.TARGET, TradeSide(side), target_deviation_pct=0.09)
    assert order.limit_price == expected
    assert order.execution_gap_pct == 0.01
    settings['target_deviation_pct'] = 0.03
    asyncio.run(_forward(session))
    assert broker.place_limit_order.call_args.kwargs['price'] == expected
    assert order.limit_price == expected


async def _forward(session):
    simulation._emit_tick_and_check_orders_real(session, {'time': int(session.current_time), 'close': 100}, None, asyncio.get_running_loop())


@pytest.mark.asyncio
@pytest.mark.parametrize('side,expected', [('BUY', 102), ('SELL', 98)])
async def test_website_market_uses_current_server_quote(real, side, expected):
    session, broker, settings = real
    settings['target_deviation_pct'] = 0.02
    order = await orders.place_order(PlaceOrderRequest(session_id=session.session_id, side=side,
        order_type='LIMIT', limit_price=500, quote_price=500, quantity=1, market_order=True, execute_immediately=True))
    assert order.market_order and order.quote_price == 100
    assert order.limit_price == expected
    assert broker.place_limit_order.call_args.kwargs['price'] == expected


@pytest.mark.asyncio
async def test_desktop_market_uses_same_account_gap(real):
    session, broker, settings = real
    settings['target_deviation_pct'] = 0.025
    order = await desktop_trading.place_chart_order(session.session_id,
        desktop_trading.ChartOrderIntent(symbol=session.symbol, side='BUY', intent='market', quantity=1), user_id=session.user_id)
    assert order.limit_price == 102.5 and order.market_order
    assert broker.place_limit_order.call_args.kwargs['price'] == 102.5


def test_direct_market_path_uses_account_gap(real):
    session, broker, settings = real
    settings['target_deviation_pct'] = 0.025
    async def submit():
        trade_routes._place_kotak_direct(session, TradeSide.SELL, 100, 1, None)
    asyncio.run(submit())
    assert broker.place_limit_order.call_args.kwargs['price'] == 97.5


@pytest.mark.parametrize('autostop', [False, True])
def test_explicit_limit_including_autostop_is_not_adjusted(real, autostop):
    session, broker, settings = real
    order = create(session, OrderType.LIMIT, is_autostop=autostop)
    settings['target_deviation_pct'] = 0.07
    asyncio.run(_forward(session))
    assert broker.place_limit_order.call_args.kwargs['price'] == 100
    assert order.execution_gap_pct is None


@pytest.mark.asyncio
async def test_new_setting_applies_to_trigger_edit_but_not_quantity_edit(real):
    session, broker, settings = real
    order = await orders.place_order(PlaceOrderRequest(session_id=session.session_id, side='SELL',
        order_type='STOPLOSS', trigger_price=100, quantity=1))
    settings['stoploss_limit_gap_pct'] = 0.03
    assert order.limit_price == 98.5
    await orders.update_order(order.order_id, UpdateOrderRequest(quantity=2), session.session_id)
    assert broker.modify_sl_order.call_args.args[2] == 98.5
    assert order.limit_price == 98.5
    # A deliberate edit of the same trigger refreshes its gap too.
    await orders.update_order(order.order_id, UpdateOrderRequest(trigger_price=100), session.session_id)
    assert broker.modify_sl_order.call_args.args[2] == 97
    assert order.limit_price == 97 and order.execution_gap_pct == 0.03
    restored = Order.model_validate(order.model_dump())
    assert restored.execution_gap_pct == 0.03 and restored.limit_price == 97


@pytest.mark.asyncio
async def test_broker_rejected_edit_preserves_all_local_prices(real):
    session, broker, settings = real
    order = await orders.place_order(PlaceOrderRequest(session_id=session.session_id, side='SELL',
        order_type='STOPLOSS', trigger_price=100, quantity=1))
    before = order.model_dump()
    settings['stoploss_limit_gap_pct'] = 0.03
    broker.modify_sl_order.side_effect = kotak_service.KotakError('rejected')
    with pytest.raises(HTTPException):
        await orders.update_order(order.order_id, UpdateOrderRequest(trigger_price=95), session.session_id)
    assert order.model_dump() == before


@pytest.mark.asyncio
async def test_strategy_trigger_edit_uses_stoploss_setting(real):
    session, broker, settings = real
    order = await orders.place_order(PlaceOrderRequest(session_id=session.session_id, side='SELL',
        order_type='STOPLOSS', trigger_price=100, quantity=1))
    settings['stoploss_limit_gap_pct'] = 0.02
    strategy_service._update_exit_order_price(session, order, 95)
    assert order.limit_price == 93.1
    assert broker.modify_sl_order.call_args.args[2] == 93.1


@pytest.mark.parametrize('side,base,gap,expected', [('BUY', 100, 0, 100), ('SELL', 100, 0, 100), ('BUY', 100.03, .015, 101.55), ('SELL', 100.03, .015, 98.55)])
def test_tick_rounding(side, base, gap, expected):
    assert prices.limit_price(side, base, gap) == expected


@pytest.mark.parametrize('gap', [-.01, .11, float('inf'), float('nan')])
def test_invalid_gap_rejected_by_schema_and_desktop_service(gap):
    with pytest.raises(ValidationError):
        UserSettingsUpdateRequest(stoploss_limit_gap_pct=gap)
    with pytest.raises(ValueError):
        user_settings_service.update_settings('user', {'stoploss_limit_gap_pct': gap})


@pytest.mark.parametrize('base', [0, -1, float('inf'), float('nan'), .001])
def test_invalid_or_zero_rounded_price(base):
    with pytest.raises(ValueError):
        prices.limit_price('BUY', base, 0)


def test_gaps_persist_and_settings_save_failure_propagates(monkeypatch):
    resource = MagicMock()
    table = resource.Table.return_value
    table.get_item.return_value = {}
    monkeypatch.setattr('app.services.db.get_dynamodb_resource', lambda: resource)
    monkeypatch.setattr(user_settings_service, '_ensure_table', lambda: None)
    result = user_settings_service.update_settings('user', {'target_deviation_pct': .02, 'stoploss_limit_gap_pct': .03})
    write = table.update_item.call_args.kwargs
    item = {key: write['ExpressionAttributeValues'][f':v{index}'] for index, key in enumerate(write['ExpressionAttributeNames'].values())}
    assert item['target_deviation_pct'] == Decimal('.02')
    assert item['stoploss_limit_gap_pct'] == Decimal('.03')
    assert result['target_deviation_configured']
    table.get_item.return_value = {'Item': item}
    assert user_settings_service.get_settings('user')['stoploss_limit_gap_pct'] == .03
    table.update_item.side_effect = RuntimeError('database unavailable')
    with pytest.raises(RuntimeError):
        user_settings_service.update_settings('user', {'stoploss_limit_gap_pct': .015})


def test_legacy_migration_uses_conditional_write_and_preserves_saved_server_value(monkeypatch):
    resource = MagicMock()
    table = resource.Table.return_value
    table.get_item.return_value = {'Item': {'target_deviation_pct': Decimal('.025')}}
    table.update_item.side_effect = ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')
    monkeypatch.setattr('app.services.db.get_dynamodb_resource', lambda: resource)
    monkeypatch.setattr(user_settings_service, '_ensure_table', lambda: None)
    result = user_settings_service.migrate_target_gap('user', .02)
    assert result['target_deviation_pct'] == .025 and result['target_deviation_configured']
    assert 'attribute_not_exists(target_deviation_pct)' in table.update_item.call_args.kwargs['ConditionExpression']


def test_simulated_stoploss_keeps_existing_fill_behavior(real):
    session, _, _ = real
    session.session_type = 'sim'
    order = create(session)
    assert order.limit_price == 100 and order.execution_gap_pct is None


@pytest.mark.asyncio
@pytest.mark.parametrize('with_existing', [False, True])
async def test_desktop_real_flatten_uses_market_gap_not_emergency_offset(real, monkeypatch, with_existing):
    session, broker, settings = real
    settings['target_deviation_pct'] = .02
    monkeypatch.setattr(desktop_trading, '_snapshot', lambda *a: MagicMock())
    if with_existing:
        order = await orders.place_order(PlaceOrderRequest(session_id=session.session_id, side='SELL', order_type='STOPLOSS', trigger_price=95, quantity=10))
    result = await desktop_trading.flatten(session.session_id, desktop_trading.FlattenRequest(emergency_offset_pct=.1), user_id=session.user_id)
    if with_existing:
        assert broker.modify_sl_to_limit_order.call_args.args[1] == 98
        row = result['converted'][0]
    else:
        assert broker.place_limit_order.call_args.kwargs['price'] == 98
        row = result['created'][0]
    assert row['execution_gap_pct'] == .02 and row['market_order']


@pytest.mark.asyncio
async def test_real_target_edit_uses_latest_target_gap(real):
    session, broker, settings = real
    order = create(session, OrderType.TARGET, TradeSide.BUY)
    settings['target_deviation_pct'] = .025
    result = await orders.update_order(order.order_id, UpdateOrderRequest(trigger_price=120, target_deviation_pct=.09), session.session_id)
    assert result.limit_price == 123 and result.execution_gap_pct == .025


@pytest.mark.asyncio
async def test_exact_option_quote_is_used_for_desktop_market(real):
    session, broker, settings = real
    session.instrument_type = 'options'
    session.symbol = 'NIFTY'
    session.expiry = '2026-10-06'
    session.strike_ce = session.strike_pe = 24000
    session.last_price_ce = 100
    session.desktop_contract_quotes = {'NIFTY:2026-10-06:24100:CE': {'price': 200, 'timestamp': int(session.current_time), 'source': 'contract_quote'}}
    settings['target_deviation_pct'] = .02
    order = await orders.place_order(PlaceOrderRequest(session_id=session.session_id, side='BUY', order_type='LIMIT',
        limit_price=101, quantity=65, right='CE', strike=24100, expiry=session.expiry, market_order=True, execute_immediately=True))
    assert order.limit_price == 204 and order.quote_price == 200
    assert broker.place_options_limit_order.call_args.kwargs['strike'] == 24100
    assert broker.place_options_limit_order.call_args.kwargs['price'] == 204


def test_order_database_write_retains_effective_gap(real, monkeypatch):
    session, _, _ = real
    order = create(session)
    resource = MagicMock()
    monkeypatch.setattr('app.services.db.get_dynamodb_resource', lambda: resource)
    WRITE_ORDER(order, strict=True)
    item = resource.Table.return_value.put_item.call_args.kwargs['Item']
    assert item['execution_gap_pct'] == Decimal('.015') and item['limit_price'] == Decimal('98.5')
