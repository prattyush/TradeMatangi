"""Broker-confirmed exit type changes. An acknowledgement is never confirmation."""
import asyncio
import json
import logging
import math
import time
import uuid

from app.models.schemas import OrderType, OrderStatus, TradeSide
from app.services import order_service, broker_reports as reports, protection_journal as journal

logger = logging.getLogger(__name__)
REQUEST_WAIT = 5
CONFIRM_WAIT = 30
ACTIVE = {'queued', 'modifying', 'cancelling', 'replacing', 'unknown'}
_tasks = {}
_queued_tasks = {}


def busy(order):
    return bool(order.broker_conversion and order.broker_conversion.get('state') in ACTIVE)


def _current(session, order):
    return order_service.get_order(session.session_id, order.order_id)


async def publish(session, order, job, state, message=None):
    job.update(state=state, message=message, updated_at=time.time())
    # Journal first: if persistence fails, no further mutation may be submitted.
    await asyncio.to_thread(journal.store.put, job['operation_id'], job)
    current = _current(session, order)
    if current is not None and current is not order:
        if (current.broker_conversion or {}).get('operation_id') != job['operation_id']:
            return
        order = current  # A coherent refresh may replace the cached model during I/O.
    order.broker_conversion = {key: job.get(key) for key in ('operation_id', 'state', 'requested_type', 'message', 'updated_at')}
    from app.services.broker_order_service import persist_order_async
    await persist_order_async(order, strict=True)
    session.queue.put_nowait(json.dumps({'type': 'order_updated', 'order_id': order.order_id,
                                        'session_id': session.session_id, 'broker_conversion': order.broker_conversion}))
    session.queue.put_nowait(json.dumps({'type': 'broker_conversion_status', 'session_id': session.session_id,
        'operation_id': job['operation_id'], 'state': state, 'message': message,
        'original_cancelled': bool(job.get('original_cancelled'))}))
    logger.info('broker_conversion session=%s order=%s operation=%s state=%s message=%s',
                session.session_id, order.order_id, job['operation_id'], state, message)


def _matches(raw, candidate, broker_id):
    # Do not infer missing price/type/quantity fields from defaults.
    if not any(raw.get(key) is not None for key in ('prcTp', 'pt', 'order_type')) or not any(raw.get(key) is not None for key in ('qty', 'qt', 'quantity')):
        return False
    if not any(raw.get(key) is not None for key in ('prc', 'pr', 'limit_price')) or not any(raw.get(key) is not None for key in ('trgPrc', 'tp', 'trigger_price')):
        return False
    row = reports.normalize_order(raw)
    kind = 'SL' if candidate.order_type == OrderType.STOPLOSS else 'LIMIT'
    trigger = candidate.trigger_price if kind == 'SL' else 0
    return (row['kotak_order_id'] == broker_id and row['order_type'] == kind
            and row['status'] in ('open', 'trigger pending', 'modified', 'complete', 'filled', 'partially filled', 'partial fill')
            and row['quantity'] == candidate.quantity
            and math.isclose(row['trigger_price'], trigger, abs_tol=.001)
            and math.isclose(row['limit_price'], candidate.limit_price, abs_tol=.001))


async def event_until(queue, predicate, seconds=None):
    seconds = CONFIRM_WAIT if seconds is None else seconds
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            raise TimeoutError('Broker order confirmation has not arrived')
        raw = await asyncio.wait_for(queue.get(), remaining)
        if predicate(raw):
            return raw


def candidate_for(order, new_type, price):
    from app.services.execution_price_service import reprice_trigger
    from app.services.kotak_service import _round_to_tick
    candidate = order.model_copy(deep=True)
    resolved = price if price is not None else (order.trigger_price if new_type == OrderType.LIMIT else order.limit_price)
    if not math.isfinite(resolved) or resolved <= 0:
        raise ValueError('Conversion price must be finite and positive')
    candidate.order_type = new_type
    candidate.is_stoploss = new_type == OrderType.STOPLOSS
    candidate.trigger_price = candidate.limit_price = _round_to_tick(resolved)
    reprice_trigger(candidate)
    from app.services.execution_analytics import applied_controller
    applied_controller(candidate)
    return candidate


async def validate_stop(session, candidate, operation):
    if candidate.order_type != OrderType.STOPLOSS:
        return
    from app.services.protection_recovery import obtain_quote
    price = await obtain_quote(session, candidate, operation)
    if (candidate.side == TradeSide.SELL and candidate.trigger_price >= price) or (candidate.side == TradeSide.BUY and candidate.trigger_price <= price):
        raise ValueError('Stoploss trigger is on the crossed side of the current exact-contract price')


async def start(session, order, new_type, price):
    from app.services.kotak_service import get_service, KotakError
    if busy(order) and order.broker_conversion.get('state') != 'queued':
        raise KotakError('Conversion is unconfirmed; refresh broker state before changing this order')
    if getattr(session, 'broker_refresh_events', None) is not None:
        raise KotakError('Broker refresh is in progress; retry conversion shortly')
    candidate = candidate_for(order, new_type, price)
    operation = 'conversion:' + str(uuid.uuid4())
    job = dict(operation_id=operation, session_id=session.session_id, order_id=order.order_id,
               requested_type=new_type.value, original=order.model_dump(mode='json'),
               candidate=candidate.model_dump(mode='json'), broker_id=order.kotak_order_id,
               requested_at=time.time(), state='modifying')
    broker = get_service()
    generation = getattr(broker, '_generation', None)
    job['broker_generation'] = generation if isinstance(generation, int) else None
    require_active(session, job, broker)
    queue = asyncio.Queue(maxsize=128)
    def observe(raw):
        # This callback runs on the application loop; retain early replacement events.
        if not job.get('submitted_at') or raw.get('_received_at', time.time()) < job['submitted_at']:
            return
        stamp = raw.get('updRecvTm')
        if stamp is not None:
            try:
                stamp = float(stamp)
                if stamp > 1e17:
                    stamp /= 1e9
                elif stamp > 1e14:
                    stamp /= 1e6
                elif stamp > 1e11:
                    stamp /= 1e3
                if stamp < job['submitted_at']:
                    return  # Delayed exchange updates from a previous edit are not confirmation.
            except (ValueError, TypeError):
                return
        identifier = str(raw.get('nOrdNo') or raw.get('kotak_order_id') or '')
        tag = str(raw.get('GuiOrdId') or raw.get('tag') or raw.get('ig') or '')
        if identifier not in (job['broker_id'], job.get('replacement_id')) and tag != job.get('tag'):
            return
        if job.get('state') == 'unknown':
            running = _tasks.get(operation)
            if running and not running.done() and not job.get('late_confirming'):
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(raw)
                return
            late_id = job.get('replacement_id') or job['broker_id']
            if job.get('replacement_submitted') and not job.get('replacement_id'):
                if tag != job.get('tag'):
                    return
                late_id = identifier
            if not job.get('late_confirming') and _matches(raw, candidate, late_id):
                job['late_confirming'] = True
                if job.get('replacement_submitted'):
                    job['replacement_id'] = late_id
                async def late_confirmation():
                    try:
                        await _commit(session, order, candidate, job, broker, raw)
                    except Exception:
                        logger.exception('broker_conversion_late_confirmation_failed operation=%s', operation)
                    finally:
                        broker.deregister_order_observer(operation)
                        _tasks.pop(operation, None)
                _tasks[operation] = asyncio.create_task(late_confirmation())
            return
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(raw)
    broker.register_order_observer(operation, observe, asyncio.get_running_loop())
    try:
        await publish(session, order, job, 'modifying', 'Waiting for Kotak to confirm conversion')
    except BaseException:
        broker.deregister_order_observer(operation)
        raise
    task = asyncio.create_task(run(session, order, candidate, job, broker, queue, observe))
    _tasks[operation] = task
    def done(finished):
        if _tasks.get(operation) is finished:
            _tasks.pop(operation, None)
        if not finished.cancelled() and finished.exception():
            logger.error('broker_conversion_worker_failed operation=%s', operation, exc_info=finished.exception())
    task.add_done_callback(done)
    return order


async def wait(order):
    task = _tasks.get((order.broker_conversion or {}).get('operation_id'))
    if task:
        await asyncio.wait({task}, timeout=REQUEST_WAIT)
    return order


def require_active(session, job, broker):
    from app.services.simulation import get_session
    if get_session(session.session_id) is not session:
        raise RuntimeError('Session ended during conversion; refresh required')
    if job.get('broker_generation') is not None and broker._generation != job['broker_generation']:
        raise RuntimeError('Broker connection changed during conversion; refresh required')


async def wait_event(job, queue, predicate):
    remaining = max(0, job['confirmation_deadline'] - asyncio.get_running_loop().time())
    return await event_until(queue, predicate, remaining)


async def _commit(session, order, candidate, job, broker, raw):
    from app.services.protection_recovery import session_lock
    from app.services.broker_order_service import register_callbacks
    async with session_lock(session):
        require_active(session, job, broker)
        current = _current(session, order)
        if current is None:
            job.update(state='unknown', message='Order changed during conversion; refresh required')
            await asyncio.to_thread(journal.store.put, job['operation_id'], job)
            return
        if (current.broker_conversion or {}).get('operation_id') != job['operation_id']:
            job.update(state='failed', message='Conversion superseded by a newer operation')
            await asyncio.to_thread(journal.store.put, job['operation_id'], job)
            return
        order = current
        if candidate.analytics and candidate.analytics.get('controller_history'):
            from copy import deepcopy
            candidate.analytics = deepcopy(candidate.analytics)
            candidate.analytics['controller_history'][-1]['timestamp'] = int(time.time()) + 19800
            candidate.analytics['timestamp'] = candidate.analytics['controller_history'][-1]['timestamp']
        replacement = job.get('replacement_id')
        if current.status != OrderStatus.PENDING and not (replacement and job.get('original_cancelled') and current.status == OrderStatus.CANCELLED):
            await publish(session, order, job, 'failed', 'Order became terminal during conversion')
            return
        if current.kotak_order_id != job['broker_id']:
            await publish(session, order, job, 'unknown', 'Broker identity changed; refresh required')
            return
        session._protection_revision = getattr(session, '_protection_revision', 0) + 1
        old_id = current.kotak_order_id
        replacement = job.get('replacement_id')
        if replacement:
            # Retain the original filled order history; create an independent replacement.
            current.status = OrderStatus.CANCELLED
            await publish(session, current, job, 'confirmed', 'Original exit cancelled; replacement confirmed')
            session.queue.put_nowait(json.dumps({'type': 'order_cancelled', 'order_id': current.order_id}))
            existing = next((item for item in order_service.get_all_orders(session.session_id)
                             if item.kotak_order_id == replacement), None)
            if existing:
                from app.services.broker_order_service import persist_order_async
                await persist_order_async(existing, strict=True)
                session.queue.put_nowait(json.dumps({'type': 'order_placed', **existing.model_dump(mode='json')}))
                return
            candidate.order_id = str(uuid.uuid4())
            candidate.kotak_order_id = replacement
            candidate.broker_filled_quantity = 0
            candidate.broker_filled_value = 0
            candidate.kotak_fill_confirmed = False
            candidate.status = OrderStatus.PENDING
            candidate.broker_conversion = None
            candidate.execution_role = 'exit'
            candidate.reserved_amount = 0
            order_service._orders[session.session_id][candidate.order_id] = candidate
            session.kotak_order_map.pop(current.order_id, None)
            session.kotak_order_map[candidate.order_id] = replacement
            for method in ('deregister_fill_callback', 'deregister_reject_callback', 'deregister_cancel_callback'):
                getattr(broker, method)(old_id)
            register_callbacks(session, candidate, broker, asyncio.get_running_loop())
            from app.services.broker_order_service import persist_order_async
            await persist_order_async(candidate, strict=True)
            session.queue.put_nowait(json.dumps({'type': 'order_placed', **candidate.model_dump(mode='json')}))
            return
        if current.quantity != candidate.quantity:
            await publish(session, order, job, 'unknown', 'Quantity changed during conversion; refresh required')
            return
        # The candidate was copied before I/O. Never overwrite newer cumulative fills.
        for key in ('order_type', 'is_stoploss', 'trigger_price', 'limit_price', 'execution_gap_pct', 'market_order', 'analytics'):
            setattr(current, key, getattr(candidate, key))
        await publish(session, current, job, 'confirmed')
        session.queue.put_nowait(json.dumps({'type': 'order_converted', 'session_id': session.session_id,
            'order_id': current.order_id, 'new_order_type': current.order_type.value,
            'trigger_price': current.trigger_price, 'limit_price': current.limit_price,
            'is_stoploss': current.is_stoploss, 'broker_conversion': current.broker_conversion}))


async def _fallback(session, order, candidate, job, broker, queue):
    from app.services.protection_recovery import session_lock, reports_for, coverage
    from app.services.kotak_service import KotakError
    rows = await asyncio.to_thread(broker.get_order_history)
    original = next((r for r in rows if r['kotak_order_id'] == job['broker_id']), None)
    expected = 'SL' if order.order_type == OrderType.STOPLOSS else 'LIMIT'
    if not original or original['order_type'] != expected or original['status'] not in ('open', 'trigger pending', 'partially filled', 'partial fill'):
        raise KotakError('Original exit is not confirmed open; replacement deferred')
    if original.get('product', 'MIS').upper() != 'MIS':
        raise ValueError('Replacement supports MIS exits only; original order retained')
    await validate_stop(session, candidate, job['operation_id'])
    async with session_lock(session):
        if _current(session, order) is not order or order.status != OrderStatus.PENDING:
            raise KotakError('Order filled or changed before cancellation')
        await publish(session, order, job, 'cancelling', 'Waiting for confirmed cancellation before replacement')
        if getattr(session, 'broker_refresh_events', None) is not None or order.status != OrderStatus.PENDING:
            raise RuntimeError('Broker state changed before cancellation; original exit retained')
        require_active(session, job, broker)
        await asyncio.to_thread(broker.cancel_order, job['broker_id'], purpose='conversion', context={'session_id': session.session_id, 'operation_id': job['operation_id']})
    await wait_event(job, queue, lambda raw: reports.normalize_order(raw)['kotak_order_id'] == job['broker_id']
                      and reports.normalize_order(raw)['status'] in ('cancelled', 'canceled'))
    if order.kotak_fill_confirmed:
        raise ValueError('Original exit filled during cancellation; no replacement submitted')
    job['original_cancelled'] = True
    order.status = OrderStatus.CANCELLED
    order.cancellation_status = 'cancelled'
    order.cancel_purpose = 'conversion'
    session.queue.put_nowait(json.dumps({'type': 'order_cancelled', 'order_id': order.order_id}))
    await publish(session, order, job, 'replacing', 'Original exit cancelled; replacement is not yet confirmed')
    async with session_lock(session):
        if order.kotak_fill_confirmed:
            raise KotakError('Original exit completed during cancellation; no replacement submitted')
        rows, quantity, side, version = await reports_for(session, order, broker)
        missing, _ = coverage(session, order, rows, quantity, side)
        remaining = max(0, order.quantity - order.broker_filled_quantity)
        candidate.quantity = min(remaining, missing)
        from app.config import LOT_SIZES
        lot = LOT_SIZES.get(session.symbol, 1) if candidate.right else 1
        if candidate.quantity % lot:
            raise ValueError('Remaining replacement quantity is not a whole option lot')
        if not candidate.quantity:
            order.status = OrderStatus.CANCELLED
            await publish(session, order, job, 'confirmed', 'No remaining uncovered exposure; no replacement needed')
            session.queue.put_nowait(json.dumps({'type': 'order_cancelled', 'order_id': order.order_id}))
            return
        await validate_stop(session, candidate, job['operation_id'])
        kwargs = dict(symbol=session.symbol, side='B' if candidate.side == TradeSide.BUY else 'S', qty=candidate.quantity,
                      tag='cv' + job['operation_id'].split(':')[-1].replace('-', '')[:18])
        if candidate.right:
            kwargs.update(right=candidate.right, strike=candidate.strike, expiry=candidate.expiry)
        if candidate.order_type == OrderType.LIMIT:
            method = broker.place_options_limit_order if candidate.right else broker.place_limit_order
            kwargs['price'] = candidate.limit_price
        else:
            method = broker.place_options_sl_order if candidate.right else broker.place_sl_order
            kwargs.update(trigger_price=candidate.trigger_price, limit_price=candidate.limit_price)
        if version != getattr(session, '_protection_revision', 0):
            raise RuntimeError('Position changed during replacement preparation; refresh required')
        job['tag'] = kwargs['tag']
        # Persist before a potentially ambiguous submission; never automatically repeat it.
        job['candidate'] = candidate.model_dump(mode='json')
        job['replacement_submitted'] = True
        await publish(session, order, job, 'replacing', 'Waiting for Kotak to confirm replacement exit')
        if getattr(session, 'broker_refresh_events', None) is not None or version != getattr(session, '_protection_revision', 0):
            raise RuntimeError('Broker state changed before replacement submission; refresh required')
        require_active(session, job, broker)
        replacement = await asyncio.to_thread(method, **kwargs)
        job['candidate'] = candidate.model_dump(mode='json')
        job['replacement_id'] = replacement
        await asyncio.to_thread(journal.store.put, job['operation_id'], job)
    raw = await wait_event(job, queue, lambda raw: _matches(raw, candidate, replacement))
    await _commit(session, order, candidate, job, broker, raw)


async def run(session, order, candidate, job, broker, queue, observe=None):
    from app.services.kotak_service import KotakOrderRejected
    job['confirmation_deadline'] = asyncio.get_running_loop().time() + CONFIRM_WAIT
    try:
        await validate_stop(session, candidate, job['operation_id'])
        try:
            method = broker.modify_sl_to_limit_order if candidate.order_type == OrderType.LIMIT else broker.modify_sl_order
            args = (job['broker_id'], candidate.limit_price, candidate.quantity) if candidate.order_type == OrderType.LIMIT else (
                job['broker_id'], candidate.trigger_price, candidate.limit_price, candidate.quantity)
            if _current(session, order) is not order or order.status != OrderStatus.PENDING or getattr(session, 'broker_refresh_events', None) is not None:
                raise RuntimeError('Order changed before modification; refresh required')
            require_active(session, job, broker)
            job['submitted_at'] = time.time()
            returned_id = await asyncio.to_thread(method, *args)
            if isinstance(returned_id, str) and returned_id != job['broker_id']:
                # A changed identity is uncertain, never cancel the old ID on this evidence.
                raise RuntimeError('Modification returned a different broker identity; refresh required')
        except KotakOrderRejected:
            await _fallback(session, order, candidate, job, broker, queue)
            return
        raw = await wait_event(job, queue, lambda raw: _matches(raw, candidate, job['broker_id'])
                                or ('modify' in reports.normalize_order(raw)['status'] and 'reject' in reports.normalize_order(raw)['status']))
        if 'reject' in reports.normalize_order(raw)['status']:
            await _fallback(session, order, candidate, job, broker, queue)
        else:
            await _commit(session, order, candidate, job, broker, raw)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        uncertain = not isinstance(exc, (ValueError, KotakOrderRejected))
        # Once cancellation is confirmed, the original order must not appear live.
        if job.get('original_cancelled') and not order.kotak_fill_confirmed:
            order.status = OrderStatus.CANCELLED
            session.queue.put_nowait(json.dumps({'type': 'order_cancelled', 'order_id': order.order_id}))
        message = f'Original exit cancelled; replacement protection is unconfirmed: {exc}' if job.get('original_cancelled') else str(exc)
        await publish(session, order, job, 'unknown' if uncertain else 'failed', message)
        session.queue.put_nowait(json.dumps({'type': 'broker_error', 'message': f'Kotak conversion: {message}'}))
    finally:
        if job.get('state') != 'unknown':
            broker.deregister_order_observer(job['operation_id'])
        else:
            # Deliver evidence queued during persistence after the main worker exits.
            if observe:
                while not queue.empty():
                    asyncio.get_running_loop().call_soon(observe, queue.get_nowait())


async def reconcile_refresh(session, rows):
    """An explicit coherent broker refresh supersedes an old unresolved operation."""
    from app.models.schemas import Order
    for order in order_service.get_all_orders(session.session_id):
        metadata = order.broker_conversion or {}
        operation = metadata.get('operation_id')
        if not operation or metadata.get('state') not in ACTIVE:
            continue
        # Never let refresh resolve an operation while its mutation is still running.
        task = _tasks.get(operation)
        if task and not task.done():
            continue
        job = await asyncio.to_thread(journal.store.get, operation)
        if not job:
            continue
        candidate = Order.model_validate(job['candidate'])
        broker_id = job.get('replacement_id') or job['broker_id']
        if job.get('replacement_submitted') and not job.get('replacement_id'):
            tagged = [row for row in rows if row.get('tag') == job.get('tag')]
            if len(tagged) != 1:
                continue  # Absence is not proof an ambiguous placement failed.
            broker_id = tagged[0]['kotak_order_id']
            job['replacement_id'] = broker_id
        row = next((row for row in rows if row['kotak_order_id'] == broker_id), None)
        if row and _matches(row, candidate, broker_id):
            await publish(session, order, job, 'confirmed', 'Confirmed by broker refresh')
            from app.services.kotak_service import get_service
            get_service().deregister_order_observer(operation)
        elif row and row['status'] in ('open', 'trigger pending', 'cancelled', 'canceled', 'rejected', 'complete', 'filled') and time.time() - job['requested_at'] >= CONFIRM_WAIT:
            await publish(session, order, job, 'failed', 'Broker refresh confirms conversion was not applied')
            from app.services.kotak_service import get_service
            get_service().deregister_order_observer(operation)


async def resume(session):
    """Recover unresolved identities with a read-only full refresh; never resubmit."""
    if not any(busy(order) for order in order_service.get_all_orders(session.session_id)):
        return
    from app.services import real_broker_state
    from app.services.kotak_service import get_service
    try:
        broker = get_service()
        await real_broker_state.refresh(session, broker)
        for order in order_service.get_all_orders(session.session_id):
            if not busy(order):
                continue
            operation = (order.broker_conversion or {}).get('operation_id')
            job = await asyncio.to_thread(journal.store.get, operation) if operation else None
            if job:
                await publish(session, order, job, 'unknown', 'Restored conversion is unconfirmed; waiting for broker evidence')
                watch_restored(session, order, job, broker)
    except Exception:
        logger.exception('broker_conversion_resume_refresh_failed session=%s', session.session_id)


def stop(session):
    for key, task in list(_queued_tasks.items()):
        if key[0] == session.session_id:
            task.cancel()
    for order in order_service.get_all_orders(session.session_id):
        operation = (order.broker_conversion or {}).get('operation_id')
        task = _tasks.get(operation)
        if task:
            task.cancel()
        if operation:
            from app.services.kotak_service import get_service
            get_service().deregister_order_observer(operation)


def enqueue(session, order, new_type, price):
    """Synchronous strategy entrypoint; the async worker still owns broker confirmation."""
    from app.services.kotak_service import KotakError
    if busy(order):
        raise KotakError('Conversion is unconfirmed; refresh broker state first')
    order.broker_conversion = {'state': 'queued', 'requested_type': new_type.value, 'updated_at': time.time()}
    key = (session.session_id, order.order_id)
    async def prepare():
        from app.services.protection_recovery import session_lock
        try:
            async with session_lock(session):
                if _current(session, order) is order and order.status == OrderStatus.PENDING:
                    await start(session, order, new_type, price)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            order.broker_conversion = {'state': 'failed', 'requested_type': new_type.value,
                                       'message': str(exc), 'updated_at': time.time()}
            logger.exception('broker_conversion_prepare_failed session=%s order=%s', session.session_id, order.order_id)
            session.queue.put_nowait(json.dumps({'type': 'broker_error', 'message': f'Kotak conversion: {exc}'}))
        finally:
            _queued_tasks.pop(key, None)
    _queued_tasks[key] = asyncio.create_task(prepare())
    return order


def watch_restored(session, order, job, broker):
    """Resume passive confirmation after restart, without submitting any mutation."""
    from app.models.schemas import Order
    operation = job['operation_id']
    candidate = Order.model_validate(job['candidate'])
    generation = getattr(broker, '_generation', None)
    job['broker_generation'] = generation if isinstance(generation, int) else None
    def observe(raw):
        if operation in _tasks:
            return
        identifier = str(raw.get('nOrdNo') or raw.get('kotak_order_id') or '')
        expected = job.get('replacement_id') or job['broker_id']
        if job.get('replacement_submitted') and not job.get('replacement_id'):
            tag = str(raw.get('GuiOrdId') or raw.get('tag') or raw.get('ig') or '')
            if tag != job.get('tag'):
                return
            expected = identifier
        if not _matches(raw, candidate, expected):
            return
        if job.get('replacement_submitted'):
            job['replacement_id'] = identifier
        async def confirm():
            try:
                await _commit(session, order, candidate, job, broker, raw)
            except Exception:
                logger.exception('restored_conversion_confirmation_failed operation=%s', operation)
            finally:
                broker.deregister_order_observer(operation)
                _tasks.pop(operation, None)
        _tasks[operation] = asyncio.create_task(confirm())
    broker.register_order_observer(operation, observe, asyncio.get_running_loop())
