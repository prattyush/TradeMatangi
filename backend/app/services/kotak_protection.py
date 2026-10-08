"""Event-driven protection of Kotak option entries; never a broker polling loop."""
import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager
import hashlib
import logging
import math
import time

from app.models.schemas import OrderStatus, OrderType, TradeSide
from app.services import order_service, protection_journal as journal

logger = logging.getLogger(__name__)
_workers = {}
_pending = {}
_closing = False


def startup():
    global _closing
    _closing = False


def enabled(session):
    return (session is not None and session.session_type == 'real'
            and getattr(session, 'instrument_type', None) == 'options'
            and getattr(session, 'execution_broker', 'KotakNeo') == 'KotakNeo')


def entries(session):
    if not enabled(session):
        return []
    return [o for o in order_service.get_all_orders(session.session_id)
            if o.user_id == session.user_id and o.source != 'broker_external'
            and o.execution_role != 'exit' and (o.entry_sl_price is not None or o.is_autostop)]


def handles(session, order):
    return enabled(session) and any((o.right, o.strike, o.expiry) == (order.right, order.strike, order.expiry)
                                   for o in entries(session))


def group(order):
    return order.protection_group or order.group_id or order.order_id


def key(order):
    return (order.broker_exchange or ('bse_fo' if order.symbol == 'BSESEN' else 'nse_fo'),
            order.broker_product or 'MIS', order.right, order.strike, order.expiry)


def allocations(session, executions, rows, exclusions=None):
    """FIFO remaining entry lots; explicit exits first, then unlinked exits once."""
    from app.services import fifo_positions, broker_reports
    from app.services.protection_recovery import Deferred
    known = {o.kotak_order_id: o for o in order_service.get_all_orders(session.session_id) if o.kotak_order_id}
    owners = {o.kotak_order_id: o for o in entries(session) if o.kotak_order_id}
    lots = defaultdict(deque)
    for row in fifo_positions.unique_executions(session, executions):
        scope = fifo_positions.scope(session, row)
        quantity, sign = row['quantity'], 1 if row['side'] == 'BUY' else -1
        queue = lots[scope]
        while quantity and queue and queue[0]['sign'] != sign:
            matched = min(quantity, queue[0]['quantity'])
            quantity -= matched
            queue[0]['quantity'] -= matched
            if not queue[0]['quantity']:
                queue.popleft()
        if quantity:
            owner = owners.get(row['kotak_order_id'])
            queue.append({'sign': sign, 'quantity': quantity, 'owner': owner, 'time': row['timestamp']})
    required, representatives = {}, {}
    for scope, queue in lots.items():
        for lot in queue:
            owner = lot['owner']
            if owner:
                identity = (scope, group(owner))
                required[identity] = required.get(identity, 0) + lot['quantity']
                representatives[identity] = owner
    if any(o.broker_filled_quantity and not o.kotak_order_id for o in entries(session)):
        raise Deferred('Protected entry broker identity is missing; refresh before automatic repair')
    suppressed = defaultdict(int)
    for order in known.values() if exclusions is None else []:
        if order.protection_suppressed_quantity:
            remaining = order.protection_suppressed_quantity
            mapping = order.protection_allocations or ({group(order): remaining} if order.protection_group or order.group_id else {})
            for name, quantity in mapping.items():
                take = min(remaining, quantity)
                suppressed[(key(order), name)] += take
                remaining -= take
    for record in (exclusions or {}).values():
        if record.get('state') == 'failed':
            continue
        for name, quantity in record['allocations'].items():
            identity = (tuple(record['contract']), name)
            remaining_then = record.get('remaining', {}).get(name, required.get(identity, 0))
            consumed = max(0, remaining_then - required.get(identity, 0))
            suppressed[identity] += max(0, quantity - consumed)
    for identity in required:
        required[identity] = max(0, required[identity] - suppressed[identity])
    covered = defaultdict(int)
    assigned = {}
    active = []
    for row in rows:
        if row['status'] in ('complete', 'filled', 'traded', 'cancelled', 'canceled', 'rejected', 'expired'):
            continue
        if not broker_reports.in_scope(session, row):
            continue
        contract = broker_reports.contract(session, row)
        scope = (row['exchange'], row.get('product', 'MIS'), contract['right'], contract['strike'], contract['expiry'])
        queue = lots.get(scope, [])
        if not queue:
            continue
        if row.get('side_known', True) is False:
            raise Deferred('Broker exit side is unknown; coverage cannot be verified')
        exit_side = 'SELL' if queue[0]['sign'] > 0 else 'BUY'
        if row['side'] != exit_side:
            continue
        if row['status'] in ('cancel pending', 'modify pending', 'modify validation pending'):
            raise Deferred('Broker exit edit is pending; protection audit deferred')
        order = known.get(row['kotak_order_id'])
        active.append((scope, row, order))
    active.sort(key=lambda item: (not bool(item[2] and (item[2].protection_group or item[2].group_id)),
                                  item[2].created_at if item[2] else 0, item[1]['kotak_order_id']))
    for scope, row, order in active:
        quantity = max(0, row['quantity'] - row['filled_quantity'])
        linked = group(order) if order and (order.protection_group or order.group_id) else None
        candidates = [i for i in required if i[0] == scope and (not linked or i[1] == linked)]
        candidates.sort(key=lambda i: (representatives[i].created_at, i[1]))
        mapping = {}
        for identity in candidates:
            take = min(quantity, max(0, required[identity] - covered[identity]))
            if take:
                covered[identity] += take
                quantity -= take
                mapping[identity[1]] = take
        if order and mapping:
            assigned[order.order_id] = mapping
    gaps = [(representatives[i], required[i], covered[i], required[i] - covered[i])
            for i in required if required[i] > covered[i]]
    return gaps, assigned


def request(session, *, reason, delay=.75, invalidate=True):
    if _closing or getattr(session, 'real_day_closing', False) or not entries(session):
        return
    from app.services.kotak_service import get_service
    from app.services import kotak_reports
    try:
        broker = get_service()
        account = kotak_reports.state(broker)
        if invalidate:
            account.revision += 1
        session._kotak_protection_broker = broker
        session._kotak_protection_enabled = True
        identity = (asyncio.get_running_loop(), broker.account_identity())
    except Exception:
        logger.exception('kotak_protection_schedule_failed session=%s', session.session_id)
        return
    pending = _pending.setdefault(identity, {})
    old = pending.get(session.session_id)
    # One leading-edge window: continuous fills cannot postpone protection forever.
    due = min(old[1], time.monotonic() + delay) if old else time.monotonic() + delay
    pending[session.session_id] = (session, due, reason)
    logger.info('kotak_protection_queued session=%s reason=%s coalesced=%s', session.session_id, reason, bool(old))
    if identity not in _workers or _workers[identity].done():
        _workers[identity] = asyncio.create_task(_drive(identity, broker))


def busy(session):
    from app.services.broker_conversion import ACTIVE
    from app.services.order_split import ACTIVE as SPLIT_ACTIVE
    return (getattr(session, 'real_day_closing', False) or getattr(session, '_kotak_manual_busy', 0) or getattr(session, 'order_split_in_progress', None)
            or getattr(session, 'broker_refresh_events', None) is not None
            or any((o.broker_conversion or {}).get('state') in ACTIVE or
                   (o.split_operation or {}).get('state') in SPLIT_ACTIVE
                   for o in order_service.get_all_orders(session.session_id)))


async def audit(session, broker):
    from app.services import kotak_reports, real_broker_state, protection_recovery as recovery
    if busy(session):
        raise recovery.Deferred('Manual edit, split or conversion pending; automatic repair deferred')
    bundle, executions = await snapshot(session, broker)
    if bundle.revision != kotak_reports.state(broker).revision:
        raise recovery.Deferred('New broker events arrived during the audit; rechecking')
    intents = {}
    for entry in entries(session):
        root = intent_key(session, entry)
        if root in intents:
            continue
        job = await load_intent(root)
        intents[root] = job
        if job and job['account'] != broker.account_identity():
            raise recovery.Deferred('Broker account changed; entry protection disabled')
        if job and job.get('children'):
            parent = type(entry).model_validate(job['parent'])
            if await recovery.reconcile_children(session, parent, f"{root}:{job.get('incident', 0)}", job, bundle.orders, broker):
                await asyncio.to_thread(journal.store.put, root, job)
    exclusions = await asyncio.to_thread(journal.store.get, f'entry-exclusions:{session.session_id}') or {}
    for order in order_service.get_all_orders(session.session_id):
        if (order.status != OrderStatus.CANCELLED or order.execution_role != 'exit'
                or not order.kotak_order_id or order.order_id in exclusions):
            continue
        intent = await asyncio.to_thread(journal.cancellation_intent, broker.account_identity(), order.kotak_order_id)
        if intent and intent.get('state') != 'failed' and (intent['initiator'] == 'user' or intent['purpose'] in ('conversion', 'flatten', 'session_stop')):
            await suppress(session, order, max(0, order.quantity - order.broker_filled_quantity))
    exclusions = await asyncio.to_thread(journal.store.get, f'entry-exclusions:{session.session_id}') or {}
    gaps, assigned = allocations(session, executions, bundle.orders, exclusions)
    for identifier, mapping in assigned.items():
        order = order_service.get_order(session.session_id, identifier)
        if order.protection_allocations != mapping:
            order.protection_allocations = mapping
            await asyncio.to_thread(order_service._write_order_to_db, order.model_copy(deep=True), strict=True)
    missing_groups = {group(entry) for entry, _, _, _ in gaps}
    for entry in entries(session):
        root = intent_key(session, entry)
        job = intents.get(root)
        if job and job.get('state') not in ('restored', 'closed') and group(entry) not in missing_groups:
            job['state'] = 'restored'
            await asyncio.to_thread(journal.store.put, root, job)
            recovery.emit(session, entry, root, 'restored', 'Broker-confirmed entry exit coverage restored')
    reserved_ids = set()
    expected_account_revision = bundle.revision
    session_revision = getattr(session, '_protection_revision', 0)
    for entry, required, covered, missing in gaps:
        if busy(session) or kotak_reports.state(broker).foreground:
            raise recovery.Deferred('Foreground trading operation has priority')
        root = intent_key(session, entry)
        job = intents.get(root)
        if job and job['account'] != broker.account_identity():
            raise recovery.Deferred('Broker account changed; entry protection disabled')
        if job and job.get('state') in ('restored', 'closed'):
            # Keep prior claims immutable while allowing a new fill/cancel incident.
            job = {'incident': job.get('incident', 0) + 1}
        job = job or {}
        incident = job.get('incident', 0)
        operation = f'{root}:{incident}'
        trigger = entry.entry_sl_price
        if trigger is None:
            if not entry.filled_price:
                raise recovery.Deferred('AutoStop fill price is unavailable')
            trigger = entry.filled_price * (.75 if entry.side == TradeSide.BUY else 1.25)
        linked = [o for o in order_service.get_all_orders(session.session_id)
                  if o.execution_role == 'exit' and group(o) == group(entry)
                  and key(o) == key(entry) and o.order_type == OrderType.STOPLOSS]
        if linked:
            trigger = max(linked, key=lambda o: (o.created_at, o.order_id)).trigger_price
        parent = entry.model_copy(deep=True)
        parent.order_id = root
        parent.kotak_order_id = root
        parent.side = TradeSide.SELL if entry.side == TradeSide.BUY else TradeSide.BUY
        parent.order_type = OrderType.STOPLOSS
        parent.execution_role = 'exit'
        parent.entry_sl_price = None
        parent.is_autostop = False
        parent.market_order = False
        parent.analytics = None
        parent.trigger_price = trigger
        parent.protection_group = group(entry)
        job.update(account=broker.account_identity(), session_id=session.session_id,
                   root_order_id=entry.order_id, parent=parent.model_dump(mode='json'),
                   entry_intent=True, missing_quantity=missing, incident=incident)
        await asyncio.to_thread(journal.store.put, root, job)
        logger.info('entry_protection_coverage session=%s entry=%s required=%d covered=%d missing=%d operation=%s',
                    session.session_id, entry.order_id, required, covered, missing, operation)
        recovery.emit(session, parent, operation, 'pending', f'Entry exit coverage: required {required}, covered {covered}, missing {missing}')
        await recovery.obtain_quote(session, parent, operation)
        async with kotak_reports.state(broker).submission, recovery.session_lock(session):
            if (busy(session) or expected_account_revision != kotak_reports.state(broker).revision
                    or session_revision != getattr(session, '_protection_revision', 0)):
                raise recovery.Deferred('Foreground edit/fill invalidated the protection calculation')
            async with recovery.allocation_reservation(session, parent):
                session._protection_recovery_busy = True
                try:
                    before = len(job.get('children', []))
                    await recovery._attempt(session, parent, operation, job, broker, bundle=bundle, reserved_ids=reserved_ids)
                    submitted = job.get('children', [])[before:]
                    expected_account_revision += len(submitted)
                    reserved_ids.update(item['order']['order_id'] for item in submitted if item['state'] == 'acknowledged')
                finally:
                    session._protection_recovery_busy = False
                    await asyncio.to_thread(journal.store.put, root, job)
    if reserved_ids:
        # All independent groups in a burst use one fresh position snapshot;
        # acknowledged submissions reserve capacity until one shared verification.
        raise recovery.Deferred('Protection submitted; verifying entry groups together')


async def snapshot(session, broker):
    """Normal fills verify in memory; rebuild history only for missing/new facts."""
    from app.services import kotak_reports, real_broker_state, fifo_positions, broker_reports
    from app.services.protection_recovery import Deferred
    version = getattr(session, '_protection_revision', 0)
    bundle = await kotak_reports.fetch(broker, background=True)
    if (busy(session) or version != getattr(session, '_protection_revision', 0)
            or bundle.revision != kotak_reports.state(broker).revision):
        raise Deferred('Foreground action or fill changed the audit snapshot')
    local = getattr(session, '_fifo_executions', None)
    fast = local is not None and getattr(session, '_fifo_account', None) == broker.account_identity()
    normalized = None
    if fast:
        kotak_reports.consistent(broker, real_broker_state.projection_id(session, broker.account_identity()))
        try:
            metadata = [row for row in local if row.get('expiry')]
            normalized = fifo_positions.unique_executions(session, bundle.executions, metadata)
            reported = real_broker_state.normalize_positions(session, bundle.positions, metadata)
            verified = fifo_positions.verified_positions(session, normalized, reported, metadata)
            def totals(rows):
                result = defaultdict(lambda: [0, 0.])
                for row in rows:
                    identity = (*fifo_positions.scope(session, row, metadata), row['kotak_order_id'], row['side'])
                    result[identity][0] += row['quantity']
                    result[identity][1] += row['quantity'] * row['price']
                return result
            old, fresh = totals(local), totals(normalized)
            fast = old.keys() == fresh.keys() and all(old[k][0] == fresh[k][0] and
                math.isclose(old[k][1], fresh[k][1], rel_tol=1e-8,
                             abs_tol=max(.01, fresh[k][0] * .005 + 1e-6)) for k in fresh)
            cached = { (p.get('broker_exchange') or fifo_positions.exchange_for(session), p.get('product', 'MIS'),
                         p.get('right'), p.get('strike'), p.get('expiry')): p
                       for p in getattr(session, 'broker_positions', [])}
            verified_open = {(p['broker_exchange'], p['product'], p['right'], p['strike'], p['expiry'])
                             for p in verified if p['quantity']}
            fast = fast and {k for k, p in cached.items() if p['quantity']} == verified_open
            for p in verified:
                identity = (p['broker_exchange'], p['product'], p['right'], p['strike'], p['expiry'])
                previous = cached.get(identity)
                fast = fast and previous is not None and previous['quantity'] == p['quantity'] and previous['side'] == p['side']
                fast = fast and math.isclose(previous['avg_entry_price'], p['avg_entry_price'], rel_tol=1e-8, abs_tol=.01)
            by_id = {r['kotak_order_id']: r for r in bundle.orders}
            for order in order_service.get_all_orders(session.session_id):
                row = by_id.get(order.kotak_order_id)
                if row and (row['quantity'] != order.quantity or row['filled_quantity'] != order.broker_filled_quantity
                            or (row['status'] in ('cancelled', 'canceled', 'rejected', 'expired') and order.status != OrderStatus.CANCELLED)):
                    fast = False
                if row and order.execution_role == 'exit' and order.status == OrderStatus.PENDING:
                    if (order.order_type == OrderType.STOPLOSS and not math.isclose(row.get('trigger_price', 0), order.trigger_price, abs_tol=.01)
                            or not math.isclose(row.get('limit_price', 0), order.limit_price, abs_tol=.01)):
                        fast = False
        except (ValueError, KeyError, TypeError):
            fast = False
    if fast:
        session._kotak_report_bundle = bundle
        logger.info('entry_protection_snapshot session=%s mode=memory history_rewrite=false', session.session_id)
        return bundle, normalized
    await real_broker_state.refresh(session, broker, protection=True, bundle=bundle)
    logger.info('entry_protection_snapshot session=%s mode=rebuild history_rewrite=true', session.session_id)
    return session._kotak_report_bundle, session._fifo_executions


async def _drive(identity, broker):
    from app.services import simulation, protection_recovery as recovery
    started = time.monotonic()
    try:
        while _pending.get(identity) and time.monotonic() - started < 30:
            pending = _pending[identity]
            due = min(item[1] for item in pending.values())
            if due > time.monotonic():
                await asyncio.sleep(min(due - time.monotonic(), .25))
                continue
            ready = [key for key, item in pending.items() if item[1] <= time.monotonic()]
            batch = [pending.pop(key) for key in ready]
            for session, _, reason in batch:
                if (simulation.get_session(session.session_id) is not session or session.state.value not in ('running', 'paused')
                        or getattr(session, 'real_day_closing', False)):
                    continue
                try:
                    await audit(session, broker)
                except recovery.Deferred as exc:
                    logger.info('entry_protection_deferred session=%s reason=%s', session.session_id, exc)
                    _pending.setdefault(identity, {})[session.session_id] = (session, time.monotonic() + 1, reason)
                except Exception as exc:
                    logger.exception('entry_protection_failed session=%s', session.session_id)
                    for entry in entries(session):
                        recovery.emit(session, entry, '', 'needs_attention', f'Entry protection could not be verified: {exc}')
                    _pending.setdefault(identity, {})[session.session_id] = (session, time.monotonic() + 2, reason)
        for session, _, _ in _pending.get(identity, {}).values():
            for entry in entries(session):
                recovery.emit(session, entry, '', 'needs_attention', 'Entry protection remains unresolved; use Trade History Refresh to retry')
    finally:
        _pending.pop(identity, None)
        _workers.pop(identity, None)


@asynccontextmanager
async def foreground(session):
    from app.services import kotak_reports
    broker = getattr(session, '_kotak_protection_broker', None)
    account = kotak_reports.state(broker) if broker else None
    session._kotak_manual_busy = getattr(session, '_kotak_manual_busy', 0) + 1
    session._protection_revision = getattr(session, '_protection_revision', 0) + 1
    if account:
        account.foreground += 1
        account.revision += 1
    try:
        yield
    finally:
        session._kotak_manual_busy -= 1
        session._protection_revision = getattr(session, '_protection_revision', 0) + 1
        if account:
            account.foreground -= 1
            account.revision += 1
        request(session, reason='manual_completed', delay=.75)


async def suppress(session, order, quantity):
    """Write manual exclusion before a broker mutation; caller rolls back refusal."""
    if not enabled(session) or order.execution_role != 'exit' or not handles(session, order) or quantity <= 0:
        return None
    previous = order.protection_suppressed_quantity
    remaining_at_request = {}
    ledger = getattr(session, '_fifo_executions', None)
    if ledger is not None:
        unallocated, _ = allocations(session, ledger, [], {})
        remaining_at_request = {group(entry): required for entry, required, _, _ in unallocated if key(entry) == key(order)}
    mapping = order.protection_allocations or {}
    if not mapping:
        # Before the first audit, an explicit user cancellation still has intent.
        available = quantity
        for entry in sorted(entries(session), key=lambda o: (o.created_at, o.order_id)):
            if key(entry) == key(order):
                take = min(available, remaining_at_request.get(group(entry), entry.broker_filled_quantity))
                if take:
                    mapping[group(entry)] = mapping.get(group(entry), 0) + take
                    available -= take
    remaining, removed = quantity, {}
    for name, size in mapping.items():
        take = min(remaining, size)
        if take:
            removed[name] = take
            remaining -= take
    storage_key = f'entry-exclusions:{session.session_id}'
    exclusions = await asyncio.to_thread(journal.store.get, storage_key) or {}
    previous_record = exclusions.get(order.order_id)
    exclusions[order.order_id] = {'contract': list(key(order)), 'allocations': removed,
                                 'remaining': remaining_at_request,
                                 'state': 'requested', 'requested_at': time.time()}
    if previous_record:
        for name, size in previous_record['allocations'].items():
            exclusions[order.order_id]['allocations'][name] = exclusions[order.order_id]['allocations'].get(name, 0) + size
    await asyncio.to_thread(journal.store.put, storage_key, exclusions)
    order.protection_suppressed_quantity += quantity
    order.protection_allocations = mapping
    await asyncio.to_thread(order_service._write_order_to_db, order.model_copy(deep=True), strict=True)
    return previous, previous_record


async def rollback_suppression(order, previous):
    if previous is not None:
        order.protection_suppressed_quantity, previous_record = previous
        storage_key = f'entry-exclusions:{order.session_id}'
        exclusions = await asyncio.to_thread(journal.store.get, storage_key) or {}
        if previous_record:
            exclusions[order.order_id] = previous_record
        else:
            exclusions.pop(order.order_id, None)
        await asyncio.to_thread(journal.store.put, storage_key, exclusions)
        await asyncio.to_thread(order_service._write_order_to_db, order.model_copy(deep=True), strict=True)


def definitive_refusal(exc):
    from app.services.kotak_service import KotakOrderRejected
    while exc is not None:
        if isinstance(exc, KotakOrderRejected):
            return True
        exc = exc.__cause__
    return False


def intent_key(session, entry):
    return 'entry:' + hashlib.sha256(f'{session.user_id}:{session.session_id}:{key(entry)}:{group(entry)}'.encode()).hexdigest()[:24]


async def load_intent(root):
    index = await asyncio.to_thread(journal.store.get, root)
    if index and index.get('state') not in ('restored', 'closed'):
        # Submission writes are durable before the root/index write. Recover a
        # process crash in that gap from the authoritative incident record.
        incident = await asyncio.to_thread(journal.store.get, f"{root}:{index.get('incident', 0)}")
        if incident:
            return incident
    return index


async def shutdown():
    global _closing
    _closing = True
    tasks = list(_workers.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _workers.clear()
    _pending.clear()
