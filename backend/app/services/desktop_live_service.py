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
    _streams.pop(stream_id, None)
    return True


def snapshot(stream: DesktopStream) -> dict:
    return {"version": 1, "stream_id": stream.stream_id, "generation": stream.generation, "event_id": stream.event_id, "timestamp": int(time.time()), "tiles": stream.tiles}


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
