"""Sprint 4 chart-only live routes, separate from trading sessions."""
import asyncio
import json

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import SUPPORTED_SYMBOLS
from app.dependencies import get_desktop_user_id
from app.services import desktop_live_service as live
from app.services.desktop_persistence_service import canonical_instrument_id

router = APIRouter(prefix="/api/desktop/v1/live", tags=["desktop"])


class LiveTile(BaseModel):
    tile_id: str = Field(min_length=1, max_length=80)
    instrument: dict
    interval_minutes: int = Field(ge=1, le=60)


class StartLiveRequest(BaseModel):
    tiles: list[LiveTile] = Field(min_length=1, max_length=4)


class ConfigureLiveRequest(BaseModel):
    tile: LiveTile


def _tile_state(tile: LiveTile) -> dict:
    instrument = tile.instrument
    try:
        canonical_instrument_id(instrument)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))
    symbol = instrument.get("underlying") if instrument.get("kind") == "option" else instrument.get("symbol")
    if symbol not in SUPPORTED_SYMBOLS:
        return {"tile_id": tile.tile_id, "availability": "unavailable", "reason": "Instrument is not in the desktop catalogue"}
    return {"tile_id": tile.tile_id, "availability": "pending_subscription", "instrument": instrument, "interval_minutes": tile.interval_minutes}


@router.post("/start", status_code=201)
async def start_live(req: StartLiveRequest, user_id: str = Depends(get_desktop_user_id)):
    tile_ids = [tile.tile_id for tile in req.tiles]
    if len(tile_ids) != len(set(tile_ids)):
        raise HTTPException(status_code=422, detail="Every live tile needs a unique tile_id")
    stream = live.start(user_id, [_tile_state(tile) for tile in req.tiles])
    await live.activate(stream)
    return live.snapshot(stream)


@router.get("/{stream_id}/snapshot")
async def live_snapshot(stream_id: str, user_id: str = Depends(get_desktop_user_id)):
    stream = live.get(user_id, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Live stream was not found")
    return live.snapshot(stream)


@router.post("/{stream_id}/stop")
async def stop_live(stream_id: str, user_id: str = Depends(get_desktop_user_id)):
    if not live.stop(user_id, stream_id):
        raise HTTPException(status_code=404, detail="Live stream was not found")
    return {"version": 1, "stream_id": stream_id, "stopped": True}


@router.put("/{stream_id}/tiles/{tile_id}")
async def configure_live_tile(stream_id: str, tile_id: str, req: ConfigureLiveRequest, user_id: str = Depends(get_desktop_user_id)):
    """A tile configured after Start joins the existing chart-only stream."""
    stream = live.get(user_id, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Live stream was not found")
    if req.tile.tile_id != tile_id:
        raise HTTPException(status_code=422, detail="tile_id must match the route")
    replacement = _tile_state(req.tile)
    for index, tile in enumerate(stream.tiles):
        if tile["tile_id"] == tile_id:
            await live.deactivate_tile(stream, tile_id)
            stream.tiles[index] = replacement
            await live.activate(stream)
            return live.snapshot(stream)
    if len(stream.tiles) >= 4:
        raise HTTPException(status_code=422, detail="A live screen supports at most four tiles")
    stream.tiles.append(replacement)
    await live.activate(stream)
    return live.snapshot(stream)


@router.delete("/{stream_id}/tiles/{tile_id}")
async def remove_live_tile(stream_id: str, tile_id: str, user_id: str = Depends(get_desktop_user_id)):
    """Remove a tile and unsubscribe its provider feed while Live continues."""
    stream = live.get(user_id, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Live stream was not found")
    if not await live.remove_tile(stream, tile_id):
        raise HTTPException(status_code=404, detail="Live tile was not found")
    return live.snapshot(stream)


@router.post("/{stream_id}/refresh")
async def refresh_live(stream_id: str, user_id: str = Depends(get_desktop_user_id)):
    stream = live.get(user_id, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Live stream was not found")
    await live.refresh(stream)
    return live.snapshot(stream)


def _event_id(raw: str | None) -> int | None:
    try:
        return int(raw) if raw not in (None, "") else None
    except ValueError:
        return None


@router.get("/{stream_id}/events")
async def live_events(
    stream_id: str,
    last_event_id: int | None = Query(default=None),
    last_event_id_header: str | None = Header(default=None, alias="Last-Event-ID"),
    user_id: str = Depends(get_desktop_user_id),
):
    stream = live.get(user_id, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Live stream was not found")

    async def event_source():
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        stream.subscribers.append(queue)
        try:
            cursor = last_event_id if last_event_id is not None else _event_id(last_event_id_header)
            reset, buffered = live.events_after(stream, cursor)
            if reset:
                yield f"event: stream_reset\ndata: {json.dumps(live.snapshot(stream))}\n\n"
            elif cursor is None:
                yield f"id: {stream.event_id}\nevent: snapshot\ndata: {json.dumps(live.snapshot(stream))}\n\n"
            else:
                for event in buffered:
                    yield f"id: {event['event_id']}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"
            while not stream.stopped:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"id: {event['event_id']}\nevent: {event['type']}\ndata: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            if queue in stream.subscribers:
                stream.subscribers.remove(queue)
    return StreamingResponse(event_source(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
