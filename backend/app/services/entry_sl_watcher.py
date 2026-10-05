"""Entry stop-loss observer.

Practice modes retain their immediate local watcher. Real fills wake the single
session recovery timer in real_protection, which checks fresh broker facts for
all exact contracts and stops when broker exit coverage is confirmed.
"""
from __future__ import annotations

import logging
import time as _time
from typing import Any

logger = logging.getLogger(__name__)

_IST_OFFSET = 19800
_AUTOSTOP_FALLBACK_SL_PCT = 0.25
_DESKTOP_ENTRY_SOURCES = {"desktop_stepwise", "desktop_replay", "desktop_paper"}

def on_entry_filled(
    order: Any,
    session: Any,
    loop: Any = None,
) -> None:
    if getattr(session, "session_type", None) == "real":
        from app.services.real_protection import request
        try:
            from app.services.user_settings_service import get_settings
            delay = get_settings(order.user_id).get("entry_auto_sl_delay_sec", 3)
        except Exception:
            delay = 3
        request(session, order=order, delay=delay, reason="entry_fill")
        return

    is_autostop = bool(getattr(order, "is_autostop", False))
    if order.entry_sl_price is None and not is_autostop:
        return

    explicit_desktop_sl = getattr(order, "source", None) in _DESKTOP_ENTRY_SOURCES
    if getattr(session, "session_type", None) != "real" and not explicit_desktop_sl and not is_autostop:
        try:
            from app.services.user_settings_service import get_settings
            settings = get_settings(order.user_id)
            if not settings.get("entry_auto_sl_enabled", False):
                return
        except Exception:
            return

    _place_sl_immediately(order, session)


def _place_sl_immediately(order: Any, session: Any) -> None:
    from app.models.schemas import TradeSide, OrderType
    if getattr(session, "session_type", None) == "real":
        from app.services.real_protection import request
        request(session, order=order, delay=0, reason="entry_fill")
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
