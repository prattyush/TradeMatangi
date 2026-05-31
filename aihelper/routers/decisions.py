"""
GET /ai/session/{session_id}/decisions — returns LLM action decisions since a timestamp.
Step 4 (trade execution) populates this; Step 5 (decision visibility) wires the frontend.
"""
import logging
from fastapi import APIRouter, Query
from pydantic import BaseModel

from db import decision_log_store

logger = logging.getLogger("aihelper.routers.decisions")

router = APIRouter()


class DecisionItem(BaseModel):
    command_id: str
    command_text: str
    bar_time: str
    reason: str
    action: dict
    action_result: str
    timestamp: str


@router.get("/ai/session/{session_id}/decisions", response_model=list[DecisionItem])
async def get_decisions(
    session_id: str,
    since: str | None = Query(default=None, description="ISO timestamp — only return decisions after this"),
):
    """
    Returns AIDecisionLog entries for the session, ordered oldest-first.
    Frontend passes last_seen_ts as `since` to avoid re-fetching old entries.
    """
    logger.debug("get_decisions: session=%s since=%s", session_id, since)
    try:
        items = decision_log_store.get_decisions_since(session_id, since_ts=since)
    except Exception:
        logger.exception("Error fetching decisions for session %s", session_id)
        items = []
    return items
