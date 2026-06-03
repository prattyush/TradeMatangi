"""
Internal event injection endpoint — called only by the aihelper process (localhost).
Not exposed in public API docs.
"""
import json
import logging
from fastapi import APIRouter, HTTPException

from app.services import simulation as sim_svc

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/internal", tags=["internal"])


@router.post("/emit-event/{session_id}", status_code=200, include_in_schema=False)
async def emit_event(session_id: str, payload: dict):
    """
    Inject an arbitrary SSE event onto a session's queue.
    Used by aihelper to surface pattern alerts to the frontend.
    """
    session = sim_svc.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        session.queue.put_nowait(json.dumps(payload))
    except Exception:
        # Queue full or closed — drop silently; pattern alerts are non-critical
        logger.debug("emit_event: dropped event for session %s (queue full/closed)", session_id)
    return {"status": "ok"}
