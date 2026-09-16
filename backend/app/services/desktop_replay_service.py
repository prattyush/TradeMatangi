"""Shared chart-only replay clock; deliberately independent of trading sessions."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from app.services import desktop_live_service as events
from app.services.data_loader import candles_to_records, load_dataframe, resample_to_candles


@dataclass
class ReplayRun:
    run_id: str
    user_id: str
    mode: str
    date: str
    cursor: int
    interval_seconds: int
    speed: float
    tiles: list[dict]
    tile_candles: dict[str, list[dict]]
    stream: events.DesktopStream
    state: str = "running"
    bar_index: int = 0
    task: asyncio.Task | None = None
    next_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_runs: dict[str, ReplayRun] = {}


def prepare_tiles(tiles: list[dict], date: str, interval_seconds: int) -> dict[str, list[dict]]:
    """Load actual historical candles once; the replay clock never invents bars."""
    interval_minutes = interval_seconds // 60
    prepared: dict[str, list[dict]] = {}
    for tile in tiles:
        instrument = tile["instrument"]
        try:
            if instrument.get("kind") == "option":
                if date > instrument["expiry"]:
                    prepared[tile["tile_id"]] = []
                    continue
                from app.services.options_service import load_options_dataframe
                frame = load_options_dataframe(instrument["underlying"], date, int(instrument["strike"]), instrument["expiry"], instrument["right"])
            else:
                frame = load_dataframe(instrument["symbol"], date)
            prepared[tile["tile_id"]] = candles_to_records(resample_to_candles(frame, interval_minutes))
        except Exception:
            prepared[tile["tile_id"]] = []
    return prepared


def create(user_id: str, mode: str, date: str, cursor: int, interval_seconds: int, speed: float, tiles: list[dict], tile_candles: dict[str, list[dict]]) -> ReplayRun:
    run = ReplayRun(str(uuid.uuid4()), user_id, mode, date, cursor, interval_seconds, speed, tiles, tile_candles, events.start(user_id, tiles))
    _runs[run.run_id] = run
    if mode == "replay":
        run.task = asyncio.create_task(_clock(run))
    return run


def get(user_id: str, run_id: str) -> ReplayRun | None:
    run = _runs.get(run_id)
    return run if run and run.user_id == user_id else None


def snapshot(run: ReplayRun) -> dict:
    tile_states = []
    for tile in run.tiles:
        candles = run.tile_candles.get(tile["tile_id"], [])
        candle = next((item for item in reversed(candles) if item["time"] <= run.cursor), None)
        tile_states.append({"tile_id": tile["tile_id"], "availability": "available" if candle else "no_data", "candle": candle})
    return {"version": 1, "run_id": run.run_id, "stream_id": run.stream.stream_id, "mode": run.mode, "date": run.date, "cursor": run.cursor, "interval_seconds": run.interval_seconds, "speed": run.speed, "state": run.state, "bar_index": run.bar_index, "tiles": run.tiles, "tile_states": tile_states}


async def _emit(run: ReplayRun, event_type: str = "replay_state") -> None:
    await events.publish(run.stream, event_type, "screen", snapshot(run))


async def _clock(run: ReplayRun) -> None:
    while run.state != "stopped":
        if run.state == "running":
            run.cursor += 1
            await _emit(run)
            if all(not candles or run.cursor > candles[-1]["time"] + run.interval_seconds for candles in run.tile_candles.values()):
                await stop(run)
                return
        await asyncio.sleep(max(0.01, 1 / max(run.speed, 0.05)))


async def pause(run: ReplayRun) -> None:
    run.state = "paused"
    await _emit(run)


async def resume(run: ReplayRun) -> None:
    if run.state == "stopped":
        return
    run.state = "running"
    await _emit(run)


async def stop(run: ReplayRun) -> None:
    run.state = "stopped"
    if run.task:
        run.task.cancel()
    await _emit(run, "replay_stopped")


async def next_bar(run: ReplayRun) -> bool:
    if run.mode != "stepwise" or run.state == "stopped" or run.next_lock.locked():
        return False
    async with run.next_lock:
        run.cursor = ((run.cursor // run.interval_seconds) + 1) * run.interval_seconds
        run.bar_index += 1
        await _emit(run, "stepwise_bar")
    return True
