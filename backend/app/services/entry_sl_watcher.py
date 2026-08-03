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

  Real-mode partial-fill handling:
    For real (Kotak) sessions, fills may arrive in multiple partial events
    over several seconds. The watcher starts a configurable delay timer on
    the first fill within a group. Subsequent fills in the same group reset
    the timer. When the timer fires, it queries the cumulative filled
    quantity for that group and places a single SL order.
"""
from __future__ import annotations

import logging
import threading
import time as _time
from typing import Any

logger = logging.getLogger(__name__)

_IST_OFFSET = 19800

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
    if order.entry_sl_price is None:
        return

    try:
        from app.services.user_settings_service import get_settings
        settings = get_settings(order.user_id)
        if not settings.get("entry_auto_sl_enabled", False):
            return
    except Exception:
        return

    session_type = getattr(session, "session_type", "sim")

    if session_type == "real":
        delay = 3
        try:
            from app.services.user_settings_service import get_settings
            settings = get_settings(order.user_id)
            delay = settings.get("entry_auto_sl_delay_sec", 3)
        except Exception:
            pass
        _schedule_delayed_sl(order, session, delay, loop)
    else:
        _place_sl_immediately(order, session)


def _place_sl_immediately(order: Any, session: Any) -> None:
    from app.models.schemas import TradeSide, OrderType

    sl_side = TradeSide.SELL if order.side == "BUY" else TradeSide.BUY

    try:
        from app.services.order_service import place_order

        ts = int(_time.time()) + _IST_OFFSET
        place_order(
            session_id=session.session_id,
            symbol=session.symbol,
            side=sl_side,
            order_type=OrderType.STOPLOSS,
            quantity=order.quantity,
            created_at=ts,
            trading_date=session.date,
            trigger_price=order.entry_sl_price,
            is_stoploss=True,
            right=getattr(order, "right", None),
            strike=getattr(order, "strike", None),
            group_id=getattr(order, "group_id", None),
            user_id=getattr(order, "user_id", "00000000-0000-0000-0000-000000000001"),
        )
        logger.info(
            "EntryStoplossWatcher: placed SL %s qty=%d trigger=%.2f group=%s",
            sl_side, order.quantity, order.entry_sl_price,
            getattr(order, "group_id", None),
        )
    except Exception as exc:
        logger.warning(
            "EntryStoplossWatcher: SL placement failed for order %s: %s",
            getattr(order, "order_id", "?"), exc,
        )


def _schedule_delayed_sl(
    order: Any, session: Any, delay_sec: float, loop: Any = None,
) -> None:
    group_id = getattr(order, "group_id", None)
    if group_id is None:
        _place_sl_immediately(order, session)
        return

    _cancel_pending_timer(group_id)

    def _fire():
        try:
            _cancel_pending_timer(group_id)
            total_qty = _get_group_filled_qty(order.session_id, group_id)
            if total_qty == 0:
                logger.info(
                    "EntryStoplossWatcher: timer fired for group=%s but no filled qty found",
                    group_id,
                )
                return
            order.quantity = total_qty
            _place_sl_immediately(order, session)
        except Exception as exc:
            logger.warning(
                "EntryStoplossWatcher: delayed SL placement failed for group=%s: %s",
                group_id, exc,
            )

    timer = threading.Timer(delay_sec, _fire)
    with _timers_lock:
        _pending_real_timers[group_id] = timer
    timer.start()
    logger.info(
        "EntryStoplossWatcher: scheduled SL in %.0fs for group=%s (qty so far=%d)",
        delay_sec, group_id, order.quantity,
    )


def _get_group_filled_qty(session_id: str, group_id: str) -> int:
    from app.services.order_service import get_all_orders
    total = 0
    for o in get_all_orders(session_id):
        if getattr(o, "group_id", None) == group_id and getattr(o, "status", "") == "FILLED":
            total += o.quantity
    return total


def cancel_pending_for_group(group_id: str) -> None:
    _cancel_pending_timer(group_id)
