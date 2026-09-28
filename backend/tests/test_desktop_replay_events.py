import asyncio
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.routers import desktop_replay
from app.services import desktop_replay_service as replay
from app.services import simulation as sim_svc


def test_replay_start_request_requires_a_positive_explicit_cursor():
    payload = {
        "mode": "stepwise",
        "date": "2026-05-06",
        "tiles": [{"tile_id": "tile-1", "instrument": {"kind": "index", "symbol": "NIFTY"}}],
    }

    assert desktop_replay.StartReplayRequest.model_validate(payload).initial_cursor is None
    with pytest.raises(ValidationError):
        desktop_replay.StartReplayRequest.model_validate({**payload, "initial_cursor": 0})


def test_replay_snapshot_uses_each_tiles_selected_interval_after_switch():
    source = [
        {"time": minute * 60, "open": minute, "high": minute, "low": minute, "close": minute}
        for minute in range(6)
    ]
    tiles = [
        {"tile_id": interval, "instrument": {"kind": "index", "symbol": "NIFTY"}, "interval_minutes": int(interval)}
        for interval in ("1", "3", "5")
    ]
    run = replay.create("desktop-user", "stepwise", "2026-05-06", 0, 180, 1, tiles, {tile["tile_id"]: source for tile in tiles})
    try:
        run.cursor = 2 * 60 + 30
        current = {tile["tile_id"]: tile for tile in replay.snapshot(run)["tile_states"]}
        assert {key: value["candle"]["timestamp"] for key, value in current.items()} == {"1": 120, "3": 0, "5": 0}
        assert {key: value["interval_minutes"] for key, value in current.items()} == {"1": 1, "3": 3, "5": 5}

        replay.sync_tiles(run, [{**tile, "interval_minutes": 1} if tile["tile_id"] == "3" else tile for tile in tiles])
        switched = {tile["tile_id"]: tile for tile in replay.snapshot(run)["tile_states"]}
        assert switched["3"]["candle"]["timestamp"] == 120
        assert run.interval_seconds == 180
        assert run.tile_candles["3"] is source
    finally:
        replay.forget(run)


@pytest.mark.asyncio
async def test_replay_events_emit_authoritative_snapshot_and_stop_event():
    run = replay.create(
        "desktop-user",
        "stepwise",
        "2026-05-06",
        9 * 3600 + 15 * 60,
        60,
        1,
        [],
        {},
    )
    run.state = "stopped"

    response = await desktop_replay.events(
        run.run_id,
        last_event_id=None,
        last_event_id_header=None,
        user_id="desktop-user",
    )
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)

    body = "".join(chunks)
    assert "event: snapshot" in body
    assert f'"run_id": "{run.run_id}"' in body
    assert "event: replay_stopped" in body


@pytest.mark.asyncio
async def test_replay_speed_update_changes_running_normal_replay():
    run = replay.create(
        "desktop-user",
        "replay",
        "2026-05-06",
        9 * 3600 + 15 * 60,
        60,
        1,
        [{"tile_id": "tile-1", "instrument": {"kind": "index", "symbol": "NIFTY"}}],
        {"tile-1": [{"time": 9 * 3600 + 16 * 60, "open": 1, "high": 1, "low": 1, "close": 1}]},
    )
    await replay.pause(run)
    try:
        response = await desktop_replay.update_speed(
            run.run_id,
            desktop_replay.SpeedUpdateRequest(speed=2),
            user_id="desktop-user",
        )
        assert response["speed"] == 2
        assert run.speed == 2
    finally:
        await replay.stop(run)


@pytest.mark.asyncio
async def test_linked_replay_stream_publishes_candle_when_trading_clock_advances(monkeypatch):
    session = SimpleNamespace(current_time="100", state=SimpleNamespace(value="running"))
    monkeypatch.setattr(sim_svc, "get_session", lambda _session_id: session)
    run = replay.create(
        "desktop-user", "replay", "2026-05-06", 100, 60, 1,
        [{"tile_id": "tile-1", "instrument": {"kind": "index", "symbol": "NIFTY"}}],
        {"tile-1": [{"time": 101, "open": 10, "high": 11, "low": 9, "close": 11}]},
        trading_session_id="trading-1",
    )
    queue = asyncio.Queue()
    run.stream.subscribers.append(queue)
    try:
        await asyncio.sleep(0)
        session.current_time = "101"
        event = await asyncio.wait_for(queue.get(), timeout=1)
        assert event["type"] == "replay_state"
        assert event["payload"]["event_id"] == event["event_id"]
        assert event["payload"]["cursor"] == 101
        assert event["payload"]["tile_states"][0]["candle"]["close"] == 11
    finally:
        run.task.cancel()
        replay.forget(run)
