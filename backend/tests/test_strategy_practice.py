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


# ── S14: choosing a day, the review, the history ─────────────────────────────

import random


def run_marker(day=DAY, symbol="NIFTY", start="09:30:00"):
    return practice.build_marker(USER, PRACTICE, symbol, day, start)


def store_run(*, state="ended", day=DAY, symbol="NIFTY", start="09:30:00", created=1, user=USER):
    marker = run_marker(day, symbol, start)
    session = sim_svc.create_session(symbol, day, start, 1.0, user_id=user, practice=marker)
    session.created_at = created
    item = _stored(session)
    if state != "running":
        sim_svc_table().update_item(Key={"session_id": session.session_id}, UpdateExpression="SET #s = :s",
                                    ExpressionAttributeNames={"#s": "state"}, ExpressionAttributeValues={":s": state})
        sim_svc._sessions.pop(session.session_id, None)
    return session.session_id


def test_strategies_with_entry_marked_days_are_listed_with_their_counts(database):
    mark_day(day="2026-10-06", symbol="NIFTY", outcome="success", strength="ideal")
    mark_day(day="2026-10-07", symbol="NIFTY", outcome="failed")
    mark_day(day="2026-10-08", symbol="BSESEN")
    mark_day(day="2026-10-09", marks=[mark("exit", at(10, 0))])  # no Entry: not offered
    dd.upsert_setup(USER, "Reversal", "Double top", "NIFTY", "2026-10-06", "sell", {"annotations": [mark("exit", at(10, 0))]})
    listed = practice.list_strategies(USER)
    assert [(r["category"], r["strategy"], r["days"]) for r in listed] == [(CAT, STRAT, 3)]
    assert listed[0]["symbols"] == [{"symbol": "BSESEN", "days": 1}, {"symbol": "NIFTY", "days": 2}]
    assert listed[0]["grades"] == {"ideal": 1, "average": 0, "poor": 0, "ungraded": 0, "failed": 1, "open": 1}
    assert practice.list_strategies("mallory") == []


def test_a_pick_starts_5_to_25_whole_minutes_before_the_first_entry_and_hides_the_answer(database):
    mark_day(side="buy", strike_ce=24500, strike_pe=24400)
    mark_day(side="sell", marks=[mark("entry", at(10, 0), "PE")])
    seen = set()
    for seed in range(60):
        picked = practice.pick(USER, CAT, STRAT, rng=random.Random(seed))
        h, m, s = (int(x) for x in picked["start_time"].split(":"))
        minutes_before = (9 * 60 + 45) - (h * 60 + m)
        assert s == 0 and 5 <= minutes_before <= 25 and picked["practice"]["start_offset_min"] == minutes_before
        seen.add(minutes_before)
    assert len(seen) > 10  # varied, so the entry cannot be guessed
    assert (picked["date"], picked["symbol"], picked["interval_minutes"]) == (DAY, "NIFTY", 3)
    assert (picked["strike_ce"], picked["strike_pe"], picked["instrument_type"]) == (24500, 24400, "options")
    assert picked["expiry"] and picked["practice"]["category"] == CAT
    assert "side" not in json.dumps(picked) and "annotations" not in picked and "recorded" not in picked
    # what it picked can start a run
    assert practice.build_marker(USER, picked["practice"], picked["symbol"], picked["date"], picked["start_time"])["recorded"]


def test_a_start_is_never_before_the_open_and_a_day_entered_at_the_open_is_skipped(database):
    mark_day(day="2026-10-06", marks=[mark("entry", at(9, 21))])  # 6 minutes after the open: 09:15 start
    mark_day(day="2026-10-07", marks=[mark("entry", at(9, 15))])  # nothing to start before
    for seed in range(20):
        picked = practice.pick(USER, CAT, STRAT, rng=random.Random(seed))
        assert picked["date"] == "2026-10-06" and picked["start_time"] >= "09:15:00"
        assert picked["start_time"] == "09:15:00" or picked["start_time"] > "09:15:00"
        assert picked["practice"]["start_offset_min"] == (9 * 60 + 21) - (int(picked["start_time"][:2]) * 60 + int(picked["start_time"][3:5]))
        assert picked["start_time"] >= "09:15:00" and picked["practice"]["start_offset_min"] <= 6  # clamped at the open
    with pytest.raises(ValueError, match="No day"):
        practice.pick(USER, CAT, STRAT, symbol="BSESEN")


def test_filters_by_symbol_and_grade(database):
    mark_day(day="2026-10-06", symbol="NIFTY", outcome="success", strength="ideal")
    mark_day(day="2026-10-07", symbol="NIFTY", outcome="failed")
    mark_day(day="2026-10-08", symbol="BSESEN", outcome="success", strength="poor")
    picks = lambda **f: {practice.pick(USER, CAT, STRAT, rng=random.Random(i), **f)["date"] for i in range(30)}
    assert picks(grades=["ideal"]) == {"2026-10-06"}
    assert picks(grades=["failed", "poor"]) == {"2026-10-07", "2026-10-08"}
    assert picks(symbol="BSESEN") == {"2026-10-08"}
    with pytest.raises(ValueError, match="No day"):
        practice.pick(USER, CAT, STRAT, symbol="NIFTY", grades=["poor"])
    assert picks() == {"2026-10-06", "2026-10-07", "2026-10-08"}


def test_a_practised_day_is_not_repeated_until_every_day_was_used(database):
    mark_day(day="2026-10-06")
    mark_day(day="2026-10-07")
    store_run(day="2026-10-06", state="ended")
    assert {practice.pick(USER, CAT, STRAT, rng=random.Random(i))["date"] for i in range(20)} == {"2026-10-07"}
    store_run(day="2026-10-07", state="running")  # even a run in progress counts as used
    again = practice.pick(USER, CAT, STRAT, rng=random.Random(1))
    assert again["repeated"] is True and again["days_available"] == 2


class FakeBars:
    """Minute bars by contract: a loader that returns the same shape as ``load_bars``."""
    def __init__(self, by_instrument):
        self.by_instrument, self.calls = by_instrument, []

    def __call__(self, symbol, date, interval_minutes, strike=None, expiry=None, right=None):
        self.calls.append((right, strike))
        if (right, strike) not in self.by_instrument:
            raise FileNotFoundError("no data")
        return {at(*clock): {"time": at(*clock), "open": o, "close": c} for clock, (o, c) in self.by_instrument[(right, strike)].items()}


def trip(index, side, right, strike, entry_clock, entry_price, exit_clock, exit_price, qty=75):
    return {"index": index, "right": right, "strike": strike, "expiry": "2026-10-07", "pnl": (exit_price - entry_price) * qty * (1 if side == "BUY" else -1),
            "pnl_pct": 1.0, "state": "closed",
            "entry_trades": [{"side": side, "quantity": qty, "price": entry_price, "timestamp": at(*entry_clock) + 20}],
            "exit_trades": [{"side": "SELL" if side == "BUY" else "BUY", "quantity": qty, "price": exit_price, "timestamp": at(*exit_clock) + 5}]}


def review(loader, trips, **marker_kwargs):
    sid = store_run(**marker_kwargs)
    with patch("app.services.trade_label_service.compute_round_trips_for_session", return_value=trips):
        return practice.evaluate(USER, sid, loader), sid


def test_the_theoretical_pnl_prices_the_best_pair_open_to_close(database):
    mark_day(side="buy", strike_ce=24500, marks=[
        mark("entry", at(9, 45)), mark("entry", at(9, 51)), mark("exit", at(10, 3)), mark("exit", at(10, 30)), mark("exit", at(9, 48))])
    bars = FakeBars({
        (None, None): {(9, 45): (100, 101), (9, 48): (101, 102), (9, 51): (103, 104), (10, 3): (110, 112), (10, 30): (108, 109)},
        ("CE", 24500): {(9, 45): (50, 51), (9, 51): (52, 53), (10, 3): (70, 71), (10, 30): (60, 61), (9, 48): (51, 52)}})
    result, _ = review(bars, [])
    buy = result["setups"][0]
    theory = {t["instrument"]: t for t in buy["theoretical"]}
    # underlying: best pair is entry 09:45 open 100 -> exit 10:03 close 112 (+12), not the 09:51 entry (+9) or the 10:30 exit (+9)
    assert (theory["underlying"]["entry"]["price"], theory["underlying"]["exit"]["price"], theory["underlying"]["points"]) == (100.0, 112.0, 12.0)
    assert theory["underlying"]["pct"] == 12.0 and theory["underlying"]["entry"]["clock"] == "09:45" and theory["underlying"]["exit"]["clock"] == "10:03"
    assert (theory["CE"]["points"], theory["CE"]["strike"]) == (21.0, 24500)  # 50 -> 71
    # a pair whose exit is before its entry is never used: the 09:48 exit only pairs with the 09:45 entry
    assert buy["recorded"]["entry"]["clock"] == "09:45" and buy["recorded"]["exit"]["clock"] == "10:30"


def test_a_sell_setup_is_a_short_on_the_underlying_and_a_long_option(database):
    mark_day(side="sell", strike_pe=24400, marks=[mark("entry", at(9, 45)), mark("exit", at(10, 3))])
    bars = FakeBars({(None, None): {(9, 45): (100, 99), (10, 3): (90, 80)}, ("PE", 24400): {(9, 45): (50, 51), (10, 3): (70, 75)}})
    theory = {t["instrument"]: t for t in review(bars, [])[0]["setups"][0]["theoretical"]}
    assert theory["underlying"]["points"] == 20.0    # short from 100 to 80
    assert theory["PE"]["points"] == 25.0            # bought at 50, closed at 75


def test_missing_bars_and_missing_marks_explain_themselves(database):
    mark_day(side="buy", strike_ce=24500, marks=[mark("entry", at(9, 45)), mark("exit", at(10, 3))])
    only_underlying = FakeBars({(None, None): {(9, 45): (100, 101), (10, 3): (110, 112)}})  # the option has no data
    theory = {t["instrument"]: t for t in review(only_underlying, [])[0]["setups"][0]["theoretical"]}
    assert theory["underlying"]["points"] == 12.0 and "No price data" in theory["CE"]["unavailable"]
    no_candle = FakeBars({(None, None): {(9, 45): (100, 101)}, ("CE", 24500): {(9, 45): (50, 51)}})  # nothing traded at the exit minute
    assert all("no trades" in t["unavailable"] for t in review(no_candle, [], day=DAY)[0]["setups"][0]["theoretical"])


def test_entry_only_marks_give_timing_but_no_theoretical_pnl(database):
    mark_day(marks=[mark("entry", at(9, 45))])
    result, _ = review(FakeBars({}), [trip(0, "BUY", None, None, (9, 48), 100.0, (10, 0), 105.0)])
    assert "Needs both" in result["setups"][0]["theoretical"][0]["unavailable"]
    assert result["setups"][0]["trades"][0]["entry_delta_min"] == 3 and result["setups"][0]["trades"][0]["capture_pct"] is None


def test_your_trades_are_compared_with_the_recorded_day(database):
    mark_day(side="buy", strike_ce=24500, outcome="success", strength="ideal",
             marks=[mark("entry", at(9, 45)), mark("exit", at(10, 30))])
    bars = FakeBars({(None, None): {(9, 45): (100, 101), (10, 30): (118, 120)},
                     ("CE", 24500): {(9, 45): (50, 52), (10, 30): (80, 90)}})
    trips = [trip(0, "BUY", "CE", 24500, (9, 51), 55.0, (10, 24), 75.0, qty=75),   # a CE bought at 09:51, sold 10:24
             trip(1, "SELL", "CE", 24500, (10, 40), 60.0, (10, 45), 58.0),            # a short CE is a Sell-side trade: no recorded Sell day
             ]
    result, sid = review(bars, trips)
    buy = result["setups"][0]
    assert (result["category"], result["strategy"], result["session_id"]) == (CAT, STRAT, sid)
    assert buy["side"] == "buy" and buy["outcome"] == "success" and buy["strength"] == "ideal" and buy["annotations"]
    t = buy["trades"][0]
    assert (t["entry_delta_min"], t["exit_delta_min"]) == (6, -6)         # 09:51 vs 09:45 is 6 late; 10:24 vs 10:30 is 6 early
    assert (t["points"], t["theoretical_points"], t["capture_pct"]) == (20.0, 40.0, 50.0)  # the CE gave 20 of the 40 on offer
    assert t["theoretical_rupees"] == 3000.0 and t["quantity"] == 75
    assert [o["index"] for o in result["other_trades"]] == [1]
    assert result["summary"] == {"traded": True, "side": "buy", "entry_delta_min": 6, "exit_delta_min": -6, "capture_pct": 50.0,
                                 "points": 20.0, "theoretical_points": 40.0}


def test_a_traded_contract_that_was_not_recorded_is_priced_too(database):
    mark_day(side="buy", marks=[mark("entry", at(9, 45)), mark("exit", at(10, 30))])  # marks on the underlying only, no saved strike
    bars = FakeBars({(None, None): {(9, 45): (100, 101), (10, 30): (118, 120)}, ("CE", 24300): {(9, 45): (40, 41), (10, 30): (70, 72)}})
    result, _ = review(bars, [trip(0, "BUY", "CE", 24300, (9, 48), 42.0, (10, 30), 66.0)])
    assert {t["instrument"] for t in result["setups"][0]["theoretical"]} == {"underlying", "CE"}
    assert result["setups"][0]["trades"][0]["capture_pct"] == 75.0  # 24 of the 32 points from 40 to 72


def test_no_trades_is_a_valid_review(database):
    mark_day()
    result, _ = review(FakeBars({(None, None): {(9, 45): (100, 101), (10, 30): (118, 120)}}), [])
    assert result["summary"] == {"traded": False} and result["setups"][0]["trades"] == [] and result["other_trades"] == []
    assert result["setups"][0]["theoretical"][0]["points"] == 20.0


def test_the_review_is_refused_while_the_session_runs_and_only_for_the_owner(database):
    mark_day()
    running = store_run(state="running")
    with pytest.raises(PermissionError, match="Stop the session"):
        practice.evaluate(USER, running, FakeBars({}))
    assert sim_svc.get_session(running) is not None
    ended = store_run(state="ended", day=DAY)
    with pytest.raises(LookupError):
        practice.evaluate("mallory", ended, FakeBars({}))
    with pytest.raises(LookupError):
        practice.evaluate(USER, "no-such-session", FakeBars({}))
    plain = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER)
    _stored(plain)
    with pytest.raises(LookupError):
        practice.evaluate(USER, plain.session_id, FakeBars({}))  # an ordinary replay has no review


def test_the_run_list_hides_the_answer_until_a_run_has_ended(database):
    mark_day(day="2026-10-06")
    mark_day(day="2026-10-07")
    first = store_run(day="2026-10-06", state="ended", created=1)
    running = store_run(day="2026-10-07", state="running", created=2)
    assert [r["ended"] for r in practice.list_runs(USER)] == [False, True]  # newest first
    assert all(r["result"] is None for r in practice.list_runs(USER))
    with patch("app.services.trade_label_service.compute_round_trips_for_session", return_value=[trip(0, "BUY", None, None, (9, 48), 100.0, (10, 0), 105.0)]):
        practice.evaluate(USER, first, FakeBars({(None, None): {(9, 45): (100, 101), (10, 30): (118, 120)}}))
    runs = {r["session_id"]: r for r in practice.list_runs(USER)}
    assert runs[first]["result"]["entry_delta_min"] == 3 and runs[running]["result"] is None
    assert practice.list_runs("mallory") == []


def test_the_routes_return_the_review_and_map_a_running_session_to_409(database):
    from fastapi.testclient import TestClient
    from app.dependencies import get_request_user_id
    from app.main import app

    mark_day(strike_ce=24500)
    ended, running = store_run(state="ended"), store_run(state="running", day=DAY)
    app.dependency_overrides[get_request_user_id] = lambda: USER
    try:
        client = TestClient(app)
        assert client.get("/api/deep-dive/practice/strategies").json()["strategies"][0]["days"] == 1
        picked = client.post("/api/deep-dive/practice/pick", json={"category": CAT, "strategy": STRAT, "grades": ["open"]})
        assert picked.status_code == 200 and picked.json()["practice"]["strategy"] == STRAT and "side" not in picked.text
        assert client.post("/api/deep-dive/practice/pick", json={"category": CAT, "strategy": STRAT, "grades": ["bogus"]}).status_code == 422
        assert client.post("/api/deep-dive/practice/pick", json={"category": CAT, "strategy": "Nothing"}).status_code == 400
        assert client.get("/api/deep-dive/practice/evaluate", params={"session_id": running}).status_code == 409
        assert client.get("/api/deep-dive/practice/evaluate", params={"session_id": "nope"}).status_code == 404
        with patch("app.services.strategy_practice_service.load_bars", side_effect=FileNotFoundError("no data")), \
             patch("app.services.trade_label_service.compute_round_trips_for_session", return_value=[]):
            body = client.get("/api/deep-dive/practice/evaluate", params={"session_id": ended}).json()
        assert body["setups"][0]["side"] == "buy" and "unavailable" in body["setups"][0]["theoretical"][0]
        assert {r["session_id"] for r in client.get("/api/deep-dive/practice/runs").json()["runs"]} == {ended, running}
    finally:
        app.dependency_overrides.pop(get_request_user_id, None)
