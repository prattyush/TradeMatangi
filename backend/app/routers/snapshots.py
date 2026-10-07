import asyncio
import logging

from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.services import snapshot_service, analysis_sharing
from app.services.trade_label_service import _load_session
from app.dependencies import get_request_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/snapshots", tags=["snapshots"])


class SnapshotPayload(BaseModel):
    event_id: str
    session_id: str
    user_id: str = ""
    symbol: str = ""
    date: str = ""
    instrument_type: str = "equity"
    session_type: str = "sim"
    timestamp: float = 0
    event: dict = {}
    snapshot: dict = {}


@router.post("")
async def store_snapshot(data: SnapshotPayload, user_id: str = Depends(get_request_user_id)):
    """Store an event snapshot captured during a trading session."""
    session = await asyncio.to_thread(_load_session,data.session_id)
    if not session or session.get('user_id') != user_id:
        raise HTTPException(404,"Session not found")
    try:
        logger.info("Storing snapshot %s for session %s (event: %s)",
                     data.event_id, data.session_id, data.event.get("description", ""))
        d = {**data.model_dump(),"user_id":user_id}
        await asyncio.to_thread(snapshot_service.save_snapshot, data.session_id, d)
        return {"event_id": data.event_id, "status": "stored"}
    except Exception:
        logger.exception("Snapshot store failed for %s", data.event_id)
        raise HTTPException(status_code=500, detail="Failed to store snapshot")


@router.get("")
async def list_snapshots(session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    """List all event snapshots for a session, oldest first."""
    session = await asyncio.to_thread(_load_session,session_id)
    if not await asyncio.to_thread(analysis_sharing.can_read,session,user_id):
        raise HTTPException(404,"Session not found")
    try:
        return await asyncio.to_thread(snapshot_service.get_snapshots,session_id)
    except Exception as exc:
        raise HTTPException(503,"Recorded snapshots could not be read; retry later") from exc


@router.get("/{event_id}")
async def get_snapshot(event_id: str, session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    """Retrieve a single event snapshot."""
    session = await asyncio.to_thread(_load_session,session_id)
    if not await asyncio.to_thread(analysis_sharing.can_read,session,user_id):
        raise HTTPException(404,"Session not found")
    snap = await asyncio.to_thread(snapshot_service.get_snapshot, session_id, event_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return snap


@router.delete("")
async def delete_snapshots(session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    """Delete all event snapshots for a session."""
    session = await asyncio.to_thread(_load_session,session_id)
    if not session or session.get('user_id') != user_id:
        raise HTTPException(404,"Session not found")
    try:
        count = await asyncio.to_thread(snapshot_service.delete_snapshots,session_id)
        return {"deleted":count}
    except Exception as exc:
        raise HTTPException(503,"Recorded snapshots were not fully deleted; retry later") from exc
