"""Shared chart-only replay clock; deliberately independent of trading sessions."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from app.services import desktop_live_service as events


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
    stream: events.DesktopStream
    state: str = "running"
    bar_index: int = 0
    task: asyncio.Task | None = None
    next_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_runs: dict[str, ReplayRun] = {}


def create(user_id: str, mode: str, date: str, cursor: int, interval_seconds: int, speed: float, tiles: list[dict]) -> ReplayRun:
    run = ReplayRun(str(uuid.uuid4()), user_id, mode, date, cursor, interval_seconds, speed, tiles, events.start(user_id, tiles))
    _runs[run.run_id] = run
    if mode == "replay":
        run.task = asyncio.create_task(_clock(run))
    return run


def get(user_id: str, run_id: str) -> ReplayRun | None:
    run = _runs.get(run_id)
    return run if run and run.user_id == user_id else None


def snapshot(run: ReplayRun) -> dict:
    return {"version": 1, "run_id": run.run_id, "stream_id": run.stream.stream_id, "mode": run.mode, "date": run.date, "cursor": run.cursor, "interval_seconds": run.interval_seconds, "speed": run.speed, "state": run.state, "bar_index": run.bar_index, "tiles": run.tiles}


async def _emit(run: ReplayRun, event_type: str = "replay_state") -> None:
    await events.publish(run.stream, event_type, "screen", snapshot(run))


async def _clock(run: ReplayRun) -> None:
    while run.state != "stopped":
        if run.state == "running":
            run.cursor += 1
            await _emit(run)
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
