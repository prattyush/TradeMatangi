import asyncio

import pytest

from app.services import desktop_live_service as live


def candle(timestamp, close):
    return {"timestamp": timestamp, "open": close, "high": close, "low": close, "close": close}


def tile(tile_id, interval, candles):
    return {
        "tile_id": tile_id,
        "instrument": {"kind": "index", "symbol": "NIFTY"},
        "interval_minutes": interval,
        "availability": "available",
        "subscribed": True,
        "candles": candles,
    }


@pytest.mark.asyncio
async def test_refresh_merges_only_completed_candles_per_tile_interval(monkeypatch):
    # IST wall-clock timestamp for 09:24:10, as used by desktop Breeze ticks.
    now = 9 * 3600 + 24 * 60 + 10
    intervals = (1, 3, 5, 15)
    tiles = []
    for interval in intervals:
        boundary = live._active_boundary(interval, now)
        seconds = interval * 60
        tiles.append(tile(str(interval), interval, [candle(boundary - seconds, 1), candle(boundary, 99)]))
    stream = live.DesktopStream(stream_id="stream", user_id="user", generation=1, tiles=tiles)

    async def load_history(current):
        boundary = (now // (current["interval_minutes"] * 60)) * (current["interval_minutes"] * 60)
        seconds = current["interval_minutes"] * 60
        return [candle(boundary - seconds, 2), candle(boundary, 3)]

    monkeypatch.setattr(live, "_load_history", load_history)
    monkeypatch.setattr(live, "_active_boundary", lambda interval, timestamp=None: (now // (interval * 60)) * (interval * 60))

    await live.refresh(stream)

    for current in stream.tiles:
        boundary = (now // (current["interval_minutes"] * 60)) * (current["interval_minutes"] * 60)
        by_timestamp = {item["timestamp"]: item for item in current["candles"]}
        assert by_timestamp[boundary - current["interval_minutes"] * 60]["close"] == 2
        assert by_timestamp[boundary]["close"] == 99
        assert [item["timestamp"] for item in current["candles"]] == sorted(by_timestamp)


@pytest.mark.asyncio
async def test_refresh_does_not_lose_a_tick_received_while_history_loads(monkeypatch):
    now = 9 * 3600 + 24 * 60 + 10
    boundary = live._active_boundary(3, now)
    current = tile("three", 3, [candle(boundary, 100)])
    stream = live.DesktopStream(stream_id="stream", user_id="user", generation=1, tiles=[current])
    loading = asyncio.Event()
    release = asyncio.Event()

    async def load_history(_tile):
        loading.set()
        await release.wait()
        return [candle(boundary - 180, 2), candle(boundary, 3)]

    monkeypatch.setattr(live, "_load_history", load_history)
    monkeypatch.setattr(live, "_active_boundary", lambda interval, timestamp=None: boundary)
    queue = asyncio.Queue()
    consumer = asyncio.create_task(live._consume(stream, current, queue))
    refresh = asyncio.create_task(live.refresh(stream))
    await loading.wait()
    await queue.put({"time": boundary + 20, "open": 111, "high": 111, "low": 111, "close": 111})
    await asyncio.sleep(0)
    release.set()
    await refresh
    stream.stopped = True
    consumer.cancel()
    with pytest.raises(asyncio.CancelledError):
        await consumer

    active = next(item for item in current["candles"] if item["timestamp"] == boundary)
    assert active == candle(boundary, 100) | {"high": 111, "close": 111}
    assert next(item for item in current["candles"] if item["timestamp"] == boundary - 180)["close"] == 2


@pytest.mark.asyncio
async def test_refresh_provider_failure_isolated_to_that_tile(monkeypatch):
    good = tile("good", 1, [candle(60, 1)])
    bad = tile("bad", 1, [candle(60, 9)])
    stream = live.DesktopStream(stream_id="stream", user_id="user", generation=1, tiles=[good, bad])

    async def load_history(current):
        if current["tile_id"] == "bad":
            raise RuntimeError("provider unavailable")
        return [candle(60, 2)]

    monkeypatch.setattr(live, "_load_history", load_history)
    monkeypatch.setattr(live, "_active_boundary", lambda interval, timestamp=None: 120)
    await live.refresh(stream)

    assert good["candles"] == [candle(60, 2)]
    assert good["availability"] == "available"
    assert bad["candles"] == [candle(60, 9)]
    assert bad["availability"] == "provider_error"
    assert bad["reason"] == "provider unavailable"
    assert bad["subscribed"] is True
