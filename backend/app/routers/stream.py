import asyncio
from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from app.services import simulation as sim_svc

router = APIRouter(prefix="/api/stream", tags=["stream"])

HEARTBEAT_INTERVAL = 15  # seconds


def _parse_event_id(raw: str | None) -> int | None:
    if raw is None or raw == "":
        return None
    try:
        return max(0, int(raw))
    except ValueError:
        return None


async def _event_generator(session_id: str, last_event_id: int | None):
    session = sim_svc.get_session(session_id)
    if not session:
        yield "data: {\"type\":\"error\",\"message\":\"Session not found\"}\n\n"
        return

    cursor = last_event_id
    while True:
        try:
            # Wait for next event with timeout for heartbeat
            next_event = await asyncio.wait_for(session.queue.get_after(cursor), timeout=HEARTBEAT_INTERVAL)
            if next_event is None:  # queue closed — session stopped
                break
            event_id, event = next_event
            cursor = event_id
            yield f"id: {event_id}\ndata: {event}\n\n"

            # Stop streaming once the session has ended and queue is drained
            if '"type": "session_ended"' in event or '"type":"session_ended"' in event:
                break
        except asyncio.TimeoutError:
            # Heartbeat to keep connection alive through proxies
            yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            break


@router.get("/{session_id}")
async def stream_session(
    session_id: str,
    last_event_id: int | None = Query(default=None),
    last_event_id_header: str | None = Header(default=None, alias="Last-Event-ID"),
):
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    cursor = last_event_id if last_event_id is not None else _parse_event_id(last_event_id_header)

    return StreamingResponse(
        _event_generator(session_id, cursor),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
