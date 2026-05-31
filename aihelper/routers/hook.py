"""
Hook endpoints — called by the backend (not the frontend).

POST /hook/bar-close            — bar-close notification (fire-and-forget from backend)
POST /hook/session/{id}/stop   — synchronous session cancellation (backend awaits 200)
"""
import logging
from fastapi import APIRouter
from pydantic import BaseModel

import state
from processors.base import BarCloseHook
from db import commands_store

logger = logging.getLogger("aihelper.routers.hook")

router = APIRouter()


class SessionStopResponse(BaseModel):
    status: str
    cancelled: int


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

    # Fetch active AI commands for this session from DynamoDB
    try:
        commands = commands_store.get_active_commands_for_session(hook.session_id)
    except Exception:
        logger.exception("Error fetching active commands for session %s", hook.session_id)
        return {"status": "error", "commands": 0}

    if not commands:
        logger.debug("bar_close: no active commands for session %s — skipping", hook.session_id)
        return {"status": "no_commands", "commands": 0}

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

    logger.info("session_stop: cancelled %d command(s) for session %s", count, session_id)
    return SessionStopResponse(status="cancelled", cancelled=count)
