"""Sprint 5 shared Replay and Stepwise controls for a desktop screen."""
import asyncio
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.dependencies import get_desktop_user_id
from app.services import desktop_replay_service as replay
from app.services.desktop_persistence_service import canonical_instrument_id

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


class SyncReplayTilesRequest(BaseModel):
    tiles: list[ReplayTile] = Field(min_length=1, max_length=4)


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
    run = replay.create(user_id, req.mode, req.date, _cursor(req.date, req.start_time), req.interval_seconds, req.speed, tiles, candles)
    return replay.snapshot(run)


@router.get("/{run_id}/snapshot")
async def snapshot(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        logger.warning("Replay snapshot missing run_id=%s user_id=%s", run_id, user_id)
        raise HTTPException(status_code=404, detail="Replay run was not found")
    logger.debug("Replay snapshot run_id=%s user_id=%s cursor=%s event_id=%s", run_id, user_id, run.cursor, run.stream.event_id)
    return replay.snapshot(run)


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
    await replay.pause(run)
    return replay.snapshot(run)


@router.post("/{run_id}/resume")
async def resume(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    await replay.resume(run)
    return replay.snapshot(run)


@router.post("/{run_id}/next-bar")
async def next_bar(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    if not await replay.next_bar(run):
        raise HTTPException(status_code=409, detail="Next Bar is unavailable for this replay state")
    return replay.snapshot(run)


@router.post("/{run_id}/stop")
async def stop(run_id: str, user_id: str = Depends(get_desktop_user_id)):
    run = replay.get(user_id, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Replay run was not found")
    await replay.stop(run)
    return replay.snapshot(run)
