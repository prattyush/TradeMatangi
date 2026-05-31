"""
Hook endpoints — called by the backend (not the frontend).

POST /hook/bar-close   — fire-and-forget bar-close notification
POST /hook/session/{session_id}/stop — synchronous session cancellation
"""
import logging
from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel

from processors.base import BarCloseHook
from db import commands_store

logger = logging.getLogger("aihelper.routers.hook")

router = APIRouter()


class SessionStopResponse(BaseModel):
    status: str
    cancelled: int


@router.post("/hook/bar-close", status_code=200)
async def bar_close(hook: BarCloseHook, background_tasks: BackgroundTasks):
    """
    Receive bar-close notification from backend.
    Returns 200 immediately; evaluation runs asynchronously (Step 2 wires processor).
    """
    logger.debug(
        "bar_close hook: session=%s symbol=%s ts=%s",
        hook.session_id, hook.symbol, hook.timestamp,
    )
    # Step 2: fetch active commands and submit to processor
    # Placeholder: just ack
    return {"status": "received"}


@router.post("/hook/session/{session_id}/stop", response_model=SessionStopResponse)
async def session_stop(session_id: str):
    """
    Synchronous session cancellation — backend awaits this before completing stop_session().
    Cancels all active AICommands for the session and clears in-flight processor queue.
    """
    logger.info("session_stop hook: session=%s", session_id)
    try:
        count = commands_store.cancel_commands_for_session(session_id, reason="session_ended")
    except Exception:
        logger.exception("Error cancelling commands for session %s", session_id)
        count = 0

    # Step 2: also call processor.clear_session(session_id)
    return SessionStopResponse(status="cancelled", cancelled=count)
