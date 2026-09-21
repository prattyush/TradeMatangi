import pytest
from pydantic import ValidationError

from app.routers import desktop_replay
from app.services import desktop_replay_service as replay


def test_replay_start_request_requires_a_positive_explicit_cursor():
    payload = {
        "mode": "stepwise",
        "date": "2026-05-06",
        "tiles": [{"tile_id": "tile-1", "instrument": {"kind": "index", "symbol": "NIFTY"}}],
    }

    assert desktop_replay.StartReplayRequest.model_validate(payload).initial_cursor is None
    with pytest.raises(ValidationError):
        desktop_replay.StartReplayRequest.model_validate({**payload, "initial_cursor": 0})


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
