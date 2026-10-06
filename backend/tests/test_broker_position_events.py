"""Position-only fills and duplicate order/position delivery use one execution history."""
import asyncio
import json
import logging
from unittest.mock import MagicMock
import pytest
from app.services import broker_position_events as positions, real_broker_state as state, trading, kotak_service
from app.services.kotak_cancel_audit import record_event
from tests.test_phase19_broker_snapshot import env, execution, reported_position


def position_row():
    return dict(sym='SENSEX26O0171100PE', exSeg='bse_fo', prod='MIS', flBuyQty='20', flSellQty='0',
                buyAmt='800', sellAmt='0', posFlg='Y', sqrFlg='Y')


async def drain(session):
    task = positions._tasks.get(session.session_id)
    if task:
        await task
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_position_only_fill_reconciles_confirmed_executions_once(env, monkeypatch):
    session, broker, _ = env
    monkeypatch.setattr(positions, 'DEBOUNCE', .005)
    session.strike_pe = 71100
    broker.get_trade_history.return_value = [execution('1', 'entry', qty=20, price=40)]
    broker.get_positions.return_value = [reported_position(20, 40)]
    positions.on_position(session, broker, position_row())
    positions.on_position(session, broker, position_row())
    await drain(session)
    assert broker.get_trade_history.call_count == 1
    assert len(trading.get_trades(session.session_id)) == 1
    assert session.broker_positions[0]['quantity'] == 20
    assert session.broker_positions[0]['avg_entry_price'] == 40
    positions.on_position(session, broker, position_row())
    await drain(session)
    assert broker.get_trade_history.call_count == 1
    assert len(trading.get_trades(session.session_id)) == 1


@pytest.mark.asyncio
async def test_position_after_committed_order_does_not_poll_or_duplicate_fill(env, monkeypatch):
    session, broker, _ = env
    monkeypatch.setattr(positions, 'DEBOUNCE', .005)
    broker.get_trade_history.return_value = [execution('1', 'entry', qty=20, price=40)]
    broker.get_positions.return_value = [reported_position(20, 40)]
    await state.refresh(session, broker)
    count = broker.get_trade_history.call_count
    positions.on_position(session, broker, position_row())
    await drain(session)
    assert broker.get_trade_history.call_count == count
    assert len(trading.get_trades(session.session_id)) == 1
    assert session.broker_positions[0]['quantity'] == 20


@pytest.mark.asyncio
async def test_position_failure_preserves_verified_fifo_and_can_retry(env, monkeypatch):
    session, broker, _ = env
    monkeypatch.setattr(positions, 'DEBOUNCE', .005)
    broker.get_trade_history.return_value = [execution('1', 'entry', qty=20, price=40)]
    broker.get_positions.return_value = [reported_position(20, 40)]
    await state.refresh(session, broker)
    original = [dict(row) for row in session.broker_positions]
    broker.get_trade_history.side_effect = RuntimeError('unavailable')
    changed = dict(position_row(), flBuyQty='40', buyAmt='1600')
    positions.on_position(session, broker, changed)
    await drain(session)
    assert session.broker_positions == original
    count = broker.get_trade_history.call_count
    positions.on_position(session, broker, changed)
    await drain(session)
    assert broker.get_trade_history.call_count > count
    assert len(trading.get_trades(session.session_id)) == 1


@pytest.mark.asyncio
async def test_other_contract_and_invalid_position_messages_do_not_mutate(env, monkeypatch):
    session, broker, _ = env
    monkeypatch.setattr(positions, 'DEBOUNCE', .005)
    positions.on_position(session, broker, dict(position_row(), sym='NIFTY26O0825000CE'))
    positions.on_position(session, broker, dict(position_row(), flBuyQty='NaN'))
    await drain(session)
    broker.get_trade_history.assert_not_called()
    assert trading.get_trades(session.session_id) == []


@pytest.mark.asyncio
async def test_service_handles_position_and_preserves_order_observers(env, caplog):
    session, broker, _ = env
    service = kotak_service.KotakNeoService()
    observed = []
    service.register_position_observer('position', observed.append, asyncio.get_running_loop())
    raw = {'type': 'position', 'data': {**position_row(), 'token': 'secret'}}
    with caplog.at_level(logging.DEBUG):
        service._on_message(raw)
        record_event(raw)
    await asyncio.sleep(0)
    assert len(observed) == 1 and observed[0]['flBuyQty'] == '20'
    assert len(service._position_events) == 1
    assert 'ignoring unknown message type=position' not in caplog.text
    records = [json.loads(record.message) for record in caplog.records if record.name == 'kotak.events']
    assert records[0]['payload']['data']['token'] == '[REDACTED]'
    assert records[0]['payload']['data']['flBuyQty'] == '20'
    service.shutdown()
    assert service._position_events == {}


@pytest.mark.asyncio
@pytest.mark.parametrize('position_first', [False, True])
async def test_limit_fill_and_position_event_in_either_order_count_once(env, monkeypatch, position_first):
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import broker_order_service, order_service
    session, broker, _ = env
    monkeypatch.setattr(positions, 'DEBOUNCE', .005)
    order = Order(session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
        side=TradeSide.BUY, order_type=OrderType.LIMIT, quantity=20, trigger_price=40, limit_price=40,
        created_at=10, right='PE', strike=71100, expiry=session.expiry, kotak_order_id='entry', execution_role='entry')
    order_service._orders[session.session_id][order.order_id] = order
    broker_order_service.register_callbacks(session, order, broker, asyncio.get_running_loop())
    callback = broker.register_fill_callback.call_args.args[1]
    if position_first:
        positions.on_position(session, broker, position_row())
    callback('entry', 'BUY', 20, 40)
    callback('entry', 'BUY', 20, 40)
    if not position_first:
        positions.on_position(session, broker, position_row())
    await drain(session)
    assert len(trading.get_trades(session.session_id)) == 1
    assert trading.get_trades(session.session_id)[0].quantity == 20
    assert session.broker_positions[0]['quantity'] == 20
    broker.get_trade_history.assert_not_called()


def test_conversion_metadata_survives_dynamodb_order_restore(env):
    from decimal import Decimal
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services import order_service
    session, broker, tables = env
    order = Order(session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
        side=TradeSide.SELL, order_type=OrderType.LIMIT, quantity=20, trigger_price=40, limit_price=40,
        created_at=10, right='PE', strike=71100, expiry=session.expiry, kotak_order_id='entry',
        broker_conversion={'operation_id':'conversion:test','state':'unknown','requested_type':'STOPLOSS','updated_at':12.25})
    order_service._write_order_to_db(order, strict=True)
    stored = list(tables['Orders'].items.values())[0]
    assert stored['broker_conversion']['updated_at'] == Decimal('12.25')
    state.restore_orders(session)
    restored = order_service.get_order(session.session_id, order.order_id)
    assert restored.broker_conversion['state'] == 'unknown'
    assert isinstance(restored.model_dump(mode='json')['broker_conversion']['updated_at'], float)
