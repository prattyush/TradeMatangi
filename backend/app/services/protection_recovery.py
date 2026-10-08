"""Kotak-only cancellation recovery. Broker reports, never chart history, own coverage."""
from __future__ import annotations
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from zoneinfo import ZoneInfo
import hashlib
import json
import logging
import math
import time
import uuid
from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.services import order_service, protection_journal as journal

logger = logging.getLogger(__name__)
_tasks: dict[str, asyncio.Task] = {}
_scope_locks: dict[tuple, list] = {}
_pending_events: dict[str, dict[str, tuple]] = {}
_closing = False


@asynccontextmanager
async def scope_lock(scope):
    entry = _scope_locks.setdefault(scope, [asyncio.Lock(), 0])
    entry[1] += 1
    try:
        async with entry[0]:
            yield
    finally:
        entry[1] -= 1
        if not entry[1]:
            _scope_locks.pop(scope, None)


@asynccontextmanager
async def allocation_reservation(session, parent):
    """Wait off-loop for any already-running allocation resizer to finish."""
    lock = order_service.exit_mutation_lock(session.session_id, session.symbol, *contract(parent))
    acquiring = asyncio.create_task(asyncio.to_thread(lock.acquire))
    try:
        await asyncio.shield(acquiring)
    except asyncio.CancelledError:
        await acquiring
        lock.release()
        raise
    try:
        yield
    finally:
        lock.release()


class Deferred(Exception):
    pass


def contract(order):
    return (order.right, order.strike, order.expiry)


def session_lock(session):
    lock = getattr(session, 'website_order_edit_lock', None)
    if lock is None:
        session.website_order_edit_lock = lock = asyncio.Lock()
    return lock


def emit(session, order, operation, state, message, replacement_ids=None):
    event = {'type': 'protection_recovery', 'session_id': session.session_id, 'operation_id': operation,
             'symbol': session.symbol, 'right': order.right, 'strike': order.strike, 'expiry': order.expiry,
             'state': state, 'message': message, 'replacement_ids': replacement_ids or []}
    session.queue.put_nowait(json.dumps(event))
    logger.info('protection_recovery session=%s operation=%s contract=%s state=%s message=%s',
                session.session_id, operation, contract(order), state, message)


def note_fill(session, order, quantity, before_net):
    if session.session_type != 'real' or getattr(session, 'execution_broker', 'KotakNeo') != 'KotakNeo':
        return
    session._protection_revision = getattr(session, '_protection_revision', 0) + 1
    after = before_net + quantity * (1 if order.side == TradeSide.BUY else -1)
    epochs = getattr(session, '_protection_epochs', {})
    if before_net and (not after or before_net * after < 0):
        epochs[contract(order)] = epochs.get(contract(order), 0) + 1
        emit(session, order, order.recovery_operation_id or '', 'cleared', 'Position closed or reversed')
    session._protection_epochs = epochs
    from app.services.kotak_protection import request
    if order.execution_role == 'exit':
        request(session, reason='exit_fill', delay=.75)
    if order.execution_role == 'exit' or (before_net and before_net * (1 if order.side == TradeSide.BUY else -1) < 0):
        session._last_exit_fill_at = time.time()
    logger.info('protection_fill_committed session=%s broker_order=%s contract=%s delta=%s net_before=%s net_after=%s',
                session.session_id, order.kotak_order_id, contract(order), quantity, before_net, after)


def note_cancel(session, order, metadata):
    if _closing or getattr(session, 'execution_broker', 'KotakNeo') != 'KotakNeo':
        return
    from app.services.kotak_protection import handles, request
    if handles(session, order):
        order_service._write_order_to_db(order)
        request(session, reason='cancel', delay=.75)
        return
    if _closing or session.session_type != 'real' or order.source == 'broker_external' or order.execution_role != 'exit':
        # Imported external orders still contribute to coverage, but are not taken over.
        order_service._write_order_to_db(order)
        return
    operation = order.recovery_operation_id or 'slr:' + hashlib.sha256(f'{session.session_id}:{order.order_id}'.encode()).hexdigest()[:24]
    order.recovery_operation_id = operation
    task = _tasks.get(operation)
    if task and not task.done():
        _pending_events.setdefault(operation, {})[order.kotak_order_id] = (session, order, metadata)
        return
    emit(session, order, operation, 'pending', 'Kotak cancelled an exit; checking remaining protection')
    task = asyncio.create_task(_drive(session, order, metadata, operation))
    _tasks[operation] = task
    def finished(completed):
        if _tasks.get(operation) is completed:
            _tasks.pop(operation, None)
        if not completed.cancelled() and completed.exception():
            logger.error('protection_recovery_unhandled operation=%s error=%s', operation, completed.exception())
        queued = _pending_events.get(operation, {})
        if queued and not _closing:
            key = next(iter(queued))
            following = queued.pop(key)
            if not queued:
                _pending_events.pop(operation, None)
            note_cancel(*following)
    task.add_done_callback(finished)


def market_open(session):
    from app.config import MARKET_OPEN, get_market_close
    now = datetime.now(ZoneInfo('Asia/Kolkata'))
    return (session.date == now.date().isoformat() and now.weekday() < 5
            and MARKET_OPEN <= now.strftime('%H:%M:%S') < get_market_close(session.date))


def fresh_quote(session, order):
    from app.services.market_data import get_hub
    expected = contract(order)
    group = getattr(session, 'market_feed_group', None)
    quotes = getattr(session, '_protection_quotes', {})
    candidates = [quotes.get(expected)]
    hub = get_hub()
    for key, feed in list(hub.feeds.items()):
        instrument = feed['instrument']
        underlying = instrument.get('underlying') or instrument.get('symbol')
        if underlying != session.symbol or (instrument.get('right'), instrument.get('strike'), instrument.get('expiry')) != expected:
            continue
        if group and key[0] != group.actual:
            continue
        candidates.append(hub.quotes.get(key))
    for quote in sorted((quote for quote in candidates if quote), key=lambda item: float(item.get('received_at', 0)), reverse=True):
        if not quote:
            continue
        try:
            price = float(quote.get('close', quote.get('price', 0)))
            received = float(quote.get('received_at', 0))
            # Chart times encode IST as UTC; the receive clock is real UTC.
            source_age = time.time() - (float(quote.get('time', time.time() + 19800)) - 19800)
        except (ValueError, TypeError, OverflowError):
            continue
        if math.isfinite(price) and price > 0 and 0 <= time.time() - received <= 5 and -1 <= source_age <= 5:
            if group and received < getattr(group, 'quote_after', 0):
                continue
            quotes[expected] = dict(quote)
            session._protection_quotes = quotes
            return price
    raise Deferred('No fresh quote for the exact contract; protection not submitted')


async def obtain_quote(session, order, operation):
    try:
        return fresh_quote(session, order)
    except Deferred:
        group = getattr(session, 'market_feed_group', None)
        if not group:
            raise
        from app.services.market_data import get_hub
        instrument = {'kind': 'option', 'underlying': session.symbol, 'right': order.right,
                      'strike': order.strike, 'expiry': order.expiry} if order.right else {'kind': 'equity', 'symbol': session.symbol}
        try:
            handle = await get_hub().subscribe(instrument, f'{operation}:quote', group, asyncio.Queue(maxsize=2))
        except Exception as exc:
            raise Deferred(f'Fresh quote subscription failed: {exc}') from exc
        try:
            for _ in range(20):
                await asyncio.sleep(.1)
                try:
                    return fresh_quote(session, order)
                except Deferred:
                    pass
            raise Deferred('Fresh contract quote unavailable')
        finally:
            handle.close()


def trigger_price(original, ltp, side, default_gap):
    from app.services.kotak_service import _round_to_tick
    valid = lambda price: price > 0 and (price < ltp if side == 'LONG' else price > ltp)
    if original and math.isfinite(original):
        rounded = _round_to_tick(original)
        if valid(rounded):
            return rounded, 'restored'
    if not math.isfinite(default_gap) or not 0 < default_gap < 1:
        raise Deferred('Invalid default stoploss percentage')
    fallback = _round_to_tick(ltp * (1 - default_gap if side == 'LONG' else 1 + default_gap))
    if not valid(fallback):
        raise Deferred('Cannot place a valid stop within the instrument tick size')
    return fallback, 'default_gap'


def expected_exchange(session, order):
    if order.right:
        return 'bse_fo' if session.symbol == 'BSESEN' else 'nse_fo'
    from app.services.kotak_service import _SYMBOL_MAP
    return _SYMBOL_MAP[session.symbol][1]


def matching(session, order, row):
    from app.services import broker_reports as reports
    return (reports.in_scope(session, row) and reports.contract(session, row) ==
            {'right': order.right, 'strike': order.strike, 'expiry': order.expiry}
            and row.get('product', 'MIS').upper() == (order.broker_product or 'MIS').upper()
            and (row.get('exchange') or expected_exchange(session, order)) == expected_exchange(session, order))


def coverage(session, parent, rows, position_quantity, side, reserved_ids=()):
    exit_side = 'SELL' if side == 'LONG' else 'BUY'
    by_id = {row['kotak_order_id']: row for row in rows}
    covered = 0
    for row in rows:
        if not matching(session, parent, row):
            continue
        if row['status'] in ('complete', 'filled', 'traded', 'cancelled', 'canceled', 'rejected'):
            continue
        if row.get('side_known', True) is False:
            raise Deferred('Broker order side is missing; exit coverage is uncertain')
        if row['side'] != exit_side:
            continue
        if row['status'] in ('cancel pending', 'modify pending', 'modify validation pending'):
            raise Deferred('Exit cancellation/modification still pending at broker')
        covered += max(0, row['quantity'] - row['filled_quantity'])
    for local in order_service.get_open_orders(session.session_id):
        if contract(local) != contract(parent) or local.side.value != exit_side:
            continue
        if local.kotak_order_id:
            if local.kotak_order_id not in by_id:
                if local.order_id in reserved_ids and local.recovery_state == 'acknowledged':
                    covered += max(0, local.quantity - local.broker_filled_quantity)
                    continue
                raise Deferred('Broker report has not caught up with an acknowledged exit')
        elif local.recovery_state in ('submitting', 'unknown'):
            raise Deferred('A recovery submission has an uncertain acknowledgement')
        elif local.recovery_state not in ('prepared', 'superseded'):
            covered += max(0, local.quantity - local.broker_filled_quantity)
    return max(0, position_quantity - covered), covered


async def reports_for(session, parent, broker, bundle=None):
    from app.services import real_broker_state, trading
    version = getattr(session, '_protection_revision', 0)
    try:
        from app.services import kotak_reports
        bundle = bundle or await kotak_reports.fetch(broker, background=True)
        rows, raw_positions = bundle.orders, bundle.positions
    except Exception as exc:
        raise Deferred(f'Broker reports unavailable: {exc}') from exc
    if getattr(session, 'broker_refresh_events', None) is not None or version != getattr(session, '_protection_revision', 0):
        raise Deferred('Broker state changed during protection audit')
    product = (parent.broker_product or 'MIS').upper()
    positions = real_broker_state.normalize_positions(session, raw_positions)
    # A missing sibling callback is discoverable from the same symbol's order book.
    by_id = {row['kotak_order_id']: row for row in rows}
    for sibling in list(order_service.get_open_orders(session.session_id)):
        row = by_id.get(sibling.kotak_order_id)
        if sibling.execution_role != 'exit' or sibling.source == 'broker_external' or row is None:
            continue
        if sibling.broker_conversion and sibling.broker_conversion.get('state') in ('cancelling', 'replacing'):
            continue  # The conversion worker owns this intentional cancellation.
        if row['status'] not in ('cancelled', 'canceled') or row['filled_quantity'] != sibling.broker_filled_quantity:
            continue
        sibling.status = OrderStatus.CANCELLED
        sibling.cancellation_status = 'cancelled'
        sibling.cancellation_reason = row.get('reject_reason') or None
        sibling.cancelled_at = time.time()
        note_cancel(session, sibling, {'status': 'cancelled', 'raw_reason': sibling.cancellation_reason,
                                     'received_at': sibling.cancelled_at, 'raw': {}})
        session.queue.put_nowait(json.dumps({'type': 'order_cancelled', 'order_id': sibling.order_id, 'broker_status': 'cancelled'}))
    candidates = [p for p in positions if (p.get('right'), p.get('strike'), p.get('expiry')) == contract(parent)
                  and p.get('product', 'MIS').upper() == product]
    signed = sum(p['quantity'] * (1 if p['side'] == 'LONG' else -1 if p['side'] == 'SHORT' else 0) for p in candidates)
    local = trading.get_position(session.session_id, session.symbol, right=parent.right, strike=parent.strike, expiry=parent.expiry)
    local_net = local.quantity * (1 if local.side == 'LONG' else -1 if local.side == 'SHORT' else 0)
    if signed != local_net:
        raise Deferred(f'Position reports differ from committed fills: broker={signed}, local={local_net}')
    if not signed or (signed > 0) != (parent.side == TradeSide.SELL):
        return rows, 0, 'FLAT', version
    side = 'LONG' if signed > 0 else 'SHORT'
    return rows, abs(signed), side, version


async def same_cycle(session, parent, broker):
    from app.services import broker_reports as reports
    try:
        from app.services import kotak_reports
        executions = (await kotak_reports.fetch(broker, background=True)).executions
    except Exception as exc:
        raise Deferred(f'Broker execution report unavailable: {exc}') from exc
    net = 0
    for row in sorted(executions, key=lambda row: row['timestamp']):
        if not matching(session, parent, row):
            continue
        if row.get('side_known', True) is False:
            raise Deferred('Broker execution side is missing; original position cycle is uncertain')
        before = net
        net += row['quantity'] * (1 if row['side'] == 'BUY' else -1)
        if before and (not net or before * net < 0) and row['timestamp'] >= parent.created_at:
            return False
    return True


def simulation_active(session):
    from app.services.simulation import get_session
    return get_session(session.session_id) is session and session.state.value in ('running', 'paused')


async def save_job(operation, job):
    await asyncio.to_thread(journal.store.put, operation, job)


def submission_key(operation, attempt, index):
    return f'{operation}:submission:{attempt}:{index}'


async def reconcile_children(session, parent, operation, job, rows, broker):
    from app.services.broker_order_service import register_callbacks
    for child_record in job.get('children', []):
        child = Order.model_validate(child_record['order'])
        if child_record['state'] in ('submitting', 'unknown', 'acknowledged'):
            matches = [row for row in rows if row.get('tag') == child_record['tag'] or
                       (child.kotak_order_id and row['kotak_order_id'] == child.kotak_order_id)]
            if len(matches) != 1:
                raise Deferred('Recovery acknowledgement uncertain; will reconcile without resubmitting')
            row = matches[0]
            child.kotak_order_id = row['kotak_order_id']
            child.recovery_state = 'acknowledged'
            child_record.update(state='acknowledged', order=child.model_dump(mode='json'))
            existing = order_service.get_order(session.session_id, child.order_id)
            alias = next((item for item in order_service.get_all_orders(session.session_id)
                          if item.kotak_order_id == row['kotak_order_id'] and item.order_id != child.order_id), None)
            if row['filled_quantity'] and max(getattr(existing, 'broker_filled_quantity', 0), getattr(alias, 'broker_filled_quantity', 0)) < row['filled_quantity']:
                raise Deferred('Recovery filled during uncertain acknowledgement; refresh broker state to apply confirmed executions')
            if alias is not None:
                if existing:
                    existing.status = OrderStatus.CANCELLED
                    existing.recovery_state = 'superseded'
                    await asyncio.to_thread(order_service._write_order_to_db, existing.model_copy(deep=True), strict=True)
                    session.queue.put_nowait(json.dumps({'type': 'order_cancelled', 'order_id': existing.order_id}))
                existing = alias
            if existing is None:
                order_service._orders.setdefault(session.session_id, {})[child.order_id] = child
            else:
                child = existing
                child.kotak_order_id = row['kotak_order_id']
                child.recovery_state = 'acknowledged'
                child.source = 'cancellation_recovery'
                child.recovery_operation_id = operation
                child.recovery_parent_order_id = job['root_order_id']
                child.exit_allocation_id = operation
                child.exit_position_side = 'LONG' if child.side == TradeSide.SELL else 'SHORT'
                child.exit_allocation_role = 'remainder'
            session.kotak_order_map[child.order_id] = row['kotak_order_id']
            if job.get('entry_intent'):
                child.protection_group = parent.protection_group
                child.group_id = parent.group_id
            child_record['order'] = child.model_dump(mode='json')
            if row['status'] in ('cancelled', 'canceled', 'rejected'):
                child_record['state'] = row['status']
                child.status = OrderStatus.CANCELLED
                if child.kotak_order_id != parent.kotak_order_id:
                    child.cancellation_status = row['status']
                    child.cancellation_reason = row.get('reject_reason') or None
                    child.cancelled_at = time.time()
                    note_cancel(session, child, {'status': row['status'], 'raw_reason': child.cancellation_reason,
                        'received_at': child.cancelled_at, 'raw': {}})
            # Known fills are applied by the existing callbacks/refresh; never invent them.
            child_record['order'] = child.model_dump(mode='json')
            await asyncio.to_thread(order_service._write_order_to_db, child.model_copy(deep=True), strict=True)
            register_callbacks(session, child, broker, asyncio.get_running_loop())
    await save_job(operation, job)


def local_capacity(session, parent, exclude_order_id):
    from app.services.trading import get_position
    position = get_position(session.session_id, session.symbol, right=parent.right, strike=parent.strike, expiry=parent.expiry)
    if position.side != ('LONG' if parent.side == TradeSide.SELL else 'SHORT'):
        return 0
    covered, seen = 0, set()
    for pending in order_service.get_open_orders(session.session_id):
        identity = pending.kotak_order_id or pending.order_id
        if identity in seen or pending.order_id == exclude_order_id or contract(pending) != contract(parent) or pending.side != parent.side:
            continue
        seen.add(identity)
        covered += max(0, pending.quantity - pending.broker_filled_quantity)
    return max(0, position.quantity - covered)


async def bind_acknowledgement(session, child, broker_id, operation, job):
    """A concurrent broker snapshot may have replaced the local order registry."""
    current = order_service.get_order(session.session_id, child.order_id)
    alias = next((item for item in order_service.get_all_orders(session.session_id)
                  if item.kotak_order_id == broker_id and item.order_id != child.order_id), None)
    if alias is not None:
        if current:
            current.status = OrderStatus.CANCELLED
            current.recovery_state = 'superseded'
            await asyncio.to_thread(order_service._write_order_to_db, current.model_copy(deep=True), strict=True)
            session.queue.put_nowait(json.dumps({'type': 'order_cancelled', 'order_id': current.order_id}))
        current = alias
    current = current or child
    current.kotak_order_id = broker_id
    current.recovery_state = 'acknowledged'
    current.source = 'cancellation_recovery'
    current.protection_group = child.protection_group
    current.group_id = child.group_id
    current.recovery_operation_id = operation
    current.recovery_parent_order_id = job['root_order_id']
    current.recovery_attempt = child.recovery_attempt
    current.execution_role = 'exit'
    current.exit_allocation_id = operation
    current.exit_position_side = 'LONG' if current.side == TradeSide.SELL else 'SHORT'
    current.exit_allocation_role = 'remainder'
    order_service._orders.setdefault(session.session_id, {})[current.order_id] = current
    session.kotak_order_map[current.order_id] = broker_id
    return current


async def abandon_prepared(session, child, record, operation, job, message):
    child.status = OrderStatus.CANCELLED
    child.recovery_state = 'failed'
    record.update(state='failed', order=child.model_dump(mode='json'))
    await save_job(operation, job)
    await asyncio.to_thread(order_service._write_order_to_db, child.model_copy(deep=True), strict=True)
    raise Deferred(message)


async def _attempt(session, parent, operation, job, broker, *, bundle=None, reserved_ids=()):
    from app.config import LOT_SIZES
    from app.services import user_settings_service, execution_price_service
    from app.services.broker_order_service import register_callbacks
    if parent.right and parent.expiry and parent.expiry < session.date:
        raise Deferred('Contract expired; no automatic replacement')
    if (parent.broker_product or 'MIS').upper() != 'MIS':
        raise Deferred('This broker product is not supported by the MIS recovery submitter')
    rows, qty, side, version = await reports_for(session, parent, broker, bundle)
    await reconcile_children(session, parent, operation, job, rows, broker)
    if _pending_events.get(operation):
        return True  # The continuation will use the cancelled replacement's latest price.
    entry_intent = job.get('entry_intent', False)
    if not qty or (not entry_intent and not await same_cycle(session, parent, broker)):
        job['state'] = 'closed'
        await save_job(operation, job)
        emit(session, parent, operation, 'cleared', 'Original position closed or reversed; no replacement')
        return True
    old = next((row for row in rows if row['kotak_order_id'] == parent.kotak_order_id), None)
    if entry_intent:
        old = {'quantity': job['missing_quantity'], 'filled_quantity': 0,
               'trigger_price': parent.trigger_price, 'order_type': 'SL'}
    if not entry_intent and (old is None or old['status'] not in (('cancelled', 'canceled', 'rejected') if parent.source == 'cancellation_recovery' else ('cancelled', 'canceled'))):
        raise Deferred('Waiting for the broker to confirm cancellation')
    if not entry_intent and not matching(session, parent, old):
        raise Deferred('Cancelled order contract/product/exchange differs from managed protection')
    missing, covered = coverage(session, parent, rows, qty, side, reserved_ids)
    logger.info('protection_coverage operation=%s contract=%s position=%s covered=%s missing=%s', operation, contract(parent), qty, covered, missing)
    if not missing:
        job['state'] = 'restored'
        await save_job(operation, job)
        emit(session, parent, operation, 'restored', 'Remaining position already has exit coverage')
        return True
    if not market_open(session):
        raise Deferred('Market closed; automatic protection deferred')
    if job.get('attempts', 0) >= 3:
        emit(session, parent, operation, 'needs_attention', 'Recovery submission limit reached; check remaining protection')
        return True
    # Respect intentional gaps: never restore more quantity than this incident lost.
    lost = max(0, old['quantity'] - old['filled_quantity'])
    by_id = {row['kotak_order_id']: row for row in rows}
    restored_for_parent = 0
    for child_record in job.get('children', []):
        if child_record.get('cancelled_parent_id', parent.kotak_order_id) != parent.kotak_order_id:
            continue
        row = by_id.get(child_record['order'].get('kotak_order_id'))
        if row and row['status'] not in ('complete', 'filled', 'traded', 'cancelled', 'canceled', 'rejected'):
            restored_for_parent += max(0, row['quantity'] - row['filled_quantity'])
    quantity = min(missing, lost if entry_intent else max(0, lost - restored_for_parent))
    if not quantity:
        job['state'] = 'restored'
        await save_job(operation, job)
        emit(session, parent, operation, 'needs_attention', 'Cancelled exit quantity is restored; additional uncovered quantity needs review')
        return True
    lot = LOT_SIZES.get(session.symbol, 1) if parent.right else 1
    if quantity <= 0 or quantity % lot:
        raise Deferred('Uncovered quantity is not a valid complete instrument lot')
    settings = await asyncio.to_thread(user_settings_service.get_settings, session.user_id)
    original = old.get('trigger_price', 0) if old.get('order_type') in ('SL', 'SL-L', 'SL-M', 'STOPLOSS') else 0
    if not original and parent.order_type == OrderType.STOPLOSS and not old.get('order_type'):
        original = parent.trigger_price
    price = fresh_quote(session, parent) if entry_intent else await obtain_quote(session, parent, operation)
    trigger, pricing = trigger_price(original, price, side, float(settings.get('default_sl_pct', .20)))
    limit = execution_price_service.limit_price(parent.side, trigger, float(settings.get('stoploss_limit_gap_pct', .015)))
    if version != getattr(session, '_protection_revision', 0):
        raise Deferred('Fill arrived while recovery was being prepared')
    attempt = job.get('attempts', 0) + 1
    chunks = order_service.split_quantity(session.symbol, quantity) if parent.right else [quantity]
    job.update(attempts=attempt, state='submitting')
    await save_job(operation, job)
    for index, chunk in enumerate(chunks):
        if entry_intent:
            from app.services import kotak_reports
            if kotak_reports.state(broker).foreground:
                raise Deferred('Foreground trading has priority over the next protection chunk')
        # Quotes and live state are rechecked before every freeze-sized submission.
        price = fresh_quote(session, parent)
        trigger, pricing = trigger_price(original, price, side, float(settings.get('default_sl_pct', .20)))
        limit = execution_price_service.limit_price(parent.side, trigger, float(settings.get('stoploss_limit_gap_pct', .015)))
        if version != getattr(session, '_protection_revision', 0):
            raise Deferred('Fill arrived before recovery submission')
        key = submission_key(operation, attempt, index)
        tag = 'tmr' + hashlib.sha256(key.encode()).hexdigest()[:17]
        child = Order(order_id=str(uuid.uuid5(uuid.NAMESPACE_URL, key)), session_id=session.session_id,
            user_id=session.user_id, symbol=session.symbol, side=parent.side, order_type=OrderType.STOPLOSS,
            quantity=chunk, trigger_price=trigger, limit_price=limit, is_stoploss=True,
            created_at=int(time.time()) + 19800, right=parent.right, strike=parent.strike, expiry=parent.expiry,
            wallet_ledger_kind='real', execution_role='exit', broker_product=parent.broker_product or 'MIS',
            broker_exchange=expected_exchange(session, parent), source='cancellation_recovery',
            execution_gap_pct=float(settings.get('stoploss_limit_gap_pct', .015)),
            exit_allocation_id=operation, exit_position_side=side, exit_allocation_role='remainder',
            analytics=parent.analytics,
            protection_group=parent.protection_group, group_id=parent.group_id,
            recovery_operation_id=operation, recovery_parent_order_id=job['root_order_id'],
            recovery_state='prepared', recovery_attempt=attempt)
        if entry_intent:
            from app.services.execution_analytics import created
            created(child, session)
        record = {'state': 'submitting', 'order': child.model_dump(mode='json'), 'tag': tag, 'cancelled_parent_id': parent.kotak_order_id}
        if not await asyncio.to_thread(journal.store.claim, key, record):
            raise Deferred('Submission already claimed; reconcile before retrying')
        child.recovery_state = 'submitting'
        order_service._orders.setdefault(session.session_id, {})[child.order_id] = child
        job.setdefault('children', []).append(record)
        await save_job(operation, job)
        await asyncio.to_thread(order_service._write_order_to_db, child.model_copy(deep=True), strict=True)
        if version != getattr(session, '_protection_revision', 0) or getattr(session, 'broker_refresh_events', None) is not None:
            await abandon_prepared(session, child, record, operation, job, 'Fill arrived during durable preparation; no order submitted')
        if simulation_active(session) is False or await asyncio.to_thread(broker.account_identity) != job['account']:
            await abandon_prepared(session, child, record, operation, job, 'Session stopped or broker account changed; no order submitted')
        if version != getattr(session, '_protection_revision', 0) or getattr(session, 'broker_refresh_events', None) is not None:
            await abandon_prepared(session, child, record, operation, job, 'Fill arrived before the broker call; no order submitted')
        if local_capacity(session, parent, child.order_id) < child.quantity:
            await abandon_prepared(session, child, record, operation, job, 'Another exit now covers this quantity; no duplicate submitted')
        fresh = fresh_quote(session, parent)
        if not (trigger < fresh if side == 'LONG' else trigger > fresh):
            await abandon_prepared(session, child, record, operation, job, 'Market crossed the prepared stop; recalculate before submitting')
        kwargs = dict(symbol=session.symbol, side=parent.side.value[0], qty=chunk,
                      trigger_price=trigger, limit_price=limit, tag=tag)
        if parent.right:
            kwargs.update(right=parent.right, strike=parent.strike, expiry=parent.expiry)
        method = broker.place_options_sl_order if parent.right else broker.place_sl_order
        logger.info('protection_submit operation=%s child=%s qty=%s trigger=%s limit=%s pricing=%s tag=%s', operation, child.order_id, chunk, trigger, limit, pricing, tag)
        try:
            broker_id = await asyncio.to_thread(method, **kwargs)
            from app.services import kotak_reports
            kotak_reports.invalidate(broker)
        except Exception as exc:
            from app.services import kotak_reports
            kotak_reports.invalidate(broker)
            # Even KotakError can wrap a timeout or a malformed positive response.
            # Only an explicit exchange rejection/rate limit is safe to retry.
            from app.services.kotak_service import KotakOrderRejected
            definitive = isinstance(exc, KotakOrderRejected)
            child.recovery_state = 'failed' if definitive else 'unknown'
            if definitive:
                child.status = OrderStatus.CANCELLED
            record.update(state=child.recovery_state, order=child.model_dump(mode='json'))
            job['state'] = child.recovery_state
            await save_job(operation, job)
            await asyncio.to_thread(order_service._write_order_to_db, child.model_copy(deep=True), strict=True)
            raise Deferred(f'Recovery placement {child.recovery_state}: {exc}') from exc
        if not isinstance(broker_id, str) or not broker_id or broker_id == parent.kotak_order_id or any(item is not record and item['order'].get('kotak_order_id') == broker_id for item in job['children']):
            child.recovery_state = 'unknown'
            record.update(state='unknown', order=child.model_dump(mode='json'))
            job['state'] = 'unknown'
            await save_job(operation, job)
            await asyncio.to_thread(order_service._write_order_to_db, child.model_copy(deep=True), strict=True)
            raise Deferred('Recovery returned an invalid/reused broker identity; reconcile before retrying')
        child = await bind_acknowledgement(session, child, broker_id, operation, job)
        record.update(state='acknowledged', order=child.model_dump(mode='json'))
        # Persist acknowledgement before a later retry; callbacks always run on the loop.
        register_callbacks(session, child, broker, asyncio.get_running_loop())
        await save_job(operation, job)
        await asyncio.to_thread(order_service._write_order_to_db, child.model_copy(deep=True), strict=True)
        if child.status == OrderStatus.PENDING:
            session.queue.put_nowait(json.dumps({'type': 'order_placed', **child.model_dump(mode='json')}))
    if entry_intent:
        # The manager verifies outside the foreground mutation lock, in its
        # next shared report pass. An acknowledgement alone is not restoration.
        job['state'] = 'verifying'
        await save_job(operation, job)
        return False
    # Verify the acknowledged exits against the broker book before announcing success.
    final_rows, final_quantity, _, _ = await reports_for(session, parent, broker)
    if not final_quantity:
        job['state'] = 'closed'
        await save_job(operation, job)
        emit(session, parent, operation, 'cleared', 'Position closed during recovery')
        return True
    final_missing, _ = coverage(session, parent, final_rows, final_quantity, side)
    if final_missing:
        if restored_for_parent + quantity >= lost:
            job['state'] = 'restored'
            await save_job(operation, job)
            emit(session, parent, operation, 'needs_attention', 'Cancelled exit quantity restored; additional uncovered quantity needs review')
            return True
        raise Deferred('Exit coverage changed after submission; rechecking the remainder')
    job['state'] = 'restored'
    await save_job(operation, job)
    emit(session, parent, operation, 'restored', f'Stoploss restored at {trigger:.2f} for {quantity} units ({pricing})',
         [item['order']['order_id'] for item in job['children'] if item['state'] == 'acknowledged'])
    return True


async def _drive(session, parent, metadata, operation):
    from app.services.kotak_service import get_service
    from app.services import simulation
    await asyncio.sleep(.75)
    broker = get_service()
    try:
        account = await asyncio.to_thread(broker.account_identity)
        await asyncio.to_thread(order_service._write_order_to_db, parent.model_copy(deep=True), strict=True)
        job = await asyncio.to_thread(journal.store.get, operation)
        if job and job.get('account') != account:
            raise Deferred('Broker account changed; automatic recovery disabled for this incident')
        if job and job.get('last_cancelled_id') == parent.kotak_order_id and job.get('state') in ('restored', 'closed', 'user_cancelled'):
            return
        job = job or {'account': account, 'session_id': session.session_id, 'root_order_id': parent.recovery_parent_order_id or parent.order_id,
                      'attempts': 0, 'children': []}
        job.update(parent=parent.model_dump(mode='json'), last_cancelled_id=parent.kotak_order_id,
                   cancelled_at=metadata.get('received_at', parent.cancelled_at or time.time()), state='pending',
                   explicit_origin=metadata.get('raw', {}).get('cancelInitiator') or job.get('explicit_origin', ''))
        intent = await asyncio.to_thread(journal.cancellation_intent, account, parent.kotak_order_id)
        if intent and intent.get('state') != 'failed':
            parent.cancel_request_id = intent['request_id']
            parent.cancel_initiator = intent['initiator']
            parent.cancel_purpose = intent['purpose']
            await asyncio.to_thread(order_service._write_order_to_db, parent.model_copy(deep=True), strict=True)
            logger.info('protection_cancel_matched operation=%s request=%s initiator=%s purpose=%s', operation, intent['request_id'], intent['initiator'], intent['purpose'])
            if intent['initiator'] == 'user':
                unresolved = any(item['state'] in ('submitting', 'unknown') for item in job.get('children', []))
                job['state'] = 'unknown' if unresolved else 'user_cancelled'
                await save_job(operation, job)
                emit(session, parent, operation, 'needs_attention' if unresolved else 'cleared',
                     'User cancellation respected; another recovery submission still needs reconciliation' if unresolved else 'User cancellation respected; no replacement')
                return
            if intent['purpose'] in ('conversion', 'flatten', 'session_stop'):
                job['state'] = 'closed'
                await save_job(operation, job)
                return
        await save_job(operation, job)
        explicit_origin = str(job['explicit_origin']).strip().upper()
        started = time.time()
        while simulation.get_session(session.session_id) is session and session.state.value in ('running', 'paused'):
            correlated = abs(getattr(session, '_last_exit_fill_at', 0) - job['cancelled_at']) <= 30
            was_correlated = job.get('correlated', False)
            job['correlated'] = was_correlated or correlated
            if job['correlated'] and not was_correlated:
                await save_job(operation, job)
            if not job['correlated'] and explicit_origin not in ('BROKER', 'RMS', 'EXCHANGE', 'SYSTEM'):
                if time.time() - job['cancelled_at'] > 30:
                    emit(session, parent, operation, 'needs_attention', 'Cancellation origin unknown and no recent exit fill; no automatic replacement')
                    return
                await asyncio.sleep(.5)
                continue
            scope = (account, expected_exchange(session, parent), parent.broker_product or 'MIS', session.symbol, *contract(parent))
            try:
                from app.services import kotak_reports
                async with kotak_reports.state(broker).submission, scope_lock(scope), session_lock(session):
                    if getattr(session, 'broker_refresh_events', None) is not None:
                        raise Deferred('Broker refresh is still running')
                    session._protection_recovery_busy = True
                    try:
                        async with allocation_reservation(session, parent):
                            if await _attempt(session, parent, operation, job, broker):
                                return
                    finally:
                        session._protection_recovery_busy = False
            except Deferred as exc:
                emit(session, parent, operation, 'needs_attention', str(exc))
                if _pending_events.get(operation):
                    return  # Continue with the newly cancelled child's latest trigger.
            await asyncio.sleep(min(5, 1 + job.get('attempts', 0)))
            if time.time() - started > 30:
                # Stop unattended loops; durable state is retained for explicit refresh/resume.
                emit(session, parent, operation, 'needs_attention', 'Recovery could not verify protection within 30 seconds; refresh to retry')
                return
    except Exception as exc:
        logger.exception('protection_recovery_failed operation=%s', operation)
        emit(session, parent, operation, 'needs_attention', f'Protection recovery failed: {exc}')


async def resume(session):
    global _closing
    _closing = False
    if session.session_type != 'real' or getattr(session, 'execution_broker', 'KotakNeo') != 'KotakNeo':
        return
    from app.services.kotak_protection import enabled, request
    if enabled(session):
        request(session, reason='restart', invalidate=False)
    try:
        jobs = await asyncio.to_thread(journal.store.for_session, session.session_id)
        known = {operation: job for operation, job in jobs}
        for operation, job in jobs:
            if job.get('entry_intent'):
                continue
            if job.get('state') in ('restored', 'closed', 'user_cancelled'):
                continue
            parent = Order.model_validate(job['parent'])
            note_cancel(session, parent, {'received_at': job['cancelled_at'], 'raw': {}})
        # A prior storage failure may have saved the cancelled order but not its job.
        for parent in order_service.get_all_orders(session.session_id):
            if parent.status != OrderStatus.CANCELLED or parent.cancellation_status not in ('cancelled', 'rejected') or not parent.recovery_operation_id:
                continue
            previous = known.get(parent.recovery_operation_id)
            if previous and previous.get('last_cancelled_id') == parent.kotak_order_id:
                continue
            note_cancel(session, parent, {'received_at': parent.cancelled_at or time.time(), 'raw': {}})
    except Exception:
        logger.exception('protection_recovery_resume_failed session=%s', session.session_id)


async def shutdown():
    global _closing
    _closing = True
    tasks = list(_tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _tasks.clear()
    _scope_locks.clear()
    _pending_events.clear()
