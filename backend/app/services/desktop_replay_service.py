"""Shared chart-only replay clock; deliberately independent of trading sessions."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field

from app.services import desktop_live_service as events
from app.services.data_loader import candles_to_records, load_dataframe


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
    trading_session_id: str | None = None
    owns_trading_session: bool = False
    state: str = "running"
    bar_index: int = 0
    task: asyncio.Task | None = None
    next_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_runs: dict[str, ReplayRun] = {}


def prepare_tiles(tiles: list[dict], date: str, interval_seconds: int) -> dict[str, list[dict]]:
    """Load source seconds once; snapshots aggregate the in-progress bar."""
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
            prepared[tile["tile_id"]] = candles_to_records(frame)
        except Exception:
            prepared[tile["tile_id"]] = []
    return prepared


def _sync_from_trading(run: ReplayRun) -> None:
    if not run.trading_session_id:
        return
    try:
        from app.services import simulation as sim_svc
        session = sim_svc.get_session(run.trading_session_id)
        if not session:
            run.state = "stopped"
            return
        if session.current_time:
            run.cursor = int(session.current_time)
        if session.state.value == "paused":
            run.state = "paused"
        elif session.state.value == "ended":
            run.state = "stopped"
        else:
            run.state = "running"
    except Exception:
        return


def create(user_id: str, mode: str, date: str, cursor: int, interval_seconds: int, speed: float, tiles: list[dict], tile_candles: dict[str, list[dict]], trading_session_id: str | None = None, owns_trading_session: bool = False) -> ReplayRun:
    # Stepwise always presents a completed candle.  This is the same initial
    # interval that the paired Stepwise simulator pauses on.
    if mode == "stepwise":
        cursor += interval_seconds - 1
    run = ReplayRun(str(uuid.uuid4()), user_id, mode, date, cursor, interval_seconds, speed, tiles, tile_candles, events.start(user_id, tiles), trading_session_id=trading_session_id, owns_trading_session=owns_trading_session)
    if mode == "stepwise":
        run.bar_index = 1
    _runs[run.run_id] = run
    if mode == "replay" and not trading_session_id:
        run.task = asyncio.create_task(_clock(run))
    return run


def get(user_id: str, run_id: str) -> ReplayRun | None:
    run = _runs.get(run_id)
    return run if run and run.user_id == user_id else None


def forget(run: ReplayRun) -> None:
    _runs.pop(run.run_id, None)
    events.stop(run.user_id, run.stream.stream_id)


def sync_tiles(run: ReplayRun, tiles: list[dict]) -> None:
    """Attach the screen's current tiles without changing the replay clock.

    Source records are loaded only for new or changed instruments.  The next
    snapshot aggregates each tile through the run cursor, so a tile added
    mid-bar starts with a partial candle rather than a completed historical bar.
    """
    previous = {tile["tile_id"]: tile for tile in run.tiles}
    previous_candles = run.tile_candles
    changed = [
        tile for tile in tiles
        if tile["tile_id"] not in previous or previous[tile["tile_id"]].get("instrument") != tile.get("instrument")
    ]
    loaded = prepare_tiles(changed, run.date, run.interval_seconds) if changed else {}
    run.tiles = list(tiles)
    run.tile_candles = {
        tile["tile_id"]: loaded.get(tile["tile_id"], previous_candles.get(tile["tile_id"], []))
        for tile in run.tiles
    }


def snapshot(run: ReplayRun) -> dict:
    _sync_from_trading(run)
    tile_states = []
    for tile in run.tiles:
        candles = run.tile_candles.get(tile["tile_id"], [])
        source = [item for item in candles if item["time"] <= run.cursor]
        candle = None
        if source:
            start = (source[-1]["time"] // run.interval_seconds) * run.interval_seconds
            bar = [item for item in source if item["time"] >= start]
            # Desktop historical pages use ``timestamp``.  Keep the replay
            # snapshot on that same public contract; ``time`` is only the
            # internal source-record field returned by candles_to_records.
            candle = {"timestamp": start, "open": bar[0]["open"], "high": max(item["high"] for item in bar), "low": min(item["low"] for item in bar), "close": bar[-1]["close"]}
        tile_states.append({"tile_id": tile["tile_id"], "availability": "available" if candle else "no_data", "candle": candle})
    return {"version": 1, "event_id": run.stream.event_id, "run_id": run.run_id, "stream_id": run.stream.stream_id, "mode": run.mode, "date": run.date, "cursor": run.cursor, "interval_seconds": run.interval_seconds, "speed": run.speed, "state": run.state, "bar_index": run.bar_index, "tiles": run.tiles, "tile_states": tile_states}


async def _emit(run: ReplayRun, event_type: str = "replay_state") -> None:
    await events.publish(run.stream, event_type, "screen", snapshot(run))


async def _clock(run: ReplayRun) -> None:
    while run.state != "stopped":
        if run.state == "running":
            run.cursor += 1
            await _emit(run)
            if all(not candles or run.cursor > candles[-1]["time"] for candles in run.tile_candles.values()):
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


async def update_speed(run: ReplayRun, speed: float) -> None:
    run.speed = speed
    await _emit(run, "replay_speed")


async def stop(run: ReplayRun) -> None:
    run.state = "stopped"
    if run.task:
        run.task.cancel()
    await _emit(run, "replay_stopped")


async def next_bar(run: ReplayRun) -> bool:
    if run.mode != "stepwise" or run.state == "stopped" or run.next_lock.locked():
        return False
    async with run.next_lock:
        # A bar is complete only at its final source-second.  Advancing to the
        # next boundary exposed just that boundary's opening price as a
        # one-point OHLC candle.  Finish the current incomplete interval first;
        # after it is complete, finish the following interval on each click.
        bar_start = (run.cursor // run.interval_seconds) * run.interval_seconds
        bar_end = bar_start + run.interval_seconds - 1
        run.cursor = bar_end if run.cursor < bar_end else bar_end + run.interval_seconds
        run.bar_index += 1
        await _emit(run, "stepwise_bar")
    return True
