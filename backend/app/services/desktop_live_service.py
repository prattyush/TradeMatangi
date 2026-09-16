"""In-memory chart-only stream hub. It deliberately has no trading imports."""
from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from dataclasses import dataclass, field


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
    _streams.pop(stream_id, None)
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


async def _seed(tile: dict) -> None:
    """Fetch chart history without invoking a session, order, wallet or strategy service."""
    instrument, interval = tile["instrument"], tile["interval_minutes"]
    today = time.strftime("%Y-%m-%d", time.gmtime())
    try:
        if instrument.get("kind") == "option":
            from app.services.options_service import fetch_options_historical, load_options_dataframe
            await asyncio.to_thread(fetch_options_historical, instrument["underlying"], today, int(instrument["strike"]), instrument["expiry"], instrument["right"])
            frame = await asyncio.to_thread(load_options_dataframe, instrument["underlying"], today, int(instrument["strike"]), instrument["expiry"], instrument["right"])
        else:
            from app.routers.data import _ensure_data
            from app.services.data_loader import load_dataframe
            await asyncio.to_thread(_ensure_data, instrument["symbol"], today)
            frame = await asyncio.to_thread(load_dataframe, instrument["symbol"], today)
        from app.services.data_loader import candles_to_records, resample_to_candles
        tile["candles"] = [{"timestamp": row["time"], "open": row["open"], "high": row["high"], "low": row["low"], "close": row["close"]} for row in candles_to_records(resample_to_candles(frame, interval))]
        tile["availability"] = "available"
        tile.pop("reason", None)
    except Exception as error:
        tile["availability"] = "provider_error"
        tile["reason"] = str(error)


async def _consume(stream: DesktopStream, tile: dict, queue: asyncio.Queue) -> None:
    """Aggregate authorised one-second Breeze updates into the tile interval."""
    interval_seconds = tile["interval_minutes"] * 60
    while not stream.stopped:
        tick = await queue.get()
        timestamp = (int(tick["time"]) // interval_seconds) * interval_seconds
        current = next((bar for bar in reversed(tile.get("candles", [])) if bar["timestamp"] == timestamp), None)
        candle = {"timestamp": timestamp, "open": tick["open"], "high": tick["high"], "low": tick["low"], "close": tick["close"]} if current is None else {"timestamp": timestamp, "open": current["open"], "high": max(current["high"], tick["high"]), "low": min(current["low"], tick["low"]), "close": tick["close"]}
        tile["candles"] = _merge(tile.get("candles", []), candle)
        tile["availability"] = "available"
        await publish(stream, "candle", tile["tile_id"], candle)


async def activate(stream: DesktopStream) -> None:
    """Seed and subscribe each tile independently; one bad contract cannot stop peers."""
    from app.services.breeze_service import BreezeStreamManager
    loop = asyncio.get_running_loop()
    for tile in stream.tiles:
        if tile.get("availability") == "unavailable":
            continue
        if tile.get("subscribed"):
            continue
        await _seed(tile)
        if tile.get("availability") != "available":
            continue
        try:
            queue: asyncio.Queue = asyncio.Queue(maxsize=512)
            manager = BreezeStreamManager()
            manager.start(queue, loop, [_breeze_instrument(tile["instrument"])])
            stream.managers.append(manager)
            stream.tasks.append(asyncio.create_task(_consume(stream, tile, queue)))
            tile["subscribed"] = True
        except Exception as error:
            tile["availability"] = "provider_error"
            tile["reason"] = str(error)


async def refresh(stream: DesktopStream) -> None:
    """Refetch history while retaining the newest websocket candle for every tile."""
    for tile in stream.tiles:
        latest = tile.get("candles", [])[-1:]
        await _seed(tile)
        if latest:
            tile["candles"] = _merge(tile.get("candles", []), latest[0])
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
