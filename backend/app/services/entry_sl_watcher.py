"""
Auto-stoploss-on-entry watcher service.

Architecture:
  EntryStoplossWatcher is a passive observer that hooks into order-fill events.
  When an entry order with a non-None `entry_sl_price` fills, the watcher
  automatically places a matching STOPLOSS exit order for the filled quantity.

  This works like a background strategy — zero polling, event-driven.
  The simulation loop triggers `on_entry_filled()` after `check_orders()`
  returns filled orders, and the real-mode Kotak fill callback triggers it
  after broker-confirmed fills.

  Kotak real-options fills are delegated to the event-driven account protection
  manager. Its leading-edge delay coalesces bursts without indefinitely delaying
  protection, and FIFO allocations prevent one entry borrowing another's exits.
  Paper/replay placement remains immediate and does not use broker reports.
"""
from __future__ import annotations

import logging
import threading
import time as _time
from typing import Any

logger = logging.getLogger(__name__)

_IST_OFFSET = 19800
_AUTOSTOP_FALLBACK_SL_PCT = 0.25

_pending_real_timers: dict[str, threading.Timer] = {}
_timers_lock = threading.Lock()


def _cancel_pending_timer(group_id: str) -> None:
    with _timers_lock:
        timer = _pending_real_timers.pop(group_id, None)
    if timer is not None:
        timer.cancel()


def on_entry_filled(
    order: Any,
    session: Any,
    loop: Any = None,
) -> None:
    is_autostop = bool(getattr(order, "is_autostop", False))
    if order.entry_sl_price is None and not is_autostop:
        return

    # Entry protection is always enabled. The retired account switch cannot
    # suppress a requested SL in any client or trading mode. Orders without an
    # attached SL still return above, except AutoStop's existing fallback.
    # Real sessions retain their configured delay.

    session_type = getattr(session, "session_type", "sim")

    if session_type == "real":
        if getattr(session, "execution_broker", "KotakNeo") in ("Kite", "kite"):
            from app.services.user_settings_service import get_settings
            delay = get_settings(order.user_id).get('entry_auto_sl_delay_sec', 3)
            _schedule_delayed_sl(order, session, delay, loop)
            return
        from app.services.kotak_automation_policy import enabled as permitted
        if not permitted(session.user_id):
            return
        from app.services.kotak_protection import enabled, request
        delay = 3
        try:
            from app.services.user_settings_service import get_settings
            settings = get_settings(order.user_id)
            delay = settings.get("entry_auto_sl_delay_sec", 3)
        except Exception:
            pass
        if enabled(session):
            request(session, reason="entry_fill", delay=delay)
        else:
            _schedule_delayed_sl(order, session, delay, loop)
    else:
        _place_sl_immediately(order, session)


def _place_sl_immediately(order: Any, session: Any) -> None:
    from app.models.schemas import TradeSide, OrderType
    if getattr(session, "session_type", None) == "real":
        _place_real_protection(order, session)
        return

    side_value = getattr(order.side, "value", order.side)
    sl_side = TradeSide.SELL if side_value == TradeSide.BUY.value else TradeSide.BUY
    sl_price = getattr(order, "entry_sl_price", None)
    if sl_price is None:
        fill_price = getattr(order, "filled_price", None)
        if fill_price is None or fill_price <= 0:
            logger.warning(
                "EntryStoplossWatcher: cannot calculate AutoStop fallback for order %s without fill price",
                getattr(order, "order_id", "?"),
            )
            return
        sl_price = round(
            fill_price * (1 - _AUTOSTOP_FALLBACK_SL_PCT)
            if side_value == TradeSide.BUY.value
            else fill_price * (1 + _AUTOSTOP_FALLBACK_SL_PCT),
            2,
        )

    try:
        from app.services.order_service import place_order

        ts = int(_time.time()) + _IST_OFFSET
        ledger_id = getattr(session, "wallet_ledger_id", "")
        ledger_kind = "paper" if getattr(session, "session_type", None) == "paper" else "real" if getattr(session, "session_type", None) == "real" else "sim"
        place_order(
            session_id=session.session_id,
            symbol=session.symbol,
            side=sl_side,
            order_type=OrderType.STOPLOSS,
            quantity=order.quantity,
            created_at=ts,
            trading_date=session.date,
            trigger_price=sl_price,
            is_stoploss=True,
            right=getattr(order, "right", None),
            strike=getattr(order, "strike", None),
            expiry=getattr(order, "expiry", None),
            group_id=getattr(order, "group_id", None),
            user_id=getattr(order, "user_id", "00000000-0000-0000-0000-000000000001"),
            margin_rate=getattr(order, "reservation_margin_rate", 1.0),
            source=getattr(order, "source", None),
            wallet_ledger_id=ledger_id or None,
            wallet_ledger_kind=ledger_kind if ledger_id else None,
        )
        logger.info(
            "EntryStoplossWatcher: placed SL %s qty=%d trigger=%.2f group=%s",
            sl_side, order.quantity, sl_price,
            getattr(order, "group_id", None),
        )
    except Exception as exc:
        logger.warning(
            "EntryStoplossWatcher: SL placement failed for order %s: %s",
            getattr(order, "order_id", "?"), exc,
        )


def _schedule_delayed_sl(order, session, delay_sec, loop=None):
    import asyncio
    if loop is None:
        loop = asyncio.get_running_loop()
    group_id = getattr(order, "group_id", None) or order.order_id
    key = f"{session.session_id}:{group_id}"
    if getattr(session, 'execution_broker', None) in ('Kite', 'kite'):
        with _timers_lock:
            if key in _pending_real_timers:
                return  # Leading-edge delay: repeated fills cannot postpone protection forever.
    _cancel_pending_timer(key)

    def fire():
        _cancel_pending_timer(key)
        if not loop.is_closed():
            loop.call_soon_threadsafe(_place_sl_immediately, order, session)

    timer = threading.Timer(max(0, float(delay_sec)), fire)
    timer.daemon = True
    with _timers_lock:
        _pending_real_timers[key] = timer
    timer.start()


def _place_real_protection(order, session):
    if getattr(session, "execution_broker", "KotakNeo") in ("Kite", "kite"):
        _place_legacy_real_protection(order, session)
        return
    from app.services.kotak_automation_policy import enabled as permitted
    if not permitted(session.user_id):
        return
    from app.services.kotak_protection import enabled, request
    if enabled(session):
        request(session, reason="entry_fill", delay=0)
    elif getattr(session, "execution_broker", "KotakNeo") == "KotakNeo":
        _place_legacy_real_protection(order, session)


def _place_legacy_real_protection(order, session):
    import asyncio
    import json
    import uuid
    from app.models.schemas import TradeSide, OrderType, OrderStatus
    from app.services import order_service, simulation, trading
    if getattr(session, "broker_refresh_events", None) is not None or getattr(session, "_protection_recovery_busy", False):
        _schedule_delayed_sl(order, session, 1, asyncio.get_running_loop())
        return
    group = order.group_id or order.order_id
    entries = [o for o in order_service.get_all_orders(session.session_id)
               if (o.group_id or o.order_id) == group and o.execution_role != "exit"
               and (o.right, o.strike, o.expiry, o.side) == (order.right, order.strike, order.expiry, order.side)]
    quantity = sum(o.broker_filled_quantity or (o.quantity if o.kotak_fill_confirmed else 0) for o in entries)
    if not quantity:
        return
    position = trading.get_position(session.session_id, session.symbol, order.right, order.strike, order.expiry)
    exit_side = TradeSide.SELL if order.side == TradeSide.BUY else TradeSide.BUY
    if position.side != ("LONG" if exit_side == TradeSide.SELL else "SHORT"):
        return
    held = position.quantity
    protected = sum(max(0, o.quantity - o.broker_filled_quantity) for o in order_service.get_open_orders(session.session_id)
                    if o.execution_role == "exit" and o.broker_order_id and o.side == exit_side
                    and (o.right, o.strike, o.expiry) == (order.right, order.strike, order.expiry))
    allocation_offset = protected
    if getattr(session, "execution_broker", None) in ("Kite", "kite"):
        # Submitted protection, even if later cancelled, consumes the requested
        # entry coverage. New partial fills can add only newly confirmed units.
        allocated = sum(o.quantity for o in order_service.get_all_orders(session.session_id)
                        if (o.group_id or o.order_id) == group and o.execution_role == "exit"
                        and (o.broker_order_id or o.recovery_state in ("submitting", "unknown")))
        allocation_offset = allocated
        quantity = max(0, min(quantity - allocated, held - protected))
    else:
        quantity = max(0, min(quantity, held) - protected)
    if not quantity:
        return
    sl_price = order.entry_sl_price
    if sl_price is None:
        sl_price = round(order.filled_price * (1 - _AUTOSTOP_FALLBACK_SL_PCT if order.side == TradeSide.BUY else 1 + _AUTOSTOP_FALLBACK_SL_PCT), 2)
    chunks = order_service.split_quantity(session.symbol, quantity) if order.right else [quantity]
    for index, chunk in enumerate(chunks):
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, f"protection:{session.session_id}:{group}:{allocation_offset}:{index}"))
        existing = order_service.get_order(session.session_id, identifier)
        if existing and existing.broker_order_id:
            continue
        protective = existing
        try:
            if protective is None or protective.status == OrderStatus.CANCELLED:
                protective = order_service.place_order(session_id=session.session_id, symbol=session.symbol,
                    side=exit_side, order_type=OrderType.STOPLOSS, quantity=chunk,
                    created_at=int(session.current_time or 0), trading_date=session.date, trigger_price=sl_price,
                    is_stoploss=True, right=order.right, strike=order.strike, expiry=order.expiry,
                    group_id=group, user_id=session.user_id, source="entry_protection", order_id=identifier,
                    wallet_ledger_id=getattr(session, "wallet_ledger_id", None), wallet_ledger_kind="real")
            simulation._register_kotak_sl_for_order(session, protective, asyncio.get_running_loop())
            session.queue.put_nowait(json.dumps({"type": "order_placed", **protective.model_dump(mode="json")}))
            logger.info("entry_protection_placed session=%s entry=%s order=%s quantity=%d", session.session_id, order.order_id, identifier, chunk)
        except Exception as exc:
            if protective and not protective.broker_order_id and protective.recovery_state not in ("submitting", "unknown"):
                order_service.cancel_order(session.session_id, protective.order_id, session.date)
            session.queue.put_nowait(json.dumps({"type": "broker_error", "message": f"Entry filled, but broker stoploss placement failed: {exc}"}))
            logger.warning("entry_protection_failed session=%s entry=%s: %s", session.session_id, order.order_id, exc)
            # Retain entry intent. Refresh/restart and subsequent fills retry uncovered quantity.
            return


def _get_group_filled_qty(session_id: str, group_id: str) -> int:
    from app.services.order_service import get_all_orders
    total = 0
    for o in get_all_orders(session_id):
        if getattr(o, "group_id", None) == group_id and getattr(o, "status", "") == "FILLED":
            total += o.quantity
    return total


def cancel_pending_for_group(group_id: str) -> None:
    with _timers_lock:
        keys = [key for key in _pending_real_timers if key == group_id or key.endswith(":" + group_id)]
    for key in keys:
        _cancel_pending_timer(key)
