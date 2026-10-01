import asyncio
import logging
from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from app.services import simulation as sim_svc
from app.dependencies import get_request_user_id
from fastapi import Depends

router = APIRouter(prefix="/api/stream", tags=["stream"])
logger = logging.getLogger(__name__)

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
        logger.debug("sse_session_missing session_id=%s", session_id)
        yield "data: {\"type\":\"error\",\"message\":\"Session not found\"}\n\n"
        return

    logger.info(
        "sse_connected session_id=%s connection_type=%s last_event_id=%s state=%s",
        session_id,
        "reconnect" if last_event_id is not None else "initial",
        last_event_id if last_event_id is not None else "-", session.state,
    )
    cursor = last_event_id
    sent = 0
    while True:
        try:
            oldest = session.queue.oldest_id()
            if cursor is not None and oldest is not None and cursor < oldest - 1:
                logger.warning("sse_replay_gap session_id=%s cursor=%s oldest=%s latest=%s", session_id, cursor, oldest, session.queue.latest_id())
                reset_cursor = session.queue.latest_id()
                yield f'id: {reset_cursor}\ndata: {{"type":"stream_reset","session_id":"{session_id}"}}\n\n'
                cursor = reset_cursor

            # Wait for next event with timeout for heartbeat
            next_event = await asyncio.wait_for(session.queue.get_after(cursor), timeout=HEARTBEAT_INTERVAL)
            if next_event is None:  # queue closed — session stopped
                break
            event_id, event = next_event
            cursor = event_id
            sent += 1
            if sent == 1:
                logger.debug("sse_first_event_sent session_id=%s event_id=%s", session_id, event_id)
            yield f"id: {event_id}\ndata: {event}\n\n"

            # Stop streaming once the session has ended and queue is drained
            if '"type": "session_ended"' in event or '"type":"session_ended"' in event:
                break
        except asyncio.TimeoutError:
            # Heartbeat to keep connection alive through proxies
            yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            logger.info("sse_disconnected session_id=%s events_sent=%d", session_id, sent)
            break


@router.get("/{session_id}")
async def stream_session(
    session_id: str,
    user_id: str | None = Query(default=None),
    request_user_id: str = Depends(get_request_user_id),
    last_event_id: int | None = Query(default=None),
    last_event_id_header: str | None = Header(default=None, alias="Last-Event-ID"),
):
    session = sim_svc.get_session(session_id)
    if not session or session.user_id != (user_id or request_user_id):
        logger.debug("sse_session_missing session_id=%s reason=%s", session_id,
                     "not_in_memory" if session is None else "ownership_mismatch")
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
