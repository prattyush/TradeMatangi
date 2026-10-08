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
        from app.services.kotak_protection import enabled, request
        if not enabled(session):
            return
        delay = 3
        try:
            from app.services.user_settings_service import get_settings
            settings = get_settings(order.user_id)
            delay = settings.get("entry_auto_sl_delay_sec", 3)
        except Exception:
            pass
        request(session, reason="entry_fill", delay=delay)
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
    from app.services.kotak_protection import request
    request(session, reason="entry_fill", delay=0)


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
