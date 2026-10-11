"""Paper broker-held exits: durable DAY windows, evidence-only recovery and renewal.

This service never evaluates application entries or strategies at old prices.
A renewed attempt begins when the online engine sees the contract's current quote.
"""

from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from math import isfinite
import time
from app.models.schemas import TradeSide, OrderType, OrderStatus


def current_market_timestamp():
    return int(
        datetime.now(ZoneInfo("Asia/Kolkata")).replace(tzinfo=timezone.utc).timestamp()
    )


def initial_attempt(timestamp, order=None):
    window = day_window(timestamp)
    if not window:
        return None
    return {
        **(instructions(order) if order is not None else {}),
        "date": window["date"],
        "start": timestamp,
        "end": window["closing"],
        "checked_until": timestamp - 1,
        "state": "live",
    }


def day_window(timestamp):
    from app.config import MARKET_OPEN, get_market_close
    from app.utils import is_trading_day

    date = datetime.fromtimestamp(timestamp, timezone.utc).date()
    if not is_trading_day(date):
        return None
    stamp = lambda clock: int(
        datetime.fromisoformat(date.isoformat() + "T" + clock)
        .replace(tzinfo=timezone.utc)
        .timestamp()
    )
    opening, closing = stamp(MARKET_OPEN), stamp(get_market_close(date.isoformat()))
    return (
        {"date": date.isoformat(), "opening": opening, "closing": closing}
        if opening <= timestamp < closing
        else None
    )


def broker_owned(order):
    return order.side == TradeSide.SELL and order.order_type in (
        OrderType.LIMIT,
        OrderType.STOPLOSS,
    )


def start_attempt(order, timestamp):
    from app.services.order_service import _write_order_to_db

    window = day_window(timestamp)
    if not broker_owned(order) or not window:
        return False
    if order.swing_attempts and order.swing_attempts[-1]["date"] == window["date"]:
        return False
    order.swing_attempts.append(initial_attempt(timestamp, order))
    _write_order_to_db(order, strict=True)
    return True


def observations(order, date, start, end):
    """Only native observed seconds establish chronological executable evidence."""
    from app.services.desktop_preparation import _load, observed_frame
    from app.services.historical_data_service import historical_operation

    with historical_operation(mode="live"):
        result = _load(order.symbol, date, order.strike, order.expiry, order.right)
    if (
        result.interval_seconds != 1
        or result.frame.attrs.get("native_interval_seconds") != 1
        or "observed" not in result.frame
    ):
        raise ValueError("Native observed second history is unavailable")
    index = result.frame.index
    index = (
        index.tz_localize("UTC") if index.tzinfo is None else index.tz_convert("UTC")
    )
    if (
        len(index) == 0
        or int(index.min().timestamp()) > start
        or int(index.max().timestamp()) < end
    ):
        raise ValueError("History does not cover the valid attempt window")
    frame = observed_frame(result, date)
    ticks = []
    for stamp, row in frame.iterrows():
        timestamp = int(stamp.timestamp())
        if timestamp < start or timestamp > end:
            continue
        price = float(row["close"])
        if not isfinite(price) or price <= 0:
            raise ValueError("Invalid observed execution price")
        ticks.append(
            {
                "type": "tick",
                "time": timestamp,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
                "right": order.right,
                "strike": order.strike,
                "expiry": order.expiry,
            }
        )
    return ticks


def recover_order(session, order, timestamp, loader=observations):
    """Reconcile only previously active windows. No attempts during offline days."""
    from app.services import order_service, simulation

    if (
        not broker_owned(order) and not order.swing_attempts
    ) or order.status != OrderStatus.PENDING:
        return True
    for attempt in order.swing_attempts:
        if attempt["state"] != "live":
            continue
        start = int(attempt["checked_until"]) + 1
        end = min(timestamp - 1, int(attempt["end"]) - 1)
        if end >= start:
            try:
                ticks = list(loader(order, attempt["date"], start, end))
                previous = start - 1
                for tick in ticks:
                    observed = int(tick["time"])
                    if (
                        not start <= observed <= end
                        or observed <= previous
                        or not isfinite(float(tick["close"]))
                        or float(tick["close"]) <= 0
                    ):
                        raise ValueError(
                            "History is not chronological execution evidence"
                        )
                    previous = observed
            except Exception:
                order.swing_reconcile_pending = True
                order.swing_reconcile_reason = (
                    "Valid DAY history is incomplete; no fill or renewal was invented"
                )
                order_service._write_order_to_db(order, strict=True)
                return False
            order.swing_reconcile_pending = False
            order.swing_reconcile_reason = None
            previous_instructions = instructions(order)
            for field in ("quantity", "trigger_price", "limit_price", "order_type"):
                if field in attempt:
                    setattr(
                        order,
                        field,
                        OrderType(attempt[field])
                        if field == "order_type"
                        else attempt[field],
                    )
            if (
                attempt is not order.swing_attempts[-1]
                and "stop_triggered_at" in attempt
            ):
                order.stop_triggered_at = attempt["stop_triggered_at"]
            original_date = session.date
            original_recovery = getattr(session, "swing_historical_recovery", False)
            session.swing_historical_recovery = True
            try:
                session.date = attempt["date"]
                for tick in ticks:
                    simulation._emit_tick_and_check_orders(
                        session,
                        tick,
                        order.right,
                        only_order_id=order.order_id,
                        historical_broker_recovery=True,
                    )
                    if order.status == OrderStatus.FILLED:
                        attempt["state"] = "filled"
                        order_service._write_order_to_db(order, strict=True)
                        return True
            finally:
                session.date = original_date
                session.swing_historical_recovery = original_recovery
                if order.status != OrderStatus.FILLED:
                    for field, value in previous_instructions.items():
                        if (
                            field == "stop_triggered_at"
                            and attempt is order.swing_attempts[-1]
                        ):
                            continue
                        setattr(
                            order,
                            field,
                            OrderType(value) if field == "order_type" else value,
                        )
            attempt["checked_until"] = end
        if timestamp >= attempt["end"]:
            attempt["state"] = "expired"
        order.swing_reconcile_pending = False
        order.swing_reconcile_reason = None
        order_service._write_order_to_db(order, strict=True)
    return True


def before_quote(session, event, *, loader=None):
    """Recover old broker ownership before current-price application evaluation."""
    from app.services import order_service

    loader = loader or observations
    now = int(event["time"])
    reconnect = getattr(session, "swing_recovery_required", False)
    retry = getattr(session, "swing_recovery_retry", {})
    for order in list(order_service.get_open_orders(session.session_id)):
        if not broker_owned(order) and not order.swing_attempts:
            continue
        active = next(
            (a for a in reversed(order.swing_attempts) if a["state"] == "live"), None
        )
        needs_recovery = active and (
            reconnect
            or any(
                a["state"] == "live" and now >= a["end"] for a in order.swing_attempts
            )
            or order.swing_reconcile_pending
        )
        if needs_recovery:
            if order.swing_reconcile_pending and time.monotonic() < retry.get(
                order.order_id, 0
            ):
                continue
            if not recover_order(session, order, now, loader):
                retry[order.order_id] = time.monotonic() + 60
                continue
        if order.status != OrderStatus.PENDING:
            continue
        if (order.right, order.strike, order.expiry) != (
            event.get("right"),
            event.get("strike"),
            event.get("expiry"),
        ):
            continue
        start_attempt(order, now)
    session.swing_recovery_retry = retry
    session.swing_recovery_required = False


def after_quote(session, event):
    from app.services import order_service

    now = int(event["time"])
    for order in order_service.get_all_orders(session.session_id):
        if (
            not broker_owned(order)
            or not order.swing_attempts
            or order.swing_reconcile_pending
        ):
            continue
        if (order.right, order.strike, order.expiry) != (
            event.get("right"),
            event.get("strike"),
            event.get("expiry"),
        ):
            continue
        attempt = order.swing_attempts[-1]
        if not attempt["start"] <= now < attempt["end"]:
            continue
        if order.status == OrderStatus.FILLED:
            attempt["state"] = "filled"
        elif order.status == OrderStatus.CANCELLED:
            attempt["state"] = "cancelled"
        attempt["checked_until"] = now
        # In-memory watermark updates every quote; durable checkpoints are paced.
        checkpoints = getattr(session, "swing_attempt_checkpoints", {})
        if attempt["state"] != "live" or now - checkpoints.get(order.order_id, 0) >= 60:
            order_service._write_order_to_db(order, strict=True)
            checkpoints[order.order_id] = now
        session.swing_attempt_checkpoints = checkpoints


async def before_quote_async(session, event):
    """Fetch history off the event loop; mutate the execution book on its owner loop."""
    import asyncio
    from app.services import order_service

    now = int(event["time"])
    reconnect = getattr(session, "swing_recovery_required", False)
    retry = getattr(session, "swing_recovery_retry", {})
    evidence = {}
    for order in list(order_service.get_open_orders(session.session_id)):
        if not broker_owned(order) and not order.swing_attempts:
            continue
        if order.swing_reconcile_pending and time.monotonic() < retry.get(
            order.order_id, 0
        ):
            continue
        needed = (
            reconnect
            or order.swing_reconcile_pending
            or any(
                a["state"] == "live" and now >= a["end"] for a in order.swing_attempts
            )
        )
        if not needed:
            continue
        for attempt in order.swing_attempts:
            if attempt["state"] != "live":
                continue
            start = int(attempt["checked_until"]) + 1
            end = min(now - 1, int(attempt["end"]) - 1)
            if end < start:
                continue
            key = (order.order_id, attempt["date"], start, end)
            try:
                evidence[key] = await asyncio.to_thread(
                    observations, order, attempt["date"], start, end
                )
            except Exception as exc:
                evidence[key] = exc

    def loaded(order, date, start, end):
        result = evidence[(order.order_id, date, start, end)]
        if isinstance(result, Exception):
            raise result
        return result

    before_quote(session, event, loader=loaded)


def instructions(order):
    return {
        "order_type": order.order_type.value,
        "quantity": order.quantity,
        "trigger_price": order.trigger_price,
        "limit_price": order.limit_price,
        "stop_triggered_at": order.stop_triggered_at,
    }


def require_amendable(order):
    if order.trading_style != "swing":
        return
    from fastapi import HTTPException
    from app.services.simulation import get_session

    session = get_session(order.session_id)
    if getattr(session, "swing_historical_recovery", False) is True:
        return
    if order.swing_reconcile_pending or (
        order.swing_attempts and getattr(session, "swing_recovery_required", False)
    ):
        raise HTTPException(
            409,
            "Reconcile the existing Paper DAY attempt before changing its instructions",
        )


def amend_attempt(order):
    """An edit starts a new attempt; old valid windows retain their actual terms."""
    if order.trading_style != "swing" or not order.swing_attempts:
        return
    from app.services.simulation import get_session

    if (
        getattr(get_session(order.session_id), "swing_historical_recovery", False)
        is True
    ):
        return
    latest = order.swing_attempts[-1]
    if all(
        latest.get(key, value) == value
        for key, value in instructions(order).items()
        if key != "stop_triggered_at"
    ):
        return
    from app.services.simulation import get_session

    session = get_session(order.session_id)
    now = (
        max(
            current_market_timestamp(),
            int(getattr(session, "current_time", 0) or 0),
            int(latest["start"]),
        )
        + 1
    )
    latest["stop_triggered_at"] = order.stop_triggered_at
    if (
        latest.get("order_type") != order.order_type.value
        and order.order_type == OrderType.STOPLOSS
    ):
        order.stop_triggered_at = None
    if latest["state"] == "live":
        latest["end"] = min(latest["end"], now)
    if broker_owned(order):
        attempt = initial_attempt(now, order)
        if attempt:
            order.swing_attempts.append(attempt)
