"""Lot-aware order splits: transfer reservations, preserve intent, confirm broker edits."""
import asyncio
import json
import math
import uuid
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException
from app.config import LOT_SIZES
from app.models.schemas import OrderStatus, OrderType, TradeSide
from app.services import order_service

ACTIVE = {'prepared', 'modifying', 'submitting', 'unknown'}
CONFIRM_SECONDS = 5


def lot_size(session, order):
    if not order.right:
        return 1
    captured = (order.analytics or {}).get('lot_size')
    return max(1, int(captured or getattr(session, 'lot_size', 0) or LOT_SIZES.get(order.symbol, 1)))


def quantities(quantity, lot):
    if quantity < 2 * lot:
        return None
    if quantity % lot:
        raise HTTPException(409, f'Remaining quantity must be a multiple of lot size {lot}')
    lots = quantity // lot
    return ((lots + 1) // 2 * lot, lots // 2 * lot)


def _commit_pair(session, original, first, second):
    """Persist both orders atomically; never debit the wallet a second time."""
    from app.services.db import get_dynamodb_client
    from boto3.dynamodb.types import TypeSerializer
    items = [order_service._order_db_item(o) for o in (first, second)]
    if original.source == 'desktop_paper' and (original.wallet_ledger_id or '').startswith('paper:'):
        from app.services import paper_wallet
        date = original.wallet_ledger_id.removeprefix('paper:')
        context = paper_wallet.desktop_write_context(session.session_id, original.user_id, date, original.symbol)
        if context is None:
            raise HTTPException(409, 'Paper ownership changed; refresh before splitting')
        token, stopped = context
        paper_wallet.fenced_put_many('Orders', items, user_id=original.user_id, date=date,
            symbol=original.symbol, session_id=session.session_id, token=token, stopped=stopped)
        return
    serializer = TypeSerializer()
    encode = lambda row: {k: serializer.serialize(v) for k, v in row.items()}
    parent = {'TableName': 'Orders', 'Item': encode(items[0]),
        'ConditionExpression': '#status = :pending AND quantity = :quantity',
        'ExpressionAttributeNames': {'#status': 'status'},
        'ExpressionAttributeValues': encode({':pending': 'PENDING', ':quantity': original.quantity})}
    if session.session_type == 'real' and original.kotak_order_id:
        # Fill callbacks may persist the confirmed reduced quantity during I/O.
        # The durable operation barrier, rather than an old quantity, fences this write.
        parent.update(ConditionExpression='#split.#operation = :operation',
            ExpressionAttributeNames={'#split': 'split_operation', '#operation': 'operation_id'},
            ExpressionAttributeValues=encode({':operation': first.split_operation['operation_id']}))
    get_dynamodb_client().transact_write_items(TransactItems=[
        {'Put': parent},
        {'Put': {'TableName': 'Orders', 'Item': encode(items[1]),
            'ConditionExpression': 'attribute_not_exists(order_id)'}},
    ])


def _publish(session, orders):
    for order in orders:
        session.queue.put_nowait(json.dumps({**order.model_dump(mode='json'), 'type': 'order_updated',
            'session_id': session.session_id}))


async def _confirmed(broker, candidate, broker_id):
    """An SDK acknowledgement alone is insufficient to authorize a second order."""
    from app.services.broker_reports import normalize_order
    deadline = asyncio.get_running_loop().time() + CONFIRM_SECONDS
    while True:
        rows = await asyncio.to_thread(broker.get_order_history)
        for raw in rows:
            row = normalize_order(raw)
            if row['kotak_order_id'] != broker_id:
                continue
            if (row['quantity'] == candidate.quantity and row['status'] in
                    ('open', 'trigger pending', 'modified', 'complete', 'filled', 'partially filled', 'partial fill')
                    and math.isclose(row['limit_price'], candidate.limit_price, abs_tol=.001)
                    and row['order_type'] == ('SL' if candidate.order_type == OrderType.STOPLOSS else 'LIMIT')
                    and math.isclose(row['trigger_price'], candidate.trigger_price if candidate.order_type == OrderType.STOPLOSS else 0, abs_tol=.001)):
                return row
        if asyncio.get_running_loop().time() >= deadline:
            raise TimeoutError('Broker split is unconfirmed; refresh broker orders before taking further action')
        await asyncio.sleep(.2)


async def split(session, order, operation_id):
    from app.services.broker_order_service import persist_order_async, sync_order_edit_async, register_callbacks
    existing_job = order.split_operation or {}
    if existing_job.get('operation_id') == operation_id and existing_job.get('state') == 'confirmed':
        child = order_service.get_order(session.session_id, existing_job['child_id'])
        if child is None:
            raise HTTPException(409, 'Split child is missing; refresh orders')
        return [order, child]
    if existing_job.get('state') in ACTIVE:
        raise HTTPException(409, existing_job.get('message') or 'Split is unconfirmed; refresh broker orders')
    child_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'{session.session_id}/{order.order_id}/{operation_id}'))
    previous_child = order_service.get_order(session.session_id, child_id)
    if previous_child is not None:
        if (previous_child.split_operation or {}).get('state') in ACTIVE:
            raise HTTPException(409, 'Split child is unconfirmed; refresh broker orders')
        # Receipts remain idempotent even after either sibling was split again.
        return [order, previous_child]
    if order.status != OrderStatus.PENDING:
        raise HTTPException(409, 'Only pending orders can be split')
    parts = quantities(order.quantity - order.broker_filled_quantity, lot_size(session, order))
    if parts is None:
        return [order]
    keep, moved = parts
    first = order.model_copy(deep=True)
    second = order.model_copy(deep=True)
    second.order_id = child_id
    first.quantity = order.broker_filled_quantity + keep
    second.quantity = moved
    # Allocation links follow both siblings, while exclusions belong to the
    # durable manual-intent journal rather than being duplicated by a split.
    second.protection_suppressed_quantity = 0
    if order.protection_allocations:
        retained, transferred, room = {}, {}, keep
        for name, size in order.protection_allocations.items():
            amount = min(room, size)
            retained[name] = amount
            transferred[name] = size - amount
            room -= amount
        first.protection_allocations = {k: v for k, v in retained.items() if v}
        second.protection_allocations = {k: v for k, v in transferred.items() if v}
    second.kotak_order_id = None
    second.broker_filled_quantity = 0
    second.broker_filled_value = 0
    second.kotak_fill_confirmed = False
    second.filled_at = second.filled_price = None
    second.broker_conversion = None
    second.recovery_operation_id = second.recovery_parent_order_id = second.recovery_state = None
    second.recovery_attempt = 0
    second.reservation_revision = 0
    transferred = (Decimal(str(order.reserved_amount)) * Decimal(moved) /
        Decimal(order.quantity - order.broker_filled_quantity)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
    second.reserved_amount = float(transferred)
    first.reserved_amount = float(Decimal(str(order.reserved_amount)) - transferred)
    job = {'operation_id': operation_id, 'child_id': second.order_id, 'parent_id': order.order_id,
        'state': 'prepared'}
    original_job = order.split_operation
    original_snapshot = order.model_copy(deep=True)
    order.split_operation = dict(job)
    broker = None
    remote_started = False
    try:
        if session.session_type == 'real' and order.kotak_order_id:
            if getattr(session, 'broker_refresh_events', None) is not None:
                raise HTTPException(409, 'Broker refresh is in progress; retry split shortly')
            session.order_split_in_progress = operation_id
            from app.services.kotak_service import get_service
            from app.services.real_trading_day import require_entry_allowed
            if order.order_type not in (OrderType.LIMIT, OrderType.STOPLOSS):
                raise HTTPException(409, 'This broker order type cannot be split')
            if order.broker_product not in (None, 'MIS'):
                raise HTTPException(409, 'Only intraday broker orders can be split')
            require_entry_allowed(session, second.side, second.quantity, second.right, second.strike, second.expiry)
            broker = get_service()
            broker_generation = getattr(broker, '_generation', None)
            job.update(original_quantity=order.quantity, retained_quantity=first.quantity, child_quantity=moved,
                original_broker_id=order.kotak_order_id, tag='split' + second.order_id.replace('-', '')[:15])
            job['state'] = 'modifying'
            order.split_operation = dict(job)
            # Durable barrier before any remote mutation; callback fills remain authoritative.
            await persist_order_async(order, strict=True)
            remote_started = True
            await sync_order_edit_async(session, first, first.order_type, split_operation_id=operation_id)
            await _confirmed(broker, first, first.kotak_order_id)
            if order.broker_filled_quantity > first.quantity:
                raise RuntimeError('Order filled before quantity reduction was confirmed; refresh required')
            if order_service.get_order(session.session_id, order.order_id) is not order or getattr(session, 'broker_refresh_events', None) is not None:
                raise RuntimeError('Broker state changed during split; refresh required')
            if getattr(broker, '_generation', None) != broker_generation or order.status == OrderStatus.CANCELLED:
                raise RuntimeError('Broker connection or order changed during split; refresh required')
            # Fills during the edit reduce the outstanding reservation. Transfer
            # only the remaining reservation, with no new wallet movement.
            transferred = (Decimal(str(order.reserved_amount)) * Decimal(moved) /
                Decimal(order.quantity - order.broker_filled_quantity)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
            second.reserved_amount = float(transferred)
            first.reserved_amount = float(Decimal(str(order.reserved_amount)) - transferred)
            first.reservation_revision = order.reservation_revision
            first.broker_filled_quantity = order.broker_filled_quantity
            first.broker_filled_value = order.broker_filled_value
            first.filled_at, first.filled_price = order.filled_at, order.filled_price
            first.kotak_fill_confirmed = order.kotak_fill_confirmed
            first.status = OrderStatus.FILLED if first.broker_filled_quantity == first.quantity else OrderStatus.PENDING
            job['state'] = 'submitting'
        if not broker:
            job["state"] = "confirmed"
        first.split_operation = second.split_operation = dict(job)
        if broker:
            # Publish the reduced quantity before yielding; callbacks then book
            # fills against the retained quantity without losing their mutations.
            for name, value in first.model_dump().items():
                setattr(order, name, value)
            order_service._orders[session.session_id][second.order_id] = second
        await asyncio.to_thread(_commit_pair, session, original_snapshot, first, second)
        if not broker:
            for name, value in first.model_dump().items():
                setattr(order, name, value)
            order_service._orders[session.session_id][second.order_id] = second
        if broker:
            await persist_order_async(order, strict=True)
            from app.services import simulation
            if session.state == simulation.SimulationState.ENDED or simulation.get_session(session.session_id) is not session:
                raise RuntimeError('Session stopped during split; the second order was not submitted')
            if second.status != OrderStatus.PENDING or order.status == OrderStatus.CANCELLED:
                raise RuntimeError('Order changed before child submission; refresh required')
            if getattr(session, 'broker_refresh_events', None) is not None or getattr(broker, '_generation', None) != broker_generation:
                raise RuntimeError('Broker state changed before child submission; refresh required')
            kwargs = dict(symbol=order.symbol, side='B' if order.side == TradeSide.BUY else 'S',
                qty=second.quantity, tag=job['tag'])
            if order.right:
                kwargs.update(right=order.right, strike=order.strike, expiry=order.expiry)
            if order.order_type == OrderType.LIMIT:
                method = broker.place_options_limit_order if order.right else broker.place_limit_order
                kwargs['price'] = order.limit_price
            else:
                method = broker.place_options_sl_order if order.right else broker.place_sl_order
                kwargs.update(trigger_price=order.trigger_price, limit_price=order.limit_price)
            second.kotak_order_id = await asyncio.to_thread(method, **kwargs)
            session.kotak_order_map[second.order_id] = second.kotak_order_id
            register_callbacks(session, second, broker, asyncio.get_running_loop())
            await persist_order_async(second, strict=True)
            await _confirmed(broker, second, second.kotak_order_id)
        job['state'] = 'confirmed'
        order.split_operation = second.split_operation = dict(job)
        if broker:
            await persist_order_async(order, strict=True)
            await persist_order_async(second, strict=True)
        _publish(session, [order, second])
        return [order, second]
    except BaseException as exc:
        if remote_started:
            job.update(state='unknown', message=str(exc))
            order.split_operation = dict(job)
            child = order_service.get_order(session.session_id, second.order_id)
            if child:
                child.split_operation = dict(job)
                await persist_order_async(child, strict=True)
            await persist_order_async(order, strict=True)
            _publish(session, [order])
        else:
            order.split_operation = original_job
        if isinstance(exc, asyncio.CancelledError):
            raise
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(502 if remote_started else 503, str(exc) or 'Split could not be saved') from exc
    finally:
        if getattr(session, 'order_split_in_progress', None) == operation_id:
            session.order_split_in_progress = None


def reconcile_projection(orders, broker_orders):
    """Clear uncertain split barriers only from a complete broker refresh.

    Never submit or resubmit a broker order during reconciliation.
    """
    reported = {row['kotak_order_id']: row for row in broker_orders}
    for order in orders.values():
        job = order.split_operation or {}
        if job.get('parent_id') != order.order_id or job.get('state') != 'unknown':
            continue
        parent_row = reported.get(order.kotak_order_id)
        child = orders.get(job.get('child_id'))
        child_row = reported.get(child.kotak_order_id) if child else None
        state, message = None, None
        if parent_row and child_row and order.quantity == job.get('retained_quantity') and child.quantity == job.get('child_quantity'):
            if child.status == OrderStatus.CANCELLED or order.status == OrderStatus.CANCELLED:
                state, message = 'failed', 'Broker cancelled or rejected part of the split; review remaining orders'
            else:
                state, message = 'confirmed', 'Both split orders confirmed by broker refresh'
        elif parent_row and child is None:
            # Failure before creating/submitting the child: a complete report
            # authoritatively restores the retained order, with no blind retry.
            state = 'failed'
            message = ('Split was not applied' if order.quantity == job.get('original_quantity') else
                'Broker reduced the original quantity; the second order was not submitted. Review remaining quantity')
        if state:
            job = {**job, 'state': state, 'message': message}
            order.split_operation = job
            if child:
                child.split_operation = dict(job)
