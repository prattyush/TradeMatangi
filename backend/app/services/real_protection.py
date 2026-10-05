"""Event-driven exit recovery: one timer per real session, no idle polling."""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass, field
import hashlib
import json
import logging
import re
import time
import uuid
from weakref import WeakKeyDictionary

from app.models.schemas import Order, OrderStatus, OrderType, TradeSide

logger = logging.getLogger(__name__)
RECHECK_SECONDS = 10
_states: dict[str, State] = {}
_account_locks = WeakKeyDictionary()
_facts = WeakKeyDictionary()


@dataclass
class State:
    session: object
    loop: asyncio.AbstractEventLoop = field(default_factory=asyncio.get_running_loop)
    timer: asyncio.TimerHandle | None = None
    task: asyncio.Task | None = None
    dirty: bool = False
    failures: int = 0
    seen: dict[str, tuple] = field(default_factory=dict)
    summary: list[dict] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _state(session):
    state = _states.get(session.session_id)
    if state is None or state.session is not session:
        if state:
            cancel(session.session_id)
        state = _states[session.session_id] = State(session)
    return state


def request(session, *, order=None, delay=0, reason="order_change", reset=True):
    if session.session_type != "real":
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        existing = _states.get(session.session_id)
        if existing and existing.loop.is_running():
            existing.loop.call_soon_threadsafe(lambda: request(session, order=order, delay=delay, reason=reason, reset=reset))
        # Durable order facts are still recorded by synchronous callers. Resume
        # and the next broker reconnect recover them on the owning event loop.
        return
    state = _state(session)
    if order is not None and getattr(order, "source", None) == "entry_protection" and reason == "broker_cancel_or_reject":
        reset = False
    if not reset and state.failures > 3:
        return
    if order is not None:
        stamp = (order.kotak_order_id, order.broker_filled_quantity, order.quantity, order.status)
        if state.seen.get(order.order_id) == stamp:
            return
        state.seen[order.order_id] = stamp
    if reset:
        state.failures = 0
    if state.task and not state.task.done():
        state.dirty = True
        return
    due = loop.time() + max(0, float(delay))
    if state.timer and not state.timer.cancelled():
        if state.timer.when() <= due:
            return
        state.timer.cancel()
    def fire():
        state.timer = None
        state.task = loop.create_task(_run(state))
    state.timer = loop.call_at(due, fire)
    logger.debug("protection_check_scheduled session=%s reason=%s delay=%s", session.session_id, reason, delay)


def cancel(session_id):
    state = _states.pop(session_id, None)
    if state:
        if state.timer:
            state.timer.cancel()
        if state.task:
            state.task.cancel()


def notify_reconnected():
    """Passive reconnect wake-up, never a new polling loop."""
    for state in list(_states.values()):
        if not state.loop.is_closed():
            state.loop.call_soon_threadsafe(lambda s=state.session: request(s, reason="broker_reconnected", reset=False))


async def shutdown():
    tasks = [s.task for s in _states.values() if s.task]
    for sid in list(_states):
        cancel(sid)
    await asyncio.gather(*tasks, return_exceptions=True)


async def broker_facts(broker, account, *, force=False):
    """Coalesce simultaneous sessions; invalidate after every broker mutation."""
    loop = asyncio.get_running_loop()
    cache = _facts.setdefault(loop, {})
    previous = cache.get(account)
    if previous and not force and time.monotonic() - previous[0] < 1:
        return previous[1]
    result = await asyncio.gather(*(asyncio.to_thread(fn) for fn in
        (broker.get_order_history, broker.get_trade_history, broker.get_positions)))
    cache[account] = (time.monotonic(), result)
    return result


def invalidate(account):
    _facts.get(asyncio.get_running_loop(), {}).pop(account, None)


def contract_key(item):
    if isinstance(item, dict):
        return (item.get("exchange") or "", item.get("product") or "MIS",
                item.get("right"), item.get("strike"), item.get("expiry"))
    exchange = item.broker_exchange or (("bse_fo" if item.symbol == "BSESEN" else "nse_fo") if item.right else "nse_cm")
    return (exchange, item.broker_product or "MIS", item.right, item.strike, item.expiry)


def _open_lots(session, orders):
    """FIFO executions avoid attributing a closed entry to a new position."""
    from app.services import broker_reports as reports
    lots = defaultdict(deque)
    for carry in getattr(session, "protection_carry", []):
        if carry["quantity"]:
            lots[tuple(carry["key"])].append([carry["side"], carry["quantity"], None, carry["price"]])
    tracked = {o.kotak_order_id: o for o in orders if o.kotak_order_id}
    seen = set()
    for row in sorted(getattr(session, "protection_executions", []), key=lambda r: (r["timestamp"], r["execution_id"])):
        identity = (row["exchange"], row["kotak_order_id"], row["execution_id"])
        if identity in seen:
            continue
        seen.add(identity)
        contract = reports.contract(session, row, getattr(session, "protection_master", None))
        key = contract_key({**row, **contract})
        side, quantity = row["side"], row["quantity"]
        inventory = lots[key]
        while quantity and inventory and inventory[0][0] != side:
            used = min(quantity, inventory[0][1])
            quantity -= used
            inventory[0][1] -= used
            if not inventory[0][1]:
                inventory.popleft()
        if quantity:
            inventory.append([side, quantity, tracked.get(row["kotak_order_id"]), row["price"]])
    return lots


async def _save(order):
    from app.services.order_service import _write_order_to_db
    await asyncio.to_thread(_write_order_to_db, order, strict=True)


def _claim(account, session, key, owner, confirmed_tags=()):
    """Cross-process contract lease in a separate namespace of existing Orders."""
    from app.services.db import get_dynamodb_resource
    record = {"session_id": f"protection-lock:{account}:{session.date}",
              "order_id": hashlib.sha256(repr((session.symbol, *key)).encode()).hexdigest()}
    table = get_dynamodb_resource().Table("Orders")
    previous = table.get_item(Key=record, ConsistentRead=True).get("Item", {})
    pending = set(previous.get("protection_pending_tags", []))
    resolved = pending.intersection(confirmed_tags)
    if resolved:
        table.update_item(Key=record, UpdateExpression="DELETE protection_pending_tags :resolved",
                          ExpressionAttributeValues={":resolved": resolved})
    if pending - resolved:
        return None  # Lease expiry cannot authorize a duplicate unknown submission.
    try:
        table.update_item(Key=record,
            UpdateExpression="SET protection_owner = :owner, protection_expires = :expires",
            ConditionExpression="(attribute_not_exists(protection_expires) OR protection_expires < :now) AND attribute_not_exists(protection_pending_tags)",
            ExpressionAttributeValues={":owner": owner, ":expires": int(time.time()) + 120, ":now": int(time.time())})
    except Exception as exc:
        if getattr(exc, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return None
        raise
    return record


def _release(record, owner):
    from app.services.db import get_dynamodb_resource
    # Keep pending tags until a fresh broker report proves their outcome.
    get_dynamodb_resource().Table("Orders").update_item(Key=record,
        UpdateExpression="SET protection_expires = :expires",
        ConditionExpression="protection_owner = :owner", ExpressionAttributeValues={":owner": owner, ":expires": 0})


def _renew(record, owner):
    from app.services.db import get_dynamodb_resource
    get_dynamodb_resource().Table("Orders").update_item(Key=record,
        UpdateExpression="SET protection_expires = :expires",
        ConditionExpression="protection_owner = :owner AND protection_expires >= :now",
        ExpressionAttributeValues={":owner": owner, ":expires": int(time.time()) + 120, ":now": int(time.time())})


def _pending(record, owner, tag, *, remove=False):
    from app.services.db import get_dynamodb_resource
    get_dynamodb_resource().Table("Orders").update_item(Key=record,
        UpdateExpression=("DELETE" if remove else "ADD") + " protection_pending_tags :tag",
        ConditionExpression="protection_owner = :owner",
        ExpressionAttributeValues={":owner": owner, ":tag": {tag}})


def _emit(session, payload):
    try:
        session.queue.put_nowait(json.dumps(payload))
    except asyncio.QueueFull:
        logger.warning("protection_event_queue_full session=%s", session.session_id)


def record_failure(session, message):
    state = _state(session)
    summary = [{"contract": [], "held": 0, "covered": 0, "missing": 0, "status": "error", "reason": str(message)}]
    session.protection_status = summary
    if summary != state.summary:
        state.summary = summary
        _emit(session, {"type": "protection_status", "session_id": session.session_id, "protection": summary})


async def _verify_fresh(session, broker, key, held, side, orders):
    """Revalidate AFTER the lease; an earlier snapshot cannot authorize a write."""
    from app.services import real_broker_state, broker_reports as reports
    rows, raw_positions = await asyncio.gather(asyncio.to_thread(broker.get_order_history), asyncio.to_thread(broker.get_positions))
    master = getattr(session, "protection_master", None)
    positions = real_broker_state.normalize_positions(session, raw_positions, master)
    current_held = sum(p["quantity"] for p in positions if contract_key(p) == key and
                       p["side"] == ("LONG" if side == "SELL" else "SHORT"))
    if current_held != held:
        raise ValueError("Broker position changed during protection check; retry with fresh facts")
    actual = {}
    for row in rows:
        if not reports.in_scope(session, row) or row["status"] not in real_broker_state.OPEN or row["side"] != side:
            continue
        row = {**row, **reports.contract(session, row, master)}
        if contract_key(row) == key:
            actual[row["kotak_order_id"]] = max(0, row["quantity"] - row["filled_quantity"])
    expected = {o.kotak_order_id: max(0, o.quantity - o.broker_filled_quantity)
                for o in orders if contract_key(o) == key and o.side.value == side
                and o.kotak_order_id and o.status == OrderStatus.PENDING
                and o.protection_submission not in ("submitting", "unknown")}
    if actual != expected:
        raise ValueError("Broker exits changed during protection check; retry with fresh facts")


async def _submit(session, broker, account, key, side, quantity, price, allocations, claim, owner):
    from app.services import order_service, broker_order_service
    from app.services.execution_price_service import reprice_trigger
    operation = str(uuid.uuid4())
    order = Order(order_id=operation, session_id=session.session_id, user_id=session.user_id,
        symbol=session.symbol, side=TradeSide(side), order_type=OrderType.STOPLOSS,
        quantity=quantity, trigger_price=price, limit_price=price,
        created_at=int(session.current_time or (time.time() + 19800)), is_stoploss=True,
        right=key[2], strike=key[3], expiry=key[4], execution_role="exit",
        broker_exchange=key[0], broker_product=key[1], source="entry_protection",
        protection_entry_allocations=allocations, protection_operation_id=operation,
        broker_client_tag="tmSL" + operation.replace("-", "")[:16], protection_submission="submitting")
    reprice_trigger(order)
    # Durable intent BEFORE HTTP. A persistence failure cannot place an order.
    await _save(order)
    order_service._orders.setdefault(session.session_id, {})[order.order_id] = order
    try:
        await asyncio.to_thread(_pending, claim, owner, order.broker_client_tag)
    except Exception as exc:
        # HTTP has not been attempted. Retain that proof for guard recovery.
        order.protection_submission = "failed"
        order.protection_error = str(exc)
        order.status = OrderStatus.CANCELLED
        await _save(order)
        raise
    kwargs = dict(symbol=session.symbol, side="S" if side == "SELL" else "B", qty=quantity,
        trigger_price=order.trigger_price, limit_price=order.limit_price,
        tag=order.broker_client_tag, product=key[1])
    if key[2]:
        kwargs.update(right=key[2], strike=key[3], expiry=key[4])
    method = broker.place_options_sl_order if key[2] else broker.place_sl_order
    try:
        order.kotak_order_id = await asyncio.to_thread(method, **kwargs)
    except Exception as exc:
        # SDK returned broker rejection is definite; transport/unknown outcome
        # must be found by its tag before another order is submitted.
        message = str(exc)
        definite = ("Not authenticated" in message or "session expired (unauthorized)" in message
                    or (message.startswith("Kotak API error:") and
                        bool(re.search(r"\(code (?:400|401|403)\)", message))))
        order.protection_submission = "failed" if definite else "unknown"
        order.protection_error = str(exc)
        if definite:
            order.status = OrderStatus.CANCELLED
            await asyncio.to_thread(_pending, claim, owner, order.broker_client_tag, remove=True)
        await _save(order)
        raise
    finally:
        invalidate(account)
    order.protection_submission = "accepted"
    session.kotak_order_map[order.order_id] = order.kotak_order_id
    # If this write fails, retain broker identity in memory and durable intent
    # in storage. Broker tag recovery restores the identity after restart.
    await _save(order)
    broker_order_service.register_callbacks(session, order, broker, asyncio.get_running_loop())
    _emit(session, {"type": "order_placed", **order.model_dump(mode="json")})
    logger.info("entry_protection_placed session=%s order=%s entries=%s quantity=%s", session.session_id,
                order.order_id, allocations, quantity)
    return order


async def _repair(session, broker, account, *, enroll_manual=False):
    from app.services import order_service, simulation
    orders = order_service.get_all_orders(session.session_id)
    if any(s.session_type == "real" and s.symbol == session.symbol and s.date == session.date
           and s.user_id != session.user_id for s in simulation._sessions.values()):
        raise ValueError("Protection ownership is ambiguous for this broker account and underlying")
    if enroll_manual:
        for order in orders:
            if order.source == "broker_external" and order.broker_filled_quantity and not order.protection_enrolled:
                order.protection_enrolled = True
                await _save(order)
    lots = _open_lots(session, orders)
    summaries = []
    positions = {contract_key(p): p for p in session.broker_positions}
    keys = set(positions) | {contract_key(o) for o in orders if o.source == "entry_protection"}
    for key in sorted(keys, key=repr):
        p = positions.get(key, {"quantity": 0, "side": "FLAT"})
        side = "SELL" if p["side"] == "LONG" else "BUY"
        held = p["quantity"] if p["side"] != "FLAT" else 0
        entries = [(qty, entry, price) for entry_side, qty, entry, price in lots[key]
                   if entry_side != side and entry is not None and
                   (entry.source != "broker_external" or entry.protection_enrolled)]
        # Carry positions have no today's entry executions. Enrol on explicit
        # refresh only, persisting an intent rather than inventing a trade.
        carry_quantity = max(0, held - sum(qty for entry_side, qty, entry, _ in lots[key] if entry is not None and entry_side != side))
        if enroll_manual and carry_quantity:
            intent_id = "manual-position:" + hashlib.sha256(repr(key).encode()).hexdigest()
            intent = order_service.get_order(session.session_id, intent_id)
            if intent is None:
                intent = Order(order_id=intent_id, session_id=session.session_id, user_id=session.user_id,
                    symbol=session.symbol, side=TradeSide.BUY if side == "SELL" else TradeSide.SELL,
                    quantity=carry_quantity, trigger_price=p["avg_entry_price"], limit_price=p["avg_entry_price"],
                    created_at=int(session.current_time or 0), status=OrderStatus.FILLED,
                    source="manual_position_intent", protection_enrolled=True,
                    broker_exchange=key[0], broker_product=key[1], right=key[2], strike=key[3], expiry=key[4])
                order_service._orders.setdefault(session.session_id, {})[intent_id] = intent
            intent.quantity = carry_quantity
            await _save(intent)
        for o in order_service.get_all_orders(session.session_id):
            if o.source == "manual_position_intent" and contract_key(o) == key and carry_quantity:
                entries.append((min(carry_quantity, o.quantity), o, p["avg_entry_price"]))
        monitored = min(held, sum(q for q, _, _ in entries))
        closing = [o for o in orders if contract_key(o) == key and o.side.value == side
                   and o.status == OrderStatus.PENDING and o.kotak_order_id
                   and o.protection_submission not in ("submitting", "unknown")]
        manual = [o for o in closing if o.source != "entry_protection"]
        managed = [o for o in closing if o.source == "entry_protection"]
        wrong_side = [o for o in orders if contract_key(o) == key and o.source == "entry_protection"
                      and o.kotak_order_id and o.status == OrderStatus.PENDING and o.side.value != side]
        manual_remaining = sum(max(0, o.quantity - o.broker_filled_quantity) for o in manual)
        # Manual broker exits take precedence. Never edit them automatically.
        budget = max(0, monitored - min(monitored, manual_remaining))
        if not held:
            managed = [o for o in orders if contract_key(o) == key and o.source == "entry_protection"
                       and o.status == OrderStatus.PENDING and o.kotak_order_id]
            budget = 0
            wrong_side = []
        owner = str(uuid.uuid4())
        # No distributed write or lease is needed for an idle contract.
        total_remaining = manual_remaining + sum(max(0, o.quantity - o.broker_filled_quantity) for o in managed)
        unknown_before = any(contract_key(o) == key and o.protection_submission in ("submitting", "unknown") for o in orders)
        if total_remaining >= monitored and sum(max(0, o.quantity - o.broker_filled_quantity) for o in managed) <= max(0, monitored - min(monitored, manual_remaining)) and not unknown_before and not wrong_side:
            summaries.append({"contract": list(key), "held": held, "covered": monitored, "missing": 0, "status": "covered", "manual_excess": max(0, manual_remaining - held)})
            continue
        confirmed = {o.broker_client_tag for o in orders if contract_key(o) == key
                     and o.broker_client_tag and o.protection_submission in ("accepted", "failed")}
        claim = await asyncio.to_thread(_claim, account, session, key, owner, confirmed)
        if claim is None:
            known_coverage = min(monitored, total_remaining)
            summaries.append({"contract": list(key), "held": held, "covered": known_coverage,
                              "missing": monitored - known_coverage, "status": "unknown" if unknown_before else "busy",
                              "manual_excess": max(0, manual_remaining - held)})
            continue
        try:
            await _verify_fresh(session, broker, key, held, side, orders)
            for o in wrong_side:
                await asyncio.to_thread(_renew, claim, owner)
                await asyncio.to_thread(broker.cancel_order, o.kotak_order_id)
                invalidate(account)
                o.status = OrderStatus.CANCELLED
                await _save(o)
                _emit(session, {"type": "order_cancelled", **o.model_dump(mode="json")})
            for o in sorted(managed, key=lambda o: (o.created_at, o.order_id)):
                remaining = max(0, o.quantity - o.broker_filled_quantity)
                wanted = min(remaining, budget)
                budget -= wanted
                if wanted < remaining:
                    await asyncio.to_thread(_renew, claim, owner)
                    if wanted:
                        total = o.broker_filled_quantity + wanted
                        method = broker.modify_sl_to_limit_order if o.order_type == OrderType.LIMIT else broker.modify_sl_order
                        args = (o.kotak_order_id, o.limit_price, total) if o.order_type == OrderType.LIMIT else (o.kotak_order_id, o.trigger_price, o.limit_price, total)
                        replacement = await asyncio.to_thread(method, *args)
                        o.quantity = total
                        if isinstance(replacement, str) and replacement and replacement != o.kotak_order_id:
                            from app.services.broker_order_service import register_callbacks
                            broker.deregister_fill_callback(o.kotak_order_id)
                            broker.deregister_reject_callback(o.kotak_order_id)
                            o.kotak_order_id = replacement
                            session.kotak_order_map[o.order_id] = replacement
                            register_callbacks(session, o, broker, asyncio.get_running_loop())
                    else:
                        await asyncio.to_thread(broker.cancel_order, o.kotak_order_id)
                        o.status = OrderStatus.CANCELLED
                    invalidate(account)
                    await _save(o)
                    _emit(session, {"type": "order_updated" if wanted else "order_cancelled", **o.model_dump(mode="json")})
            covered = min(monitored, manual_remaining + sum(max(0, o.quantity - o.broker_filled_quantity)
                for o in managed if o.status == OrderStatus.PENDING))
            unknown = [o for o in orders if contract_key(o) == key and o.protection_submission in ("submitting", "unknown")]
            gap = monitored - covered
            submitted = False
            if gap and not unknown:
                # Coverage is consumed once across entry lots, not per group.
                skip = covered
                from app.config import LOT_SIZES
                lot = LOT_SIZES.get(session.symbol, 1) if key[2] else 1
                for qty, entry, fill_price in entries:
                    used = min(skip, qty)
                    skip -= used
                    qty = min(qty - used, gap)
                    qty -= qty % lot
                    if not qty:
                        continue
                    price = entry.entry_sl_price
                    if price is None:
                        price = round(fill_price * (0.75 if side == "SELL" else 1.25), 2)
                    if not price or price <= 0:
                        raise ValueError("Cannot calculate a valid protection price")
                    for chunk in order_service.split_quantity(session.symbol, qty):
                        await asyncio.to_thread(_renew, claim, owner)
                        await _submit(session, broker, account, key, side, chunk, price, {entry.order_id: chunk}, claim, owner)
                        submitted = True
                        covered += chunk
                        gap -= chunk
            summaries.append({"contract": list(key), "held": held, "covered": covered,
                "missing": max(0, gap), "status": "unknown" if unknown else "awaiting_confirmation" if submitted else "covered" if not gap else "uncovered",
                "manual_excess": max(0, manual_remaining - held)})
        finally:
            await asyncio.to_thread(_release, claim, owner)
    return summaries


async def reconcile_now(session, broker=None, *, enroll_manual=False, refresh=True):
    state = _state(session)
    async with state.lock:
        summary = []
        owns_task = state.task is None or state.task.done()
        if owns_task:
            state.task = asyncio.current_task()
        try:
            summary = await _reconcile(session, broker, enroll_manual=enroll_manual, refresh=refresh)
            return summary
        finally:
            if owns_task:
                state.task = None
                if state.dirty or any(row["missing"] or row["status"] in ("busy", "unknown", "awaiting_confirmation") for row in summary):
                    state.dirty = False
                    request(session, delay=RECHECK_SECONDS, reason="changed_during_refresh", reset=False)


async def _reconcile(session, broker=None, *, enroll_manual=False, refresh=True):
    from app.services import kotak_service, real_broker_state
    if session.session_type != "real":
        return []
    broker = broker or kotak_service.get_service()
    state = _state(session)
    if state.timer:
        state.timer.cancel()
        state.timer = None
    account = await asyncio.to_thread(broker.account_identity)
    if getattr(session, "protection_account", account) != account:
        raise ValueError("Broker account changed; exit protection is paused")
    locks = _account_locks.setdefault(asyncio.get_running_loop(), {})
    async with locks.setdefault(account, asyncio.Lock()):
        if refresh:
            facts = await broker_facts(broker, account)
            await real_broker_state.refresh(session, broker, protection=False, wallet=False, facts=facts)
        if session.broker_refresh_events is not None:
            raise ValueError("Broker refresh is in progress")
        session.broker_refresh_events = []
        try:
            summary = await _repair(session, broker, account, enroll_manual=enroll_manual)
        finally:
            events, session.broker_refresh_events = session.broker_refresh_events, None
            for callback, args in events:
                callback(*args)
        session.protection_status = summary
        if summary != state.summary:
            _emit(session, {"type": "protection_status", "session_id": session.session_id, "protection": summary})
            logger.info("protection_status session=%s coverage=%s", session.session_id, summary)
            state.summary = summary
        return summary


async def _run(state):
    retry = False
    try:
        state.dirty = False
        summary = await reconcile_now(state.session)
        retry = any(row["missing"] or row["status"] in ("busy", "unknown", "awaiting_confirmation") for row in summary)
        if retry:
            state.failures += 1
        else:
            state.failures = 0
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        state.failures += 1
        retry = True
        record_failure(state.session, exc)
        _emit(state.session, {"type": "broker_error", "message": f"Real exit protection needs attention: {exc}"})
        logger.warning("protection_check_failed session=%s attempt=%s: %s", state.session.session_id, state.failures, exc)
    finally:
        state.task = None
    if _states.get(state.session.session_id) is not state:
        return
    if state.failures > 3:
        _emit(state.session, {"type": "broker_error", "message": "Exit protection remains unresolved. Refresh order history to retry."})
        return
    if retry or state.dirty:
        request(state.session, delay=RECHECK_SECONDS * (2 ** max(0, state.failures - 1)), reset=False, reason="recovery")
