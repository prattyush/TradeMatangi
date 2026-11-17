"""Phase 26 — Strategy Practice (S13): the practice marker on a replay session, what it hides, and what it is kept out of."""
import json
from unittest.mock import patch

import boto3
import pytest
from fastapi import HTTPException
from moto import mock_aws

from app.services import analysis_service
from app.services import deep_dive_service as dd
from app.services import pattern_logger_service as patterns
from app.services import performance_service
from app.services import simulation as sim_svc
from app.services import strategy_practice_service as practice

USER = "alice"
CAT, STRAT = "Breakout", "Opening range"
DAY = "2026-10-06"  # a Tuesday
DAY_START = 1_791_244_800  # chart time of a midnight (IST wall-clock encoded as UTC)


def at(hours, minutes):
    return DAY_START + hours * 3600 + minutes * 60


def mark(kind, time, instrument="underlying", price=100.0):
    return {"id": f"{kind}{time}{instrument}", "time": time, "price": price, "type": kind, "instrument": instrument,
            "strategy_name": STRAT, "category": CAT}


@pytest.fixture
def database(monkeypatch):
    with mock_aws():
        db = boto3.resource("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        client = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: db)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        monkeypatch.setattr(dd, "_SETUPS_ENSURED", False)
        monkeypatch.setattr(dd, "_TAGS_ENSURED", False)
        monkeypatch.setattr(patterns, "_names_table_ready", False, raising=False)
        monkeypatch.setattr(patterns, "get_accessible_owner_ids", lambda user_id: [user_id])
        monkeypatch.setattr(dd, "_stats_cache", {})
        client.create_table(
            TableName="Sessions", BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": "user_id", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[{"IndexName": "UserIdIndex", "KeySchema": [{"AttributeName": "user_id", "KeyType": "HASH"}],
                                     "Projection": {"ProjectionType": "ALL"}}])
        yield db


@pytest.fixture(autouse=True)
def clean_memory():
    sim_svc._sessions.clear()
    with patch("app.services.wallet_service._write_wallet_to_db"), patch("app.services.wallet_service.get_balance", return_value=150_000.0):
        yield
    sim_svc._sessions.clear()


def mark_day(*, side="buy", marks=None, symbol="NIFTY", day=DAY, **fields):
    marks = [mark("entry", at(9, 45)), mark("exit", at(10, 30))] if marks is None else marks
    return dd.upsert_setup(USER, CAT, STRAT, symbol, day, side, {"annotations": marks, **fields})


PRACTICE = {"category": CAT, "strategy": STRAT, "start_offset_min": 12}


def test_the_marker_snapshots_the_users_day_and_starts_before_the_entry(database):
    mark_day(side="buy", outcome="success", strength="ideal", strike_ce=24500, strike_pe=24400)
    mark_day(side="sell", marks=[mark("entry", at(11, 0), "PE")])
    marker = practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:33:00")
    assert (marker["category"], marker["strategy"], marker["symbol"], marker["date"]) == (CAT, STRAT, "NIFTY", DAY)
    assert marker["start_offset_min"] == 12
    assert [r["side"] for r in marker["recorded"]] == ["buy", "sell"]
    assert marker["recorded"][0]["strength"] == "ideal" and marker["recorded"][0]["strike_ce"] == 24500
    assert [a["type"] for a in marker["recorded"][0]["annotations"]] == ["entry", "exit"]
    json.dumps(marker)  # it is stored as a JSON string


def test_a_day_that_cannot_be_practised_is_refused_with_a_reason(database):
    mark_day(marks=[mark("exit", at(10, 30))])  # no Entry mark
    with pytest.raises(ValueError, match="no Entry mark"):
        practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:30:00")
    mark_day(side="sell")  # has marks, but another symbol / day is asked for
    with pytest.raises(ValueError, match="no Entry mark"):
        practice.build_marker(USER, PRACTICE, "BSESEN", DAY, "09:30:00")
    with pytest.raises(ValueError, match="no Entry mark"):
        practice.build_marker(USER, PRACTICE, "NIFTY", "2026-10-07", "09:30:00")
    with pytest.raises(ValueError, match="before the first recorded entry"):
        practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:45:00")  # at the entry bar: too late
    with pytest.raises(ValueError, match="before the first recorded entry"):
        practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "10:00:00")
    with pytest.raises(ValueError, match="time of day"):
        practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "soon")


def test_another_users_marks_are_never_used(database):
    mark_day()
    with pytest.raises(ValueError, match="no Entry mark"):
        practice.build_marker("mallory", PRACTICE, "NIFTY", DAY, "09:30:00")


def _stored(session):
    sim_svc._upsert_session_to_db(session, strict=True)
    return sim_svc_table().get_item(Key={"session_id": session.session_id})["Item"]


def sim_svc_table():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table("Sessions")


def test_the_marker_is_stored_as_json_and_read_back(database):
    mark_day()
    marker = practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:30:00")
    session = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, practice=marker)
    item = _stored(session)
    assert isinstance(item["practice"], str)
    assert sim_svc.load_practice(item) == marker
    plain = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER)
    assert "practice" not in _stored(plain)  # an ordinary replay writes nothing new
    assert sim_svc.load_practice({"practice": "{not json"}) is None and sim_svc.load_practice({}) is None


def test_responses_name_the_strategy_but_never_the_side_or_marks(database):
    from app.routers.simulation import _session_response

    mark_day()
    marker = practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:30:00")
    session = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, practice=marker)
    shown = _session_response(session, group={"clock_family": "sim", "state": "running", "current_time": None}).model_dump()
    assert shown["practice"] == {"category": CAT, "strategy": STRAT}
    assert "recorded" not in json.dumps(shown) and "buy" not in json.dumps(shown["practice"])
    summary = analysis_service.compute_session_summary(_stored(session), [])
    assert summary["practice"] == {"category": CAT, "strategy": STRAT}
    assert analysis_service.compute_session_summary({"session_id": "x", "user_id": USER, "symbol": "NIFTY", "date": DAY}, [])["practice"] is None


def test_a_practice_run_is_not_the_same_session_as_a_normal_replay(database):
    mark_day()
    marker = practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:30:00")
    run = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, practice=marker)
    _stored(run)
    assert sim_svc.find_session_by_context(USER, "NIFTY", DAY, "sim", "equity") is None
    assert sim_svc.find_all_sessions_by_context(USER, "NIFTY", DAY, "sim", "equity") == []  # a normal replay's override cannot delete it
    normal = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER)
    _stored(normal)
    assert [r["session_id"] for r in sim_svc.find_all_sessions_by_context(USER, "NIFTY", DAY, "sim", "equity")] == [normal.session_id]


def test_practice_trades_are_not_history_of_a_normal_replay(database):
    from app.routers import trading

    mark_day()
    marker = practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:30:00")
    run = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, practice=marker)
    normal = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER)
    _stored(run), _stored(normal)
    rows = [sim_svc_table().get_item(Key={"session_id": s.session_id})["Item"] for s in (run, normal)]
    seen = []
    with patch("app.services.analysis_service.get_sessions_for_user", return_value=rows), \
         patch("app.services.analysis_service.get_trades_for_session", side_effect=lambda sid: seen.append(sid) or []):
        import asyncio
        result = asyncio.run(trading.get_trades_by_context(symbol="NIFTY", date=DAY, instrument_type="equity", session_type="sim", user_id=USER))
    assert result["session_ids"] == [normal.session_id] and seen == [normal.session_id]


def test_practice_runs_stay_out_of_the_performance_totals(database):
    mark_day()
    marker = practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:30:00")
    run = _stored(sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, practice=marker))
    normal = _stored(sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER))

    def cycles(session):
        return [{"cycle_id": session["session_id"], "date": DAY, "entry_time": 1, "entries": [], "exits": [], "direction": "long", "label": {}}]

    with patch.object(performance_service, "query_all", return_value=[run, normal]), \
         patch.object(performance_service, "load_session_cycles", side_effect=cycles), \
         patch.object(performance_service, "behavior_groups"):
        assert [c["cycle_id"] for c in performance_service.load_cycles(USER)] == [normal["session_id"]]
        both = performance_service.load_cycles(USER, include_practice=True)
        assert {c["cycle_id"] for c in both} == {run["session_id"], normal["session_id"]}


def test_start_request_accepts_a_marker_only_on_a_replay(database):
    import asyncio
    from pydantic import ValidationError
    from app.models.schemas import SimulationStartRequest
    from app.routers.simulation import _start_simulation_impl

    mark_day()
    base = {"symbol": "NIFTY", "date": DAY, "start_time": "09:30:00", "session_type": "sim", "practice": PRACTICE}

    def start(**changes):
        return asyncio.run(_start_simulation_impl(SimulationStartRequest(**{**base, **changes}), user_id=USER))

    with pytest.raises(HTTPException) as paper:
        start(session_type="paper")
    assert paper.value.status_code == 400 and "replay" in paper.value.detail
    with pytest.raises(HTTPException) as late:
        start(start_time="10:00:00")  # after the 09:45 entry
    assert late.value.status_code == 400 and "before the first recorded entry" in late.value.detail
    with pytest.raises(HTTPException) as nothing:
        start(date="2026-10-07")  # a day that was never marked
    assert nothing.value.status_code == 400 and "no Entry mark" in nothing.value.detail
    with pytest.raises(ValidationError):
        SimulationStartRequest(**{**base, "practice": {"category": CAT}})  # a strategy is required
    assert SimulationStartRequest(**{k: v for k, v in base.items() if k != "practice"}).practice is None
