import logging

from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel

from app.services import snapshot_service
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
async def store_snapshot(data: SnapshotPayload):
    """Store an event snapshot captured during a trading session."""
    try:
        logger.info("Storing snapshot %s for session %s (event: %s)",
                     data.event_id, data.session_id, data.event.get("description", ""))
        d = data.model_dump()
        snapshot_service.save_snapshot(data.session_id, d)
        return {"event_id": data.event_id, "status": "stored"}
    except Exception:
        logger.exception("Snapshot store failed for %s", data.event_id)
        raise HTTPException(status_code=500, detail="Failed to store snapshot")


@router.get("")
async def list_snapshots(session_id: str = Query(...)):
    """List all event snapshots for a session, oldest first."""
    snaps = snapshot_service.get_snapshots(session_id)
    return snaps


@router.get("/{event_id}")
async def get_snapshot(event_id: str, session_id: str = Query(...)):
    """Retrieve a single event snapshot."""
    snap = snapshot_service.get_snapshot(session_id, event_id)
    if snap is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    return snap


@router.delete("")
async def delete_snapshots(session_id: str = Query(...)):
    """Delete all event snapshots for a session."""
    count = snapshot_service.delete_snapshots(session_id)
    return {"deleted": count}
