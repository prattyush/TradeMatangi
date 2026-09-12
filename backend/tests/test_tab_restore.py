from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.schemas import SimulationState
from app.services.simulation import ReplayEventQueue


client = TestClient(app)


def _session(user_id: str = "abc12300-0000-0000-0000-000000000001"):
    return SimpleNamespace(
        session_id="sess-tab-restore",
        user_id=user_id,
        symbol="NIFTY",
        date="2026-06-05",
        start_time="09:15:00",
        speed=1.0,
        session_capital=100000.0,
        instrument_type="options",
        strike=24500,
        expiry="2026-06-26",
        right=None,
        strike_ce=24600,
        strike_pe=24400,
        brokerage_per_order=20.0,
        session_type="paper",
        state=SimulationState.RUNNING,
        stepwise=False,
        total_bars=0,
    )


def test_active_session_returns_attach_metadata(monkeypatch):
    monkeypatch.setattr("app.services.simulation.get_session", lambda _sid: _session())

    resp = client.get("/api/simulation/active?session_id=sess-tab-restore")

    assert resp.status_code == 200
    body = resp.json()
    assert body["session_id"] == "sess-tab-restore"
    assert body["instrument_type"] == "options"
    assert body["strike_ce"] == 24600
    assert body["strike_pe"] == 24400
    assert body["state"] == "running"


def test_active_session_rejects_other_user(monkeypatch):
    monkeypatch.setattr("app.services.simulation.get_session", lambda _sid: _session("other-user"))

    resp = client.get("/api/simulation/active?session_id=sess-tab-restore")

    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_replay_queue_replays_without_stealing_events():
    queue = ReplayEventQueue(maxsize=10)
    queue.put_nowait('{"type":"tick","close":1}')
    queue.put_nowait('{"type":"tick","close":2}')

    first_id, first_payload = await queue.get_after(None)
    second_id, second_payload = await queue.get_after(first_id)
    another_first_id, another_first_payload = await queue.get_after(None)

    assert first_id == 1
    assert first_payload == '{"type":"tick","close":1}'
    assert second_id == 2
    assert second_payload == '{"type":"tick","close":2}'
    assert another_first_id == 1
    assert another_first_payload == first_payload
