import asyncio
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from app.services import simulation as sim_svc
from app.models.schemas import SimulationState

router = APIRouter(prefix="/api/stream", tags=["stream"])

HEARTBEAT_INTERVAL = 15  # seconds


async def _event_generator(session_id: str):
    session = sim_svc.get_session(session_id)
    if not session:
        yield "data: {\"type\":\"error\",\"message\":\"Session not found\"}\n\n"
        return

    while True:
        try:
            # Wait for next event with timeout for heartbeat
            event = await asyncio.wait_for(session.queue.get(), timeout=HEARTBEAT_INTERVAL)
            yield f"data: {event}\n\n"

            # Stop streaming once the session has ended and queue is drained
            if '"type": "session_ended"' in event or '"type":"session_ended"' in event:
                break
        except asyncio.TimeoutError:
            # Heartbeat to keep connection alive through proxies
            yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            break


@router.get("/{session_id}")
async def stream_session(session_id: str):
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return StreamingResponse(
        _event_generator(session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
