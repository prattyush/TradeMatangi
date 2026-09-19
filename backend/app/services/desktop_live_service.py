"""In-memory chart-only stream hub. It deliberately has no trading imports."""
from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo


@dataclass
class DesktopStream:
    stream_id: str
    user_id: str
    generation: int
    event_id: int = 0
    tiles: list[dict] = field(default_factory=list)
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    events: deque[dict] = field(default_factory=lambda: deque(maxlen=256))
    stopped: bool = False
    managers: list[object] = field(default_factory=list)
    tasks: list[asyncio.Task] = field(default_factory=list)
    subscriptions: dict[str, tuple[object, asyncio.Task]] = field(default_factory=dict)
    manager: object | None = None
    tile_queues: dict[str, asyncio.Queue] = field(default_factory=dict)
    tile_tasks: dict[str, asyncio.Task] = field(default_factory=dict)
    tile_locks: dict[str, asyncio.Lock] = field(default_factory=dict)
    history_cache: dict[str, list[dict]] = field(default_factory=dict)


_streams: dict[str, DesktopStream] = {}


def start(user_id: str, tiles: list[dict]) -> DesktopStream:
    stream = DesktopStream(stream_id=str(uuid.uuid4()), user_id=user_id, generation=1, tiles=tiles)
    _streams[stream.stream_id] = stream
    return stream


def get(user_id: str, stream_id: str) -> DesktopStream | None:
    stream = _streams.get(stream_id)
    return stream if stream and stream.user_id == user_id else None


def stop(user_id: str, stream_id: str) -> bool:
    stream = get(user_id, stream_id)
    if not stream:
        return False
    stream.stopped = True
    for task in stream.tasks:
        task.cancel()
    for manager in stream.managers:
        try:
            manager.stop()
        except Exception:
            pass
    if stream.manager:
        try:
            stream.manager.stop()
        except Exception:
            pass
    _streams.pop(stream_id, None)
    return True


def _history_cache_key(tile: dict) -> str:
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    try:
        from app.services.desktop_persistence_service import canonical_instrument_id
        instrument = canonical_instrument_id(tile["instrument"])
    except (KeyError, ValueError):
        instrument = repr(sorted(tile["instrument"].items()))
    return f"{instrument}:{today}:{tile['interval_minutes']}"


async def deactivate_tile(stream: DesktopStream, tile_id: str) -> None:
    """Stop the provider subscription owned by one tile before replacing it."""
    task = stream.tile_tasks.pop(tile_id, None)
    if task:
        task.cancel()
        stream.tasks = [item for item in stream.tasks if item is not task]
    stream.tile_queues.pop(tile_id, None)
    stream.subscriptions.pop(tile_id, None)
    stream.tile_locks.pop(tile_id, None)


async def remove_tile(stream: DesktopStream, tile_id: str) -> bool:
    existing = next((tile for tile in stream.tiles if tile["tile_id"] == tile_id), None)
    if existing is None:
        return False
    await deactivate_tile(stream, tile_id)
    stream.tiles = [tile for tile in stream.tiles if tile["tile_id"] != tile_id]
    return True


def snapshot(stream: DesktopStream) -> dict:
    return {"version": 1, "stream_id": stream.stream_id, "generation": stream.generation, "event_id": stream.event_id, "timestamp": int(time.time()), "tiles": stream.tiles}


def _breeze_instrument(instrument: dict) -> dict:
    """Translate the desktop's public identity to the chart-only Breeze feed."""
    from app.config import SUPPORTED_SYMBOLS
    symbol = instrument.get("underlying") if instrument.get("kind") == "option" else instrument.get("symbol")
    definition = SUPPORTED_SYMBOLS[symbol]
    if instrument.get("kind") == "option":
        return {"exchange_code": definition["options_exchange_code"], "stock_code": definition["breeze_stock_code"], "product_type": "options", "expiry_date": instrument["expiry"], "strike_price": str(instrument["strike"]), "right": "call" if instrument["right"] == "CE" else "put"}
    return {"exchange_code": definition["exchange_code"], "stock_code": definition["breeze_stock_code"], "product_type": "cash"}


def _merge(candles: list[dict], incoming: dict) -> list[dict]:
    """Timestamp is the candle identity: refreshes and ticks never duplicate it."""
    by_time = {item["timestamp"]: item for item in candles}
    by_time[incoming["timestamp"]] = incoming
    return [by_time[key] for key in sorted(by_time)]


def _tile_lock(stream: DesktopStream, tile_id: str) -> asyncio.Lock:
    return stream.tile_locks.setdefault(tile_id, asyncio.Lock())


def _active_boundary(interval_minutes: int, now: int | None = None) -> int:
    """Return this interval's current Breeze/desktop candle bucket.

    Breeze ticks use IST wall-clock seconds encoded as UTC-labelled timestamps,
    hence the same offset used by BreezeStreamManager is deliberate here.
    """
    timestamp = int(time.time()) + 19800 if now is None else now
    interval_seconds = interval_minutes * 60
    return (timestamp // interval_seconds) * interval_seconds


async def _load_history(tile: dict) -> list[dict]:
    """Fetch chart history without changing in-memory live tile state."""
    instrument, interval = tile["instrument"], tile["interval_minutes"]
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    from app.services.data_loader import candles_to_records, resample_to_candles
    from app.utils import prior_trading_days
    dates = prior_trading_days(today, 5) + [today]
    candles: list[dict] = []
    if instrument.get("kind") == "option":
        from app.services.options_service import fetch_options_historical, load_options_dataframe
        for day in (day for day in dates if day <= instrument["expiry"]):
            await asyncio.to_thread(fetch_options_historical, instrument["underlying"], day, int(instrument["strike"]), instrument["expiry"], instrument["right"])
            frame = await asyncio.to_thread(load_options_dataframe, instrument["underlying"], day, int(instrument["strike"]), instrument["expiry"], instrument["right"])
            candles.extend({"timestamp": row["time"], "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"]} for row in candles_to_records(resample_to_candles(frame, interval)))
    else:
        from app.routers.data import _ensure_data
        from app.services.data_loader import load_dataframe
        for day in dates:
            await asyncio.to_thread(_ensure_data, instrument["symbol"], day)
            frame = await asyncio.to_thread(load_dataframe, instrument["symbol"], day)
            candles.extend({"timestamp": row["time"], "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"]} for row in candles_to_records(resample_to_candles(frame, interval)))
    return sorted({candle["timestamp"]: candle for candle in candles}.values(), key=lambda candle: candle["timestamp"])


async def _seed(stream: DesktopStream, tile: dict) -> None:
    """Load initial history and report a provider error only for this tile."""
    try:
        key = _history_cache_key(tile)
        if key not in stream.history_cache:
            stream.history_cache[key] = await _load_history(tile)
        candles = [candle.copy() for candle in stream.history_cache[key]]
    except Exception as error:
        async with _tile_lock(stream, tile["tile_id"]):
            tile["availability"] = "provider_error"
            tile["reason"] = str(error)
        return
    async with _tile_lock(stream, tile["tile_id"]):
        tile["candles"] = candles
        tile["availability"] = "available"
        tile.pop("reason", None)


async def _consume(stream: DesktopStream, tile: dict, queue: asyncio.Queue) -> None:
    """Keep an interval-neutral latest Breeze second for one desktop tile."""
    while not stream.stopped:
        tick = await queue.get()
        latest_tick = {"timestamp": int(tick["time"]), "open": tick["open"], "high": tick["high"], "low": tick["low"], "close": tick["close"]}
        async with _tile_lock(stream, tile["tile_id"]):
            tile["latest_tick"] = latest_tick
            tile["availability"] = "available"
            tile.pop("reason", None)
        await publish(stream, "candle", tile["tile_id"], latest_tick)


async def reconfigure_interval(stream: DesktopStream, tile: dict, interval_minutes: int) -> None:
    """Reload one tile's history without disturbing its raw-tick route."""
    async with _tile_lock(stream, tile["tile_id"]):
        tile["interval_minutes"] = interval_minutes
    await _seed(stream, tile)


async def activate(stream: DesktopStream) -> None:
    """Seed and subscribe each tile independently; one bad contract cannot stop peers."""
    from app.services.breeze_service import BreezeStreamManager
    loop = asyncio.get_running_loop()
    for tile in stream.tiles:
        if tile.get("availability") == "unavailable":
            continue
        if tile.get("subscribed"):
            continue
        await _seed(stream, tile)
        if tile.get("availability") != "available":
            continue
        queue = stream.tile_queues.setdefault(tile["tile_id"], asyncio.Queue(maxsize=512))
        if tile["tile_id"] not in stream.tile_tasks:
            task = asyncio.create_task(_consume(stream, tile, queue))
            stream.tile_tasks[tile["tile_id"]] = task
            stream.tasks.append(task)
        tile["subscribed"] = True

    active_tiles = [tile for tile in stream.tiles if tile.get("subscribed") and tile.get("availability") == "available"]
    if not active_tiles:
        return
    try:
        if stream.manager:
            stream.manager.stop()
        manager = BreezeStreamManager()
        routes: dict[str, list[asyncio.Queue]] = {}
        instruments_by_route: dict[str, dict] = {}
        for tile in active_tiles:
            instrument = _breeze_instrument(tile["instrument"])
            route = BreezeStreamManager.instrument_route_key(instrument)
            instruments_by_route.setdefault(route, instrument)
            routes.setdefault(route, []).append(stream.tile_queues[tile["tile_id"]])
        # The fallback queue is unused for routed desktop streams; keep it
        # unbounded so an unexpected provider identity can never raise QueueFull
        # in the event loop. Routed ticks are delivered only to their tile queue.
        manager.start(asyncio.Queue(), loop, list(instruments_by_route.values()), routes=routes)
        stream.manager = manager
        stream.managers = [manager]
    except Exception as error:
        for tile in active_tiles:
            tile["availability"] = "provider_error"
            tile["reason"] = str(error)


async def refresh(stream: DesktopStream) -> None:
    """Backfill completed bars without replacing a candle being built from ticks."""
    tiles = list(stream.tiles)
    refresh_started = int(time.time()) + 19800
    boundaries = {tile["tile_id"]: _active_boundary(tile["interval_minutes"], refresh_started) for tile in tiles}
    results = await asyncio.gather(*(_load_history(tile) for tile in tiles), return_exceptions=True)
    for tile, result in zip(tiles, results):
        async with _tile_lock(stream, tile["tile_id"]):
            if isinstance(result, Exception):
                # The existing stream/task and candle cache stay usable.
                tile["availability"] = "provider_error"
                tile["reason"] = str(result)
                continue
            boundary = boundaries[tile["tile_id"]]
            # Provider data may lag or contain a partial current bar. Only it
            # may replace completed bars; in-memory current/future bars belong
            # to the live tick aggregator and are retained verbatim.
            completed = [candle for candle in result if candle["timestamp"] < boundary]
            existing = tile.get("candles", [])
            by_time = {candle["timestamp"]: candle for candle in existing}
            by_time.update({candle["timestamp"]: candle for candle in completed})
            tile["candles"] = [by_time[timestamp] for timestamp in sorted(by_time)]
            tile["availability"] = "available"
            tile.pop("reason", None)
    await publish(stream, "snapshot", "screen", snapshot(stream))


async def publish(stream: DesktopStream, event_type: str, tile_id: str, payload: dict) -> dict:
    """Provider adapters call this after their own authorised cache update."""
    stream.event_id += 1
    event = {"version": 1, "stream_id": stream.stream_id, "generation": stream.generation, "event_id": stream.event_id, "timestamp": int(time.time()), "type": event_type, "tile_id": tile_id, "payload": payload}
    stream.events.append(event)
    for subscriber in list(stream.subscribers):
        await subscriber.put(event)
    return event


def events_after(stream: DesktopStream, last_event_id: int | None) -> tuple[bool, list[dict]]:
    """Return (requires_snapshot, events); a buffer gap never fabricates data."""
    if last_event_id is None:
        return False, []
    if not stream.events:
        return last_event_id < stream.event_id, []
    oldest = stream.events[0]["event_id"]
    if last_event_id < oldest - 1:
        return True, []
    return False, [event for event in stream.events if event["event_id"] > last_event_id]
