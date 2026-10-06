"""Regression: acknowledged edits must never masquerade as broker-confirmed exits."""
import asyncio
import json
import time
from unittest.mock import AsyncMock
import pytest
import pytest_asyncio
from fastapi import HTTPException
from app.models.schemas import OrderType, OrderStatus, ConvertOrderRequest, BulkConvertRequest
from app.services import broker_conversion as conversion, order_service, protection_recovery as recovery, kotak_service
from app.routers import orders
from tests.test_phase19_real_exit_orders import env as exit_env, local


@pytest_asyncio.fixture
async def env(exit_env, monkeypatch):
    session, broker, position = exit_env
    session.symbol = 'RELIND'
    observers = {}
    def observe(token, callback, loop):
        observers[token] = (callback, loop)
    broker.register_order_observer.side_effect = observe
    broker.deregister_order_observer.side_effect = lambda token: observers.pop(token, None)
    monkeypatch.setattr(conversion, 'REQUEST_WAIT', .03)
    monkeypatch.setattr(conversion, 'CONFIRM_WAIT', .2)
    monkeypatch.setattr(recovery, 'obtain_quote', AsyncMock(return_value=100))
    def emit(raw):
        for callback, loop in list(observers.values()):
            loop.call_soon_threadsafe(callback, raw)
    broker.emit = emit
    yield session, broker, position
    tasks = list(conversion._tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def tracked(session, kind):
    order = local(session, kind)
    order.kotak_order_id = 'old'
    order.execution_role = 'exit'
    session.kotak_order_map[order.order_id] = 'old'
    return order


def update(identifier='old', kind='SL', trigger=90, price=88.65, qty=1, status='modified', **extra):
    return dict(nOrdNo=identifier, prcTp=kind, trgPrc=trigger, prc=price, qty=qty, ordSt=status, **extra)


async def finish(order):
    task = conversion._tasks.get(order.broker_conversion['operation_id'])
    if task:
        await task


@pytest.mark.asyncio
@pytest.mark.parametrize('new_type', [OrderType.LIMIT, OrderType.STOPLOSS])
async def test_ack_only_retains_original_then_event_confirms(env, new_type):
    session, broker, _ = env
    old_type = OrderType.STOPLOSS if new_type == OrderType.LIMIT else OrderType.LIMIT
    order = tracked(session, old_type)
    broker.modify_sl_order.return_value = broker.modify_sl_to_limit_order.return_value = 'old'
    result = await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=new_type, price=90))
    assert result.order_type == old_type
    assert result.broker_conversion['state'] == 'modifying'
    with pytest.raises(HTTPException) as conflict:
        await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=new_type, price=90))
    assert conflict.value.status_code == 409
    broker.emit(update(kind='L' if new_type == OrderType.LIMIT else 'SL', trigger=0 if new_type == OrderType.LIMIT else 90,
                       price=90 if new_type == OrderType.LIMIT else 88.65))
    await finish(order)
    assert order.order_type == new_type
    assert order.broker_conversion['state'] == 'confirmed'
    broker.cancel_order.assert_not_called()


@pytest.mark.asyncio
async def test_timeout_and_incomplete_or_pending_events_do_not_fake_conversion(env):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    broker.modify_sl_order.return_value = 'old'
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    broker.emit(update(status='modify pending'))
    broker.emit(dict(nOrdNo='old', ordSt='modified', prcTp='SL', qty=1))
    broker.emit(update(trigger=91))
    await finish(order)
    assert order.order_type == OrderType.LIMIT
    assert order.broker_conversion['state'] == 'unknown'
    broker.cancel_order.assert_not_called()
    assert order.limit_price == 110  # Original broker-confirmed limit price is retained.


@pytest.mark.asyncio
@pytest.mark.parametrize('new_type', [OrderType.LIMIT, OrderType.STOPLOSS])
async def test_explicit_refusal_waits_for_cancellation_then_replaces(env, monkeypatch, new_type):
    session, broker, _ = env
    old_type = OrderType.STOPLOSS if new_type == OrderType.LIMIT else OrderType.LIMIT
    order = tracked(session, old_type)
    original = dict(kotak_order_id='old', order_type='SL' if old_type == OrderType.STOPLOSS else 'LIMIT',
                    status='open', product='MIS', symbol='RELIANCE-EQ', exchange='nse_cm', side='SELL',
                    quantity=1, filled_quantity=0, side_known=True)
    broker.get_order_history.return_value = [original]
    monkeypatch.setattr(recovery, 'reports_for', AsyncMock(return_value=([dict(original, status='cancelled')], 1, 'LONG', 0)))
    method = broker.modify_sl_order if new_type == OrderType.STOPLOSS else broker.modify_sl_to_limit_order
    method.side_effect = kotak_service.KotakOrderRejected('type change refused')
    def cancel(identifier, **kwargs):
        assert broker.place_limit_order.call_count == broker.place_sl_order.call_count == 0
        broker.emit(update(status='cancelled'))
    broker.cancel_order.side_effect = cancel
    def place(**kwargs):
        broker.emit(update(identifier='new', kind='L' if new_type == OrderType.LIMIT else 'SL',
                          trigger=0 if new_type == OrderType.LIMIT else 90,
                          price=90 if new_type == OrderType.LIMIT else 88.65, GuiOrdId=kwargs['tag']))
        return 'new'
    broker.place_limit_order.side_effect = broker.place_sl_order.side_effect = place
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=new_type, price=90))
    await finish(order)
    assert order.status == OrderStatus.CANCELLED
    children = [o for o in order_service.get_open_orders(session.session_id) if o.kotak_order_id == 'new']
    assert len(children) == 1 and children[0].order_type == new_type
    assert children[0].broker_filled_quantity == 0
    assert order.broker_conversion['state'] == 'confirmed'
    assert broker.cancel_order.call_args.kwargs['purpose'] == 'conversion'


@pytest.mark.asyncio
async def test_bulk_reports_pending_without_counting_acknowledgements(env):
    session, broker, _ = env
    first = tracked(session, OrderType.LIMIT)
    second = tracked(session, OrderType.LIMIT)
    second.kotak_order_id = 'second'
    broker.modify_sl_order.return_value = 'old'
    result = await orders.bulk_convert_route(BulkConvertRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    assert result['converted'] == 0
    assert len(result['results']) == 2
    assert first.order_type == second.order_type == OrderType.LIMIT


@pytest.mark.asyncio
async def test_refresh_resolves_late_confirmation_without_resubmission(env, isolated_protection_journal):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    broker.modify_sl_order.return_value = 'old'
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    await finish(order)
    # Refresh has already applied authoritative row fields, as build_orders does.
    order.order_type = OrderType.STOPLOSS
    from app.services.broker_reports import normalize_order
    await conversion.reconcile_refresh(session, [normalize_order(update(status='trigger pending'))])
    assert order.broker_conversion['state'] == 'confirmed'
    broker.modify_sl_order.assert_called_once()
    broker.place_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_cancel_refusal_keeps_original_and_never_places_replacement(env):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    broker.modify_sl_order.side_effect = kotak_service.KotakOrderRejected('conversion refused')
    broker.get_order_history.return_value = [dict(kotak_order_id='old', order_type='LIMIT', status='open', product='MIS')]
    broker.cancel_order.side_effect = kotak_service.KotakOrderRejected('cancel refused')
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    await finish(order)
    assert order.status == OrderStatus.PENDING and order.order_type == OrderType.LIMIT
    assert order.broker_conversion['state'] == 'failed'
    broker.place_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_partial_fill_during_conversion_is_preserved(env):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    order.quantity = 3
    broker.modify_sl_order.return_value = 'old'
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    order.broker_filled_quantity = 1
    order.broker_filled_value = 95
    broker.emit(update(qty=3))
    await finish(order)
    assert order.order_type == OrderType.STOPLOSS
    assert order.broker_filled_quantity == 1 and order.broker_filled_value == 95


@pytest.mark.asyncio
async def test_terminal_fill_during_conversion_cannot_be_reopened(env):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    broker.modify_sl_order.return_value = 'old'
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    order.status = OrderStatus.FILLED
    order.kotak_fill_confirmed = True
    broker.emit(update(status='complete'))
    await finish(order)
    assert order.status == OrderStatus.FILLED
    broker.place_sl_order.assert_not_called()


@pytest.mark.asyncio
async def test_uncertain_replacement_submission_is_not_retried(env, monkeypatch):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    row = dict(kotak_order_id='old', order_type='LIMIT', status='open', product='MIS', symbol='RELIANCE-EQ',
               exchange='nse_cm', side='SELL', quantity=1, filled_quantity=0, side_known=True)
    broker.get_order_history.return_value = [row]
    monkeypatch.setattr(recovery, 'reports_for', AsyncMock(return_value=([dict(row, status='cancelled')], 1, 'LONG', 0)))
    broker.modify_sl_order.side_effect = kotak_service.KotakOrderRejected('refused')
    broker.cancel_order.side_effect = lambda identifier, **kw: broker.emit(update(status='cancelled'))
    broker.place_sl_order.side_effect = kotak_service.KotakError('transport timeout')
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    await finish(order)
    assert order.status == OrderStatus.CANCELLED
    assert order.broker_conversion['state'] == 'unknown'
    assert 'protection is unconfirmed' in order.broker_conversion['message']
    broker.place_sl_order.assert_called_once()
    await conversion.reconcile_refresh(session, [dict(row, status='cancelled')])
    broker.place_sl_order.assert_called_once()
    assert order.broker_conversion['state'] == 'unknown'  # No tag match is not proof of failure.


@pytest.mark.asyncio
async def test_crossed_stop_keeps_limit_and_places_nothing(env, monkeypatch):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    monkeypatch.setattr(recovery, 'obtain_quote', AsyncMock(return_value=85))
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    await finish(order)
    assert order.broker_conversion['state'] == 'failed' and order.order_type == OrderType.LIMIT
    broker.modify_sl_order.assert_not_called()
    broker.cancel_order.assert_not_called()


@pytest.mark.asyncio
async def test_all_limit_mixed_success_keeps_unconfirmed_stoploss(env):
    session, broker, _ = env
    first = tracked(session, OrderType.STOPLOSS)
    second = tracked(session, OrderType.STOPLOSS)
    second.kotak_order_id = 'second'
    def modify(identifier, price, quantity):
        if identifier == 'old':
            broker.emit(update(kind='L', trigger=0, price=90))
        return identifier
    broker.modify_sl_to_limit_order.side_effect = modify
    result = await orders.bulk_convert_route(BulkConvertRequest(session_id=session.session_id, new_order_type=OrderType.LIMIT, price=90))
    assert result['converted'] == 1
    assert first.order_type == OrderType.LIMIT and second.order_type == OrderType.STOPLOSS
    assert result['results'][1]['state'] == 'modifying'


@pytest.mark.asyncio
async def test_real_service_observer_receives_modification_and_is_removed(env):
    session, broker, _ = env
    service = kotak_service.KotakNeoService()
    observed = []
    service.register_order_observer('op', observed.append, asyncio.get_running_loop())
    service._on_message({'type':'order', 'data':update()})
    await asyncio.sleep(0)
    assert observed[0]['prcTp'] == 'SL' and observed[0]['_received_at'] > 0
    service.deregister_order_observer('op')
    service._on_message({'type':'order', 'data':update(kind='L',trigger=0,price=90)})
    await asyncio.sleep(0)
    assert len(observed) == 1


@pytest.mark.asyncio
async def test_delayed_event_after_timeout_still_repairs_website_state(env):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    broker.modify_sl_order.return_value = 'old'
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    await finish(order)
    assert order.order_type == OrderType.LIMIT and order.broker_conversion['state'] == 'unknown'
    broker.emit(update())
    await asyncio.sleep(0)
    await finish(order)
    assert order.order_type == OrderType.STOPLOSS
    assert order.broker_conversion['state'] == 'confirmed'
    broker.modify_sl_order.assert_called_once()


@pytest.mark.asyncio
async def test_restored_unknown_operation_confirms_from_event_without_modifying(env, isolated_protection_journal):
    session, broker, _ = env
    order = tracked(session, OrderType.LIMIT)
    broker.modify_sl_order.return_value = 'old'
    await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=session.session_id, new_order_type=OrderType.STOPLOSS, price=90))
    await finish(order)
    operation = order.broker_conversion['operation_id']
    job = isolated_protection_journal.get(operation)
    broker.deregister_order_observer(operation)
    conversion.watch_restored(session, order, job, broker)
    broker.emit(update())
    await asyncio.sleep(0)
    await finish(order)
    assert order.order_type == OrderType.STOPLOSS
    broker.modify_sl_order.assert_called_once()  # Only the original pre-restart request.
    broker.place_sl_order.assert_not_called()
