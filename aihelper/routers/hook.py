"""
Hook endpoints — called by the backend (not the frontend).

POST /hook/bar-close            — bar-close notification (fire-and-forget from backend)
POST /hook/session/{id}/stop   — synchronous session cancellation (backend awaits 200)
"""
import asyncio
import logging
from fastapi import APIRouter
from pydantic import BaseModel

import state
from processors.base import BarCloseHook
from db import commands_store
from guardrails.validator import check_market_hours
from services.pattern_bar_store import PatternBarStore as _PatternBarStore

_LIVE_SESSION_TYPES = {"paper", "real"}

logger = logging.getLogger("aihelper.routers.hook")

router = APIRouter()


class SessionStopResponse(BaseModel):
    status: str
    cancelled: int


async def _run_pattern_detection(hook: BarCloseHook) -> None:
    """
    Accumulate bars and run pattern detection for the experimental feature.
    Fires pattern alerts back to the backend SSE stream.
    Always called via asyncio.create_task — never blocks the hook response or
    the command evaluation path.
    """
    from datetime import datetime, timezone as _tz
    from services.market_pattern_detector import (
        detect_all_market_patterns,
        detect_panic_behavior,
        detect_overtrading,
        count_trades_in_window,
        count_round_trips_in_window,
    )
    from services import backend_client

    # Check setting first; skip work when disabled
    try:
        settings = await backend_client.get_user_settings_cached(hook.user_id)
        if not settings.get("experimental_patterns_enabled"):
            return
    except Exception:
        return

    store = state.pattern_bar_store
    if store is None:
        return

    # Prefer underlying bars for CE/PE sessions (detect patterns on the index)
    bars_to_use = hook.underlying_bars if hook.underlying_bars else hook.bars
    store.append_bars(hook.session_id, hook.right, bars_to_use)

    bars = store.get_bars(hook.session_id, hook.right)
    if not bars:
        return

    detected = detect_all_market_patterns(bars)
    for result in detected:
        if not store.is_cooled_down(hook.session_id, hook.right, result.pattern):
            continue
        store.mark_fired(hook.session_id, hook.right, result.pattern)
        try:
            await backend_client.emit_pattern_alert(hook.session_id, result)
        except Exception as exc:
            logger.debug("Pattern alert emit failed for session %s: %s", hook.session_id, exc)

    # ── Behavioral patterns (panic / overtrading) ──────────────────────────────
    try:
        # Derive current Unix timestamp from the latest bar (IST-as-UTC encoding)
        current_ts = 0
        if hook.bars:
            try:
                dt = datetime.fromisoformat(hook.bars[-1].time)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=_tz.utc)
                current_ts = int(dt.timestamp())
            except Exception:
                pass

        # Track SL changes across bar closes
        open_orders = await backend_client.get_open_orders(hook.session_id)
        sl_order = next((o for o in open_orders if o.get("is_stoploss")), None)
        sl_price = float(sl_order["trigger_price"]) if sl_order else None
        sl_changes = store.record_sl_snapshot(hook.session_id, hook.right, sl_price)

        # Fetch session trades for count-based checks
        recent_trades = await backend_client.get_session_trades(hook.session_id)
        rapid_count = count_trades_in_window(recent_trades, current_ts, window_secs=600)

        panic = detect_panic_behavior(sl_changes, rapid_count)
        if panic.detected and store.is_cooled_down(hook.session_id, hook.right, "panic_behavior"):
            store.mark_fired(hook.session_id, hook.right, "panic_behavior")
            await backend_client.emit_pattern_alert(hook.session_id, panic)

        round_trips = count_round_trips_in_window(recent_trades, current_ts, window_secs=900)
        over = detect_overtrading(round_trips)
        if over.detected and store.is_cooled_down(hook.session_id, hook.right, "overtrading"):
            store.mark_fired(hook.session_id, hook.right, "overtrading")
            await backend_client.emit_pattern_alert(hook.session_id, over)
    except Exception as exc:
        logger.debug("Behavioral pattern detection failed for session %s: %s", hook.session_id, exc)


@router.post("/hook/bar-close", status_code=200)
async def bar_close(hook: BarCloseHook):
    """
    Receive a bar-close notification from the backend.
    Returns 200 immediately; LLM evaluation runs asynchronously via the processor.
    """
    logger.debug(
        "bar_close hook: session=%s symbol=%s right=%s bars=%d ts=%s",
        hook.session_id, hook.symbol, hook.right, len(hook.bars), hook.timestamp,
    )

    # ── Experimental pattern detection (fire-and-forget; runs regardless of commands) ──
    if isinstance(state.pattern_bar_store, _PatternBarStore):
        asyncio.create_task(_run_pattern_detection(hook))

    # Fetch active AI commands for this session from DynamoDB
    try:
        commands = commands_store.get_active_commands_for_session(hook.session_id)
    except Exception:
        logger.exception("Error fetching active commands for session %s", hook.session_id)
        return {"status": "error", "commands": 0}

    if not commands:
        logger.debug("bar_close: no active commands for session %s — skipping", hook.session_id)
        return {"status": "no_commands", "commands": 0}

    # Market-hours guardrail for live sessions (paper/real); simulation bypasses this
    if hook.session_type in _LIVE_SESSION_TYPES:
        ok, reason = check_market_hours()
        if not ok:
            logger.info(
                "bar_close: outside market hours (%s) for session %s — skipping",
                reason, hook.session_id,
            )
            return {"status": "outside_market_hours", "commands": 0}

    # Submit to pluggable processor (returns immediately; evaluation is async)
    if state.processor is not None:
        await state.processor.submit(hook, commands)
        logger.debug(
            "bar_close: submitted %d command(s) to %s for session %s",
            len(commands), type(state.processor).__name__, hook.session_id,
        )
    else:
        logger.warning("bar_close: processor not initialised — dropping hook for session %s", hook.session_id)

    return {"status": "received", "commands": len(commands)}


@router.post("/hook/session/{session_id}/stop", response_model=SessionStopResponse)
async def session_stop(session_id: str):
    """
    Synchronous session cancellation — backend awaits this 200 before completing stop_session().
    Cancels all active AICommands for the session and clears the processor queue.
    """
    logger.info("session_stop hook: session=%s", session_id)

    # Cancel all active commands in DynamoDB
    try:
        count = commands_store.cancel_commands_for_session(session_id, reason="session_ended")
    except Exception:
        logger.exception("Error cancelling commands for session %s", session_id)
        count = 0

    # Drain the processor queue for this session so no in-flight evaluations proceed
    if state.processor is not None:
        try:
            state.processor.clear_session(session_id)
        except Exception:
            logger.exception("Error clearing processor queue for session %s", session_id)

    # Clear accumulated pattern bar history for this session
    if state.pattern_bar_store is not None:
        try:
            state.pattern_bar_store.clear_session(session_id)
        except Exception:
            logger.exception("Error clearing pattern bar store for session %s", session_id)

    logger.info("session_stop: cancelled %d command(s) for session %s", count, session_id)
    return SessionStopResponse(status="cancelled", cancelled=count)
