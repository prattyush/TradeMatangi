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


def clock_minutes(text):
    return int(text[:2]) * 60 + int(text[3:5])


def test_a_start_is_never_before_the_open_and_a_day_entered_at_the_open_is_skipped(database):
    mark_day(day="2026-10-06", marks=[mark("entry", at(9, 21))])  # 6 minutes after the open
    mark_day(day="2026-10-07", marks=[mark("entry", at(9, 15))])  # nothing to start before: never offered
    for seed in range(40):
        picked = practice.pick(USER, CAT, STRAT, rng=random.Random(seed))
        assert picked["date"] == "2026-10-06"
        assert clock_minutes(picked["start_time"]) >= 9 * 60 + 15
        assert picked["practice"]["start_offset_min"] == 9 * 60 + 21 - clock_minutes(picked["start_time"])
    with pytest.raises(ValueError, match="No day"):
        practice.pick(USER, CAT, STRAT, symbol="BSESEN")


def test_an_early_entry_is_still_a_random_start_between_the_open_and_the_entry(database):
    """An entry at 09:24 allows only 9 minutes back: 5 to 9, so 09:15 to 09:19. Not 25 minutes (08:59), and not always 09:15."""
    mark_day(marks=[mark("entry", at(9, 24))])
    offsets = set()
    for seed in range(200):
        picked = practice.pick(USER, CAT, STRAT, rng=random.Random(seed))
        start = clock_minutes(picked["start_time"])
        assert 9 * 60 + 15 <= start <= 9 * 60 + 19 and start < 9 * 60 + 24  # inside the session, before the entry
        offsets.add(picked["practice"]["start_offset_min"])
    assert offsets == {5, 6, 7, 8, 9}  # varied, and the 09:15 start is one of five, not the only one
    # the start it picks is accepted when the session starts
    assert practice.build_marker(USER, picked["practice"], "NIFTY", DAY, picked["start_time"])["recorded"]


def test_the_start_offset_edges(database):
    rng = random.Random(0)
    clock = lambda h, m: h * 3600 + m * 60
    assert practice.start_offset_minutes(clock(9, 16), rng) == 1    # one minute after the open: start at 09:15
    assert practice.start_offset_minutes(clock(9, 18), rng) == 3
    assert practice.start_offset_minutes(clock(9, 20), rng) == 5    # exactly 5 minutes of room
    assert {practice.start_offset_minutes(clock(9, 21), rng) for _ in range(100)} == {5, 6}
    assert {practice.start_offset_minutes(clock(9, 40), rng) for _ in range(500)} == set(range(5, 26))  # 25 minutes of room: the full range
    assert {practice.start_offset_minutes(clock(14, 0), rng) for _ in range(500)} == set(range(5, 26))
    for hour_minute in [(9, 16), (9, 24), (9, 30), (9, 40), (11, 2)]:
        entry = clock(*hour_minute)
        for _ in range(50):
            assert entry - practice.start_offset_minutes(entry, rng) * 60 >= clock(9, 15)


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


# ── Negative tests: days the strategy was absent ─────────────────────────────

def two_marked_days(first="2026-10-05", last="2026-10-14"):
    """Marked days at both ends: the days between them (Tue 6 to Tue 13, minus the weekend) were reviewed and not marked."""
    mark_day(day=first)
    mark_day(day=last, marks=[mark("entry", at(10, 0))])


ABSENT = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"]


def test_the_days_between_the_oldest_and_newest_marked_day_are_the_absent_days(database):
    two_marked_days()
    assert practice.negative_days(USER, CAT, STRAT) == {"NIFTY": ABSENT}  # not the weekend, not the marked ends
    mark_day(day="2026-10-08")  # a marked day in between is no longer absent
    assert practice.negative_days(USER, CAT, STRAT)["NIFTY"] == [d for d in ABSENT if d != "2026-10-08"]
    mark_day(day="2026-10-09", marks=[mark("exit", at(10, 0))])  # marked without an Entry: still marked, so not absent
    assert "2026-10-09" not in practice.negative_days(USER, CAT, STRAT)["NIFTY"]


def test_absent_days_are_judged_per_symbol_and_never_from_one_marked_day(database):
    mark_day(day="2026-10-05", symbol="NIFTY")
    assert practice.negative_days(USER, CAT, STRAT) == {}  # a single marked day has no range
    mark_day(day="2026-10-14", symbol="NIFTY")
    mark_day(day="2026-10-08", symbol="BSESEN")  # BSESEN was only reviewed on one day: nothing is known about the days around it
    assert set(practice.negative_days(USER, CAT, STRAT)) == {"NIFTY"}
    assert practice.negative_days("mallory", CAT, STRAT) == {}


def test_absent_days_are_offered_only_when_asked_for_and_about_one_pick_in_four(database):
    two_marked_days()
    assert {practice.pick(USER, CAT, STRAT, rng=random.Random(i))["date"] for i in range(80)} <= {"2026-10-05", "2026-10-14"}  # marked days only
    picks = [practice.pick(USER, CAT, STRAT, rng=random.Random(i), include_negatives=True) for i in range(400)]
    absent = [p for p in picks if p["date"] in ABSENT]
    assert 0.15 < len(absent) / len(picks) < 0.35  # about one in four
    assert {p["date"] for p in picks} - set(ABSENT) <= {"2026-10-05", "2026-10-14"}
    # an absent day looks like any other pick: same keys, a start at the time of a recorded entry, no strikes, never "negative"
    one = absent[0]
    assert set(one) == set(picks[0]) and "negative" not in json.dumps(one).lower()
    assert one["strike_ce"] is None and one["strike_pe"] is None and one["instrument_type"] == "options"
    assert "09:15:00" <= one["start_time"] < "10:00:00"
    # and it can start a run: the server recognises it again
    marker = practice.build_marker(USER, one["practice"], one["symbol"], one["date"], one["start_time"])
    assert marker["negative"] is True and marker["recorded"] == []


def test_a_day_that_is_neither_marked_nor_absent_cannot_start_a_run(database):
    two_marked_days()
    for bad in ("2026-10-10", "2026-10-04", "2026-10-20"):  # a Saturday, before the oldest, after the newest
        with pytest.raises(ValueError, match="no Entry mark"):
            practice.build_marker(USER, PRACTICE, "NIFTY", bad, "09:30:00")
    with pytest.raises(ValueError, match="market hours"):
        practice.build_marker(USER, PRACTICE, "NIFTY", "2026-10-07", "08:00:00")
    with pytest.raises(ValueError, match="market hours"):
        practice.build_marker(USER, PRACTICE, "NIFTY", "2026-10-07", "15:30:00")
    assert practice.build_marker(USER, PRACTICE, "NIFTY", "2026-10-07", "10:05:00")["negative"] is True


def store_negative_run(picked, state="ended", created=5):
    marker = practice.build_marker(USER, picked["practice"], picked["symbol"], picked["date"], picked["start_time"])
    session = sim_svc.create_session(picked["symbol"], picked["date"], picked["start_time"], 1.0, user_id=USER, practice=marker)
    session.created_at = created
    _stored(session)
    sim_svc_table().update_item(Key={"session_id": session.session_id}, UpdateExpression="SET #s = :s",
                                ExpressionAttributeNames={"#s": "state"}, ExpressionAttributeValues={":s": state})
    sim_svc._sessions.pop(session.session_id, None)
    return session.session_id


def test_an_absent_day_is_not_repeated_until_all_were_used(database):
    two_marked_days()
    seen = []
    for i in range(60):  # ask for negatives until every absent day has been practised
        picked = practice.pick(USER, CAT, STRAT, include_negatives=True, rng=random.Random(i))
        if picked["date"] in ABSENT:
            assert picked["date"] not in seen  # never an absent day twice while others were left
            seen.append(picked["date"])
            store_negative_run(picked)
        if len(seen) == len(ABSENT):
            break
    assert sorted(seen) == sorted(ABSENT)


def test_the_review_of_an_absent_day_rewards_staying_out(database):
    two_marked_days()
    picked = next(p for p in (practice.pick(USER, CAT, STRAT, include_negatives=True, rng=random.Random(i)) for i in range(200)) if p["date"] in ABSENT)
    sid = store_negative_run(picked)
    with patch("app.services.trade_label_service.compute_round_trips_for_session", return_value=[]):
        quiet = practice.evaluate(USER, sid, FakeBars({}))
    assert quiet["negative"] is True and quiet["setups"] == [] and quiet["other_trades"] == []
    assert quiet["summary"] == {"traded": False, "negative": True, "correct": True, "points": None}
    trips = [trip(0, "BUY", "CE", 24500, (10, 0), 50.0, (10, 20), 45.0), trip(1, "BUY", None, None, (10, 30), 100.0, (10, 40), 103.0)]
    with patch("app.services.trade_label_service.compute_round_trips_for_session", return_value=trips):
        busy = practice.evaluate(USER, sid, FakeBars({}))
    assert busy["summary"] == {"traded": True, "negative": True, "correct": False, "points": -2.0}  # -5 on the CE, +3 on the underlying
    assert [t["index"] for t in busy["other_trades"]] == [0, 1]
    assert practice.list_runs(USER)[0]["result"]["negative"] is True and practice.list_runs(USER)[0]["result"]["correct"] is False


def test_strategies_report_the_absent_days_and_a_normal_review_says_it_is_not_negative(database):
    two_marked_days()
    assert practice.list_strategies(USER)[0]["negative_days"] == [{"symbol": "NIFTY", "days": 6}]
    result, _ = review(FakeBars({(None, None): {(9, 45): (100, 101), (10, 30): (118, 120)}}), [], day="2026-10-05")
    assert result["negative"] is False


def test_the_pick_route_takes_include_negatives(database):
    from fastapi.testclient import TestClient
    from app.dependencies import get_request_user_id
    from app.main import app

    two_marked_days()
    app.dependency_overrides[get_request_user_id] = lambda: USER
    try:
        client = TestClient(app)
        body = {"category": CAT, "strategy": STRAT, "include_negatives": True}
        dates = {client.post("/api/deep-dive/practice/pick", json=body).json()["date"] for _ in range(60)}
        assert dates & set(ABSENT) and dates - set(ABSENT)
        plain = {client.post("/api/deep-dive/practice/pick", json={"category": CAT, "strategy": STRAT}).json()["date"] for _ in range(30)}
        assert not plain & set(ABSENT)
    finally:
        app.dependency_overrides.pop(get_request_user_id, None)


# ── S18: hardening ───────────────────────────────────────────────────────────

def test_a_day_that_could_not_be_started_is_not_offered_again(database):
    mark_day(day="2026-10-06")
    mark_day(day="2026-10-07")
    for seed in range(30):
        assert practice.pick(USER, CAT, STRAT, rng=random.Random(seed), exclude={("2026-10-06", "NIFTY")})["date"] == "2026-10-07"
    with pytest.raises(ValueError, match="No day"):
        practice.pick(USER, CAT, STRAT, exclude={("2026-10-06", "NIFTY"), ("2026-10-07", "NIFTY")})
    # another symbol's day with the same date is a different day
    assert practice.pick(USER, CAT, STRAT, rng=random.Random(1), exclude={("2026-10-06", "BSESEN"), ("2026-10-07", "BSESEN")})["date"] in ("2026-10-06", "2026-10-07")


def test_an_excluded_absent_day_is_not_offered_either(database):
    two_marked_days()
    seen = {practice.pick(USER, CAT, STRAT, include_negatives=True, rng=random.Random(i), exclude={(d, "NIFTY") for d in ABSENT[:5]})["date"] for i in range(300)}
    assert seen & {ABSENT[5]} and not seen & set(ABSENT[:5])


def test_the_pick_route_takes_the_excluded_days(database):
    from fastapi.testclient import TestClient
    from app.dependencies import get_request_user_id
    from app.main import app

    mark_day(day="2026-10-06")
    mark_day(day="2026-10-07")
    app.dependency_overrides[get_request_user_id] = lambda: USER
    try:
        client = TestClient(app)
        body = {"category": CAT, "strategy": STRAT, "exclude": [{"date": "2026-10-06", "symbol": "NIFTY"}]}
        assert {client.post("/api/deep-dive/practice/pick", json=body).json()["date"] for _ in range(20)} == {"2026-10-07"}
        both = {**body, "exclude": body["exclude"] + [{"date": "2026-10-07", "symbol": "NIFTY"}]}
        assert client.post("/api/deep-dive/practice/pick", json=both).status_code == 400
        assert client.post("/api/deep-dive/practice/pick", json={**body, "exclude": [{"date": "2026-10-06"}]}).status_code == 422
        assert client.post("/api/deep-dive/practice/pick", json={**body, "exclude": [{"date": "x", "symbol": "NIFTY"}] * 101}).status_code == 422
    finally:
        app.dependency_overrides.pop(get_request_user_id, None)


def test_a_run_left_running_by_a_crash_can_be_reviewed_after_twelve_hours(database):
    import time
    mark_day()
    now_ms = int(time.time() * 1000)
    fresh = store_run(state="running", created=now_ms - 3 * 3600 * 1000)       # started three hours ago: still treated as going
    stale = store_run(state="running", created=now_ms - 13 * 3600 * 1000)      # started 13 hours ago: it cannot still be going
    plain = store_run(state="running", created=2)                              # a record without a real timestamp is never taken for stale
    for sid in (fresh, stale, plain):
        sim_svc._sessions.pop(sid, None)  # after a crash nothing is running in memory; only the stored records remain
    assert {r["session_id"]: r["ended"] for r in practice.list_runs(USER)} == {fresh: False, stale: True, plain: False}
    with patch("app.services.trade_label_service.compute_round_trips_for_session", return_value=[]):
        assert practice.evaluate(USER, stale, FakeBars({(None, None): {(9, 45): (100, 101), (10, 30): (118, 120)}}))["session_id"] == stale
    for sid in (fresh, plain):
        with pytest.raises(PermissionError):
            practice.evaluate(USER, sid, FakeBars({}))
    # a session still active in this process is never reviewed, however old its record is
    active = store_run(state="running", created=now_ms - 20 * 3600 * 1000)
    sim_svc._sessions[active] = object()
    with pytest.raises(PermissionError):
        practice.evaluate(USER, active, FakeBars({}))
    sim_svc._sessions.pop(active)


# ── S19: Stepwise ────────────────────────────────────────────────────────────

def test_a_stepwise_start_snaps_down_to_a_bar_boundary_and_never_before_the_open():
    snap = practice.snap_start
    assert snap("09:33:00", 180) == "09:33:00"        # 09:33 is 189 x 180 seconds: already a boundary
    assert snap("09:34:00", 180) == "09:33:00"
    assert snap("09:35:00", 180) == "09:33:00"
    assert snap("09:36:00", 180) == "09:36:00"
    assert snap("09:34:00", 300) == "09:30:00"        # 5 minute bars
    assert snap("09:20:00", 300) == "09:20:00"
    assert snap("09:15:00", 180) == "09:15:00" and snap("09:15:00", 300) == "09:15:00"  # the open is a boundary for these
    assert snap("09:15:00", 120) == "09:15:00"        # for 120 s the bar starts at 09:14: clamped to the open
    assert snap("09:16:00", 120) == "09:16:00" and snap("09:17:00", 120) == "09:16:00"
    assert snap("09:16:30", 120) == "09:16:00"
    for hh in range(9, 14):
        for mm in range(0, 60):
            if (hh, mm) < (9, 15):
                continue
            for interval in (120, 180, 300):
                text = f"{hh:02d}:{mm:02d}:00"
                snapped = snap(text, interval)
                assert snapped <= text and snapped >= "09:15:00"             # never later than the start, never before the open
                assert snapped == "09:15:00" or (int(snapped[:2]) * 3600 + int(snapped[3:5]) * 60) % interval == 0
    with pytest.raises(ValueError):
        snap("soon", 180)


def test_the_stored_offset_is_worked_out_from_the_start_that_was_used(database):
    mark_day(marks=[mark("entry", at(9, 45))])
    marker = practice.build_marker(USER, {**PRACTICE, "start_offset_min": 99}, "NIFTY", DAY, "09:33:00")  # the client's figure is not trusted
    assert marker["start_offset_min"] == 12
    assert practice.build_marker(USER, PRACTICE, "NIFTY", DAY, "09:15:00")["start_offset_min"] == 30


def test_a_stepwise_practice_start_is_accepted_snapped_and_paper_or_real_still_refused(database):
    import asyncio
    from app.models.schemas import SimulationStartRequest
    from app.routers.simulation import _start_simulation_impl

    mark_day(marks=[mark("entry", at(9, 45))])
    seen = {}

    def spy(user_id, practice_in, symbol, date, start_time):
        seen.update(start_time=start_time, practice=practice_in)
        raise ValueError("stop here")  # the rest of the start needs a data feed: only the marker step is under test

    def start(**changes):
        body = {"symbol": "NIFTY", "date": DAY, "start_time": "09:34:00", "session_type": "stepwise", "strategy_interval_secs": 180, "practice": PRACTICE, **changes}
        return asyncio.run(_start_simulation_impl(SimulationStartRequest(**body), user_id=USER))

    with patch("app.services.strategy_practice_service.build_marker", side_effect=spy):
        with pytest.raises(HTTPException) as stopped:
            start()
    assert stopped.value.detail == "stop here" and seen["start_time"] == "09:33:00"  # 09:34 snapped to the 3 minute bar before it
    with patch("app.services.strategy_practice_service.build_marker", side_effect=spy):
        with pytest.raises(HTTPException):
            start(strategy_interval_secs=300)
    assert seen["start_time"] == "09:30:00"
    seen.clear()
    with patch("app.services.strategy_practice_service.build_marker", side_effect=spy):
        with pytest.raises(HTTPException):
            start(session_type="sim")  # a replay start is not snapped
    assert seen["start_time"] == "09:34:00"
    for kind in ("paper", "real"):
        with pytest.raises(HTTPException) as refused:
            start(session_type=kind)
        assert refused.value.status_code == 400 and "replay or stepwise" in refused.value.detail
    # a stepwise start after the first Entry is still refused by the marker itself
    with pytest.raises(HTTPException) as late:
        start(start_time="09:50:00")
    assert "before the first recorded entry" in late.value.detail


def test_a_stepwise_run_lists_its_mode_and_is_reviewed_like_a_replay(database):
    mark_day(strike_ce=24500)
    marker = run_marker()
    stepwise = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, session_type="stepwise", stepwise=True, practice=marker)
    stepwise.created_at = 1
    _stored(stepwise)
    sim_svc_table().update_item(Key={"session_id": stepwise.session_id}, UpdateExpression="SET #s = :s", ExpressionAttributeNames={"#s": "state"}, ExpressionAttributeValues={":s": "ended"})
    sim_svc._sessions.pop(stepwise.session_id, None)
    replay = store_run(state="ended", created=2)
    modes = {r["session_id"]: r["session_type"] for r in practice.list_runs(USER)}
    assert modes == {stepwise.session_id: "stepwise", replay: "sim"}
    bars = FakeBars({(None, None): {(9, 45): (100, 101), (10, 30): (118, 120)}, ("CE", 24500): {(9, 45): (50, 52), (10, 30): (80, 90)}})
    with patch("app.services.trade_label_service.compute_round_trips_for_session", return_value=[trip(0, "BUY", "CE", 24500, (9, 51), 55.0, (10, 24), 75.0)]):
        result = practice.evaluate(USER, stepwise.session_id, bars)
    assert result["setups"][0]["trades"][0]["entry_delta_min"] == 6 and result["summary"]["traded"] is True
    # a stepwise practice run is its own Analysis group, apart from an ordinary stepwise run of that day (the marker is in the key)
    assert analysis_service.compute_session_summary(_stored(stepwise), [])["practice"] == {"category": CAT, "strategy": STRAT}


def test_a_stepwise_practice_run_is_not_the_same_session_as_a_normal_stepwise_run(database):
    mark_day()
    run = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, session_type="stepwise", stepwise=True, practice=run_marker())
    _stored(run)
    assert sim_svc.find_session_by_context(USER, "NIFTY", DAY, "stepwise", "equity") is None
    assert sim_svc.find_all_sessions_by_context(USER, "NIFTY", DAY, "stepwise", "equity") == []  # a normal run's override cannot delete it


def test_a_practice_start_is_never_attached_to_another_screens_session(database):
    import asyncio
    from app.routers import desktop_trading

    mark_day()
    other = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER)
    other.desktop_mode = "replay"  # another screen's ordinary replay of the same day and symbol, still running
    request = desktop_trading.DesktopTradingStartRequest(symbol="NIFTY", date=DAY, start_time="09:30:00", desktop_mode="replay", practice=PRACTICE)
    with pytest.raises(HTTPException) as refused:
        asyncio.run(desktop_trading.start_desktop_trading(request, user_id=USER))
    assert refused.value.status_code == 409 and "Another screen already has a replay session" in refused.value.detail
    assert "practice run" in refused.value.detail
    stepwise = desktop_trading.DesktopTradingStartRequest(symbol="NIFTY", date=DAY, start_time="09:30:00", desktop_mode="stepwise", practice=PRACTICE)
    other.desktop_mode = "stepwise"
    other.session_type = "stepwise"
    with pytest.raises(HTTPException) as refused_stepwise:
        asyncio.run(desktop_trading.start_desktop_trading(stepwise, user_id=USER))
    assert refused_stepwise.value.status_code == 409 and "stepwise session" in refused_stepwise.value.detail


def test_a_desktop_snapshot_shows_no_practice_trades_as_history_and_a_practice_run_shows_none(database):
    from app.routers import desktop_trading

    mark_day()
    marker = run_marker()
    practice_run = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, practice=marker)
    other_practice = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER, practice=marker)
    normal = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER)
    current = sim_svc.create_session("NIFTY", DAY, "09:30:00", 1.0, user_id=USER)
    rows = [_stored(s) for s in (practice_run, other_practice, normal)]
    with patch("app.services.analysis_service.get_sessions_for_user", return_value=rows), \
            patch("app.services.analysis_service.get_trades_for_session", side_effect=lambda sid: [{"session_id": sid}]):
        assert desktop_trading._historical_context_trades(current, USER) == [{"session_id": normal.session_id}]  # practice runs are not that day's history
        assert desktop_trading._historical_context_trades(practice_run, USER) == []                            # a practice run starts clean
