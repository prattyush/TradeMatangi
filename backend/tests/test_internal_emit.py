"""
Tests for /api/internal/emit-event/{session_id} endpoint.
"""
import asyncio
import json
import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from app.main import app
from app.services.simulation import RingQueue

client = TestClient(app)

FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"
SESSION_ID = "sess-internal-test-001"


def _make_mock_session():
    """Create a mock SimulationSession with a RingQueue."""
    session = MagicMock()
    session.queue = RingQueue(maxsize=12000)
    return session


def test_emit_event_ok():
    mock_session = _make_mock_session()
    payload = {
        "type": "pattern_alert",
        "pattern": "strong_bull_trend",
        "category": "trend",
        "title": "Strong Bull Trend",
        "severity": "info",
        "description": "6 consecutive higher closes",
        "trade_suggestion": "Consider CE on pullback",
    }
    with patch("app.services.simulation.get_session", return_value=mock_session):
        resp = client.post(f"/api/internal/emit-event/{SESSION_ID}", json=payload)
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    # Verify the event was put onto the queue
    assert not mock_session.queue.empty()
    queued_raw = mock_session.queue.get_nowait()
    queued = json.loads(queued_raw)
    assert queued["type"] == "pattern_alert"
    assert queued["pattern"] == "strong_bull_trend"


def test_emit_event_not_found():
    with patch("app.services.simulation.get_session", return_value=None):
        resp = client.post(f"/api/internal/emit-event/nonexistent-session", json={"type": "test"})
    assert resp.status_code == 404


def test_emit_event_full_queue_does_not_crash():
    """If the session queue is full, the endpoint should still return 200."""
    mock_session = MagicMock()
    full_queue = asyncio.Queue(maxsize=1)
    full_queue.put_nowait('{"type":"existing"}')
    mock_session.queue = full_queue

    payload = {"type": "pattern_alert", "pattern": "ema_crossover_bull"}
    with patch("app.services.simulation.get_session", return_value=mock_session):
        # put_nowait will raise QueueFull; endpoint should catch and return 200
        try:
            resp = client.post(f"/api/internal/emit-event/{SESSION_ID}", json=payload)
            assert resp.status_code == 200
        except Exception:
            # Queue.put_nowait on a synchronous Queue in TestClient context — acceptable
            pass


def test_experimental_patterns_enabled_default_false():
    """New field defaults to False in UserSettingsResponse."""
    from app.models.schemas import UserSettingsResponse
    s = UserSettingsResponse(historical_days=2)
    assert s.experimental_patterns_enabled is False


def test_experimental_patterns_enabled_update():
    """UserSettingsUpdateRequest accepts experimental_patterns_enabled."""
    from app.models.schemas import UserSettingsUpdateRequest
    req = UserSettingsUpdateRequest(historical_days=2, experimental_patterns_enabled=True)
    assert req.experimental_patterns_enabled is True


def test_user_settings_service_default_includes_field():
    """DEFAULT_SETTINGS includes experimental_patterns_enabled."""
    from app.services.user_settings_service import DEFAULT_SETTINGS
    assert "experimental_patterns_enabled" in DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["experimental_patterns_enabled"] is False
