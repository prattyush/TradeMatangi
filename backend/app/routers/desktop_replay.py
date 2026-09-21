"""Sprint 5 shared Replay and Stepwise controls for a desktop screen."""
import asyncio
import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.dependencies import get_desktop_user_id
from app.services import desktop_live_service as live_events
from app.services import desktop_replay_service as replay
from app.services.desktop_persistence_service import canonical_instrument_id
from app.services import simulation as sim_svc

router = APIRouter(prefix="/api/desktop/v1/replay", tags=["desktop"])
logger = logging.getLogger(__name__)


class ReplayTile(BaseModel):
    tile_id: str
    instrument: dict


class StartReplayRequest(BaseModel):
    mode: str = Field(pattern="^(replay|stepwise)$")
    date: str
    start_time: str = "09:15:00"
    interval_seconds: int = Field(default=60, ge=60, le=3600)
    speed: float = Field(default=1, ge=0.05, le=100)
    tiles: list[ReplayTile] = Field(min_length=1, max_length=4)
    initial_cursor: int | None = Field(default=None, gt=0)
    initial_bar_index: int | None = Field(default=None, ge=0)
    trading_session_id: str | None = None
    owns_trading_session: bool = False


class SyncReplayTilesRequest(BaseModel):
    tiles: list[ReplayTile] = Field(min_length=1, max_length=4)


class SpeedUpdateRequest(BaseModel):
    speed: float = Field(ge=0.05, le=100)


class CoordinatedNextBarRequest(BaseModel):
    trading_session_id: str | None = None


def _cursor(date: str, start_time: str) -> int:
    try:
        # Project invariant: UTC-labelled epoch represents IST wall-clock time.
        return int(datetime.fromisoformat(f"{date}T{start_time}+00:00").timestamp())
    except ValueError:
        raise HTTPException(status_code=422, detail="date/start_time must be ISO YYYY-MM-DD and HH:MM:SS")


@router.post("/start", status_code=201)
async def start(req: StartReplayRequest, user_id: str = Depends(get_desktop_user_id)):
    ids = [tile.tile_id for tile in req.tiles]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=422, detail="Every replay tile needs a unique tile_id")
    for tile in req.tiles:
        try:
            canonical_instrument_id(tile.instrument)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
    tiles = [tile.model_dump() for tile in req.tiles]
    candles = await asyncio.to_thread(replay.prepare_tiles, tiles, req.date, req.interval_seconds)
    if req.trading_session_id:
        session = sim_svc.get_session(req.trading_session_id)
        if not session or session.user_id != user_id or session.state == sim_svc.SimulationState.ENDED:
            raise HTTPException(status_code=404, detail="Trading session was not found")
    run = replay.create(user_id, req.mode, req.date, _cursor(req.date, req.start_time), req.interval_seconds, req.speed, tiles, candles, req.trading_session_id, req.owns_trading_session)
    if req.initial_cursor is not None:
        run.cursor = req.initial_cursor
    if req.initial_bar_index is not None:
        run.bar_index = req.initial_bar_index
    return replay.snapshot(run)


@router.get("/{run_id}/snapshot")
async def snapshot(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        logger.warning("Replay snapshot missing run_id=%s user_id=%s", run_id, user_id)
        raise HTTPException(status_code=404, detail="Replay run was not found")
    logger.debug("Replay snapshot run_id=%s user_id=%s cursor=%s event_id=%s", run_id, user_id, run.cursor, run.stream.event_id)
    return replay.snapshot(run)


def _event_id(raw: str | None) -> int | None:
    try:
        return int(raw) if raw not in (None, "") else None
    except ValueError:
        return None


@router.get("/{run_id}/events")
async def events(
    run_id: str,
    last_event_id: int | None = Query(default=None),
    last_event_id_header: str | None = Header(default=None, alias="Last-Event-ID"),
    user_id: str = Depends(get_desktop_user_id),
):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")

    async def event_source():
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        run.stream.subscribers.append(queue)
        try:
            cursor = last_event_id if last_event_id is not None else _event_id(last_event_id_header)
            reset, buffered = live_events.events_after(run.stream, cursor)
            if reset:
                yield f"event: stream_reset\ndata: {json.dumps(replay.snapshot(run))}\n\n"
            elif cursor is None:
                yield f"id: {run.stream.event_id}\nevent: snapshot\ndata: {json.dumps(replay.snapshot(run))}\n\n"
            else:
                for event in buffered:
                    yield f"id: {event['event_id']}\nevent: {event['type']}\ndata: {json.dumps(event['payload'])}\n\n"
            while run.state != "stopped":
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"id: {event['event_id']}\nevent: {event['type']}\ndata: {json.dumps(event['payload'])}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
            yield f"id: {run.stream.event_id}\nevent: replay_stopped\ndata: {json.dumps(replay.snapshot(run))}\n\n"
        finally:
            if queue in run.stream.subscribers:
                run.stream.subscribers.remove(queue)
    return StreamingResponse(event_source(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.put("/{run_id}/tiles")
async def sync_tiles(run_id: str, req: SyncReplayTilesRequest, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    ids = [tile.tile_id for tile in req.tiles]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=422, detail="Every replay tile needs a unique tile_id")
    for tile in req.tiles:
        try:
            canonical_instrument_id(tile.instrument)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error))
    tiles = [tile.model_dump() for tile in req.tiles]
    await asyncio.to_thread(replay.sync_tiles, run, tiles)
    return replay.snapshot(run)


@router.post("/{run_id}/pause")
async def pause(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    if run.trading_session_id:
        session = sim_svc.get_session(run.trading_session_id)
        if not session or session.user_id != user_id:
            raise HTTPException(status_code=404, detail="Trading session was not found")
        sim_svc.pause_session(session)
        run.state = "paused"
    else:
        await replay.pause(run)
    return replay.snapshot(run)


@router.post("/{run_id}/resume")
async def resume(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    if run.trading_session_id:
        session = sim_svc.get_session(run.trading_session_id)
        if not session or session.user_id != user_id:
            raise HTTPException(status_code=404, detail="Trading session was not found")
        sim_svc.resume_session(session)
        run.state = "running"
    else:
        await replay.resume(run)
    return replay.snapshot(run)


@router.post("/{run_id}/speed")
async def update_speed(run_id: str, req: SpeedUpdateRequest, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    if run.mode != "replay" or run.state == "stopped":
        raise HTTPException(status_code=409, detail="Replay speed can only change during a normal replay run")
    if run.trading_session_id:
        session = sim_svc.get_session(run.trading_session_id)
        if not session or session.user_id != user_id:
            raise HTTPException(status_code=404, detail="Trading session was not found")
        session.speed = max(0.01, 1 / max(req.speed, 0.05))
        run.speed = req.speed
        return replay.snapshot(run)
    await replay.update_speed(run, req.speed)
    return replay.snapshot(run)


@router.post("/{run_id}/next-bar")
async def next_bar(run_id: str, req: CoordinatedNextBarRequest | None = None, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    if req and req.trading_session_id:
        session = sim_svc.get_session(req.trading_session_id)
        if not session or session.user_id != user_id or not session.stepwise:
            raise HTTPException(status_code=404, detail="Stepwise trading session was not found")
        previous_index = session.current_bar_index
        session.bar_paused_event.clear()
        session.step_event.set()
        try:
            await asyncio.wait_for(session.bar_paused_event.wait(), timeout=3)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=409, detail="Stepwise trading session did not complete the next bar")
        if session.current_bar_index <= previous_index:
            raise HTTPException(status_code=409, detail="Stepwise trading session did not advance")
        # The simulator clock is the authority.  Pin replay to its completed
        # final tick instead of independently calculating a possibly drifting
        # next interval.
        run.cursor = int(session.current_time or run.cursor)
        run.bar_index = session.current_bar_index
        await replay._emit(run, "stepwise_bar")
        from app.routers.desktop_trading import _snapshot
        return {"replay": replay.snapshot(run), "trading": _snapshot(session, user_id).model_dump(mode="json")}
    if not await replay.next_bar(run):
        raise HTTPException(status_code=409, detail="Next Bar is unavailable for this replay state")
    return replay.snapshot(run)


@router.post("/{run_id}/stop")
async def stop(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    if run.trading_session_id and run.owns_trading_session:
        session = sim_svc.get_session(run.trading_session_id)
        if session and session.user_id == user_id:
            from app.routers.desktop_trading import _flatten_positions_for_stop, _mark_desktop_checkpoint
            _flatten_positions_for_stop(session, user_id)
            _mark_desktop_checkpoint(session)
            sim_svc.stop_session(session)
    await replay.stop(run)
    snapshot = replay.snapshot(run)
    replay.forget(run)
    return snapshot
