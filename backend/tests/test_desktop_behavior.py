"""Phase 23 Sprint 2 — desktop transport for behavior questions/marks and real-session label state."""
import asyncio
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.dependencies import get_desktop_user_id
from app.main import app
from app.routers import desktop_analysis, desktop_trading
from app.services import behavior_service as svc, simulation as sim_svc, trade_label_service
from tests.test_behavior import add_session, database  # noqa: F401  (fixtures)
from tests.test_phase20_api import database as phase20_database, seed  # noqa: F401


@pytest.fixture
def as_user():
    """Authenticate desktop analysis and trading calls as the user named by the test."""
    current = {"user": "alice"}
    app.dependency_overrides[desktop_analysis.get_analysis_user_id] = lambda: current["user"]
    app.dependency_overrides[get_desktop_user_id] = lambda: current["user"]
    try:
        yield current
    finally:
        app.dependency_overrides.pop(desktop_analysis.get_analysis_user_id, None)
        app.dependency_overrides.pop(get_desktop_user_id, None)


ANALYSIS = "/api/desktop/v1/analysis/behavior"
TRADING = "/api/desktop/v1/trading"


def test_analysis_proxy_exposes_only_the_listed_behavior_routes(database, as_user):
    client = TestClient(app)
    created = client.post(f"{ANALYSIS}/questions", json={"text": "Chased", "kind": "entry"})
    assert created.status_code == 200, created.text
    qid = created.json()["question_id"]
    assert client.get(f"{ANALYSIS}/questions").json()["questions"][0]["question_id"] == qid
    assert client.post(f"{ANALYSIS}/questions/{qid}/update", json={"text": "Chased price"}).json()["text"] == "Chased price"
    assert client.post(f"{ANALYSIS}/questions/{qid}/archive").json()["status"] == "archived"
    assert client.get(f"{ANALYSIS}/questions").json()["questions"] == []
    assert client.get(f"{ANALYSIS}/questions?include_archived=true").json()["questions"][0]["status"] == "archived"
    assert client.post(f"{ANALYSIS}/questions/{qid}/restore").json()["status"] == "active"
    assert client.get(f"{ANALYSIS}/stats").status_code == 200
    # Only GET/POST on the allowlisted paths exist; nothing else is reachable.
    assert client.delete(f"{ANALYSIS}/questions").status_code in (404, 405)
    assert client.get(f"{ANALYSIS}/anything-else").status_code == 404


def test_analysis_proxy_marks_follow_session_ownership(database, as_user):
    add_session(database, "s1", user="alice")
    client = TestClient(app)
    qid = client.post(f"{ANALYSIS}/questions", json={"text": "A", "kind": "exit"}).json()["question_id"]
    body = {"session_id": "s1", "round_trip_index": 2, "answers": {qid: True}}
    assert client.post(f"{ANALYSIS}/marks", json=body).status_code == 200
    assert client.get(f"{ANALYSIS}/marks?session_id=s1").json()["marks"] == [{"round_trip_index": 2, "question_id": qid, "kind": "exit"}]
    flagged = client.get(f"{ANALYSIS}/marks/by-question?question_id={qid}").json()["trades"]
    assert [(t["session_id"], t["round_trip_index"]) for t in flagged] == [("s1", 2)]
    as_user["user"] = "bob"
    assert client.get(f"{ANALYSIS}/marks?session_id=s1").status_code == 404
    assert client.post(f"{ANALYSIS}/marks", json=body).status_code == 404


def _live_session(session_id="s1", user="alice", session_type="paper"):
    session = sim_svc.SimulationSession(
        session_id=session_id, symbol="NIFTY", date="2026-10-06", start_time="09:15:00", speed=1,
        user_id=user, instrument_type="options", session_type=session_type,
    )
    sim_svc._sessions[session_id] = session
    return session


@pytest.fixture
def live(database):
    created = []

    def make(session_id="s1", user="alice", session_type="paper"):
        add_session(database, session_id, user=user, session_type=session_type)
        created.append(session_id)
        return _live_session(session_id, user, session_type)

    yield make
    for session_id in created:
        sim_svc._sessions.pop(session_id, None)


def test_trading_routes_manage_questions_and_marks(database, as_user, live):
    live()
    client = TestClient(app)
    qid = client.post(f"{TRADING}/behavior/questions", json={"text": "Exited early", "kind": "exit"}).json()["question_id"]
    assert [q["text"] for q in client.get(f"{TRADING}/behavior/questions").json()["questions"]] == ["Exited early"]
    assert client.post(f"{TRADING}/behavior/questions", json={"text": "exited early", "kind": "exit"}).status_code == 400
    assert client.post(f"{TRADING}/behavior/questions/{qid}/update", json={"text": "Exited too early"}).json()["text"] == "Exited too early"
    saved = client.post(f"{TRADING}/s1/behavior-marks", json={"round_trip_index": 0, "answers": {qid: True}})
    assert saved.status_code == 200, saved.text
    assert client.get(f"{TRADING}/s1/behavior-marks").json()["marks"] == [{"round_trip_index": 0, "question_id": qid, "kind": "exit"}]
    cleared = client.post(f"{TRADING}/s1/behavior-marks", json={"round_trip_index": 0, "answers": {qid: False}})
    assert cleared.json()["marks"] == []
    assert client.post(f"{TRADING}/behavior/questions/{qid}/archive").json()["status"] == "archived"
    assert client.post(f"{TRADING}/behavior/questions/{qid}/restore").json()["status"] == "active"


def test_trading_marks_reject_other_users_and_unknown_sessions(database, as_user, live):
    live()
    client = TestClient(app)
    qid = client.post(f"{TRADING}/behavior/questions", json={"text": "A", "kind": "entry"}).json()["question_id"]
    body = {"round_trip_index": 0, "answers": {qid: True}}
    assert client.post(f"{TRADING}/missing/behavior-marks", json=body).status_code == 404
    as_user["user"] = "bob"
    assert client.get(f"{TRADING}/s1/behavior-marks").status_code == 404
    assert client.post(f"{TRADING}/s1/behavior-marks", json=body).status_code == 404


def test_trading_marks_unavailable_for_unsupported_session_type(database, as_user, live):
    live(session_type="swing")
    client = TestClient(app)
    qid = client.post(f"{TRADING}/behavior/questions", json={"text": "A", "kind": "entry"}).json()["question_id"]
    response = client.post(f"{TRADING}/s1/behavior-marks", json={"round_trip_index": 0, "answers": {qid: True}})
    assert response.status_code == 409


# ── Real-session label state ─────────────────────────────────────────────────

def test_real_label_state_uses_the_committed_broker_book():
    session = _live_session("real-1", session_type="real")
    try:
        completed = [{"index": 3, "right": "CE", "entry_trades": [], "exit_trades": [], "pnl": 12.0}]
        opened = [{"index": 4, "right": "PE", "entry_trades": [], "exit_trades": [], "pnl": 0.0}]
        with patch("app.services.trade_label_service.real_round_trip_state", return_value=(completed, opened)), \
             patch("app.services.trade_label_service.get_labels_for_session", return_value=[]):
            state = desktop_trading._desktop_label_state(session)
        assert state == {"completed": completed, "open": opened, "labels": []}
    finally:
        sim_svc._sessions.pop("real-1", None)


def test_real_label_state_reports_transient_read_failure_as_retryable():
    session = _live_session("real-2", session_type="real")
    try:
        with patch("app.services.trade_label_service.real_round_trip_state", side_effect=RuntimeError("changed during analytics read")):
            with pytest.raises(HTTPException) as caught:
                desktop_trading._desktop_label_state(session)
        assert caught.value.status_code == 503
    finally:
        sim_svc._sessions.pop("real-2", None)


def test_non_label_session_types_are_still_rejected():
    session = _live_session("swing-1", session_type="swing")
    try:
        with pytest.raises(HTTPException) as caught:
            desktop_trading._desktop_label_state(session)
        assert caught.value.status_code == 409
    finally:
        sim_svc._sessions.pop("swing-1", None)


def test_real_round_trip_state_matches_analysis_indices(phase20_database):
    seed(phase20_database, sid="session", mode="real")
    completed, opened = trade_label_service.real_round_trip_state("session")
    analysis = trade_label_service.compute_round_trips_for_session("session")
    assert [t["index"] for t in completed] == [t["index"] for t in analysis] == [0]
    assert opened == []
    assert trade_label_service.real_round_trip_state("missing") == ([], [])


def test_capability_flag_is_advertised():
    from app.routers.desktop import DesktopCapabilities
    assert "behavior-labels" in DesktopCapabilities().trading_capabilities
