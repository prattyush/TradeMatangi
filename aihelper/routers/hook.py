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
    from services.market_pattern_detector import detect_all_market_patterns
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
