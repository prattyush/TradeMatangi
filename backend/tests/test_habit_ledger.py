"""Phase 23 Sprint 7a — habit ledger: trade features, mark → trade join, coverage, API and desktop proxy."""
from decimal import Decimal

import boto3
import pytest
from fastapi.testclient import TestClient

from app.dependencies import get_desktop_user_id  # noqa: F401  (kept for parity with the desktop tests)
from app.main import app
from app.routers import desktop_analysis
from app.services import behavior_service as bsvc
from app.services import habit_ledger_service as ledger
from app.services import performance_service as perf
from tests.test_phase20_api import database as p20_database  # noqa: F401  (fixture)

USER = "alice"


# ── Pure feature extraction ───────────────────────────────────────────────────

def cycle(index=0, session="s1", state="closed", entries=None, **extra):
    base = dict(
        cycle_id=f"{session}-{index}", session_id=session, index=index, state=state, date="2026-10-05", symbol="NIFTY",
        right=None, strike=None, direction="LONG", net_pnl=100.0, pnl_pct=1.0, entry_time=999_900, exit_time=1_000_000,
        holding_seconds=100, entry_count=1, exit_count=1, trading_style="intraday", shared=False, exits=[{}],
        entries=entries if entries is not None else [{"analytics": {"effective_allocation_pct": 12.5, "effective_risk_pct": 1.5, "strategy_interval_seconds": 180}, "r_multiple": 2.0, "entry_method": "MANUAL"}],
    )
    base.update(extra)
    return base


def test_bars_held_counts_candles_touched():
    assert ledger.bars_held(0, 100, 180) == 1            # entered and exited inside one candle
    assert ledger.bars_held(170, 190, 180) == 2          # crossed one boundary
    assert ledger.bars_held(0, 360, 180) == 3            # exit fill exactly on the 3rd candle open
    assert ledger.bars_held(500, 500, 180) == 1          # same second
    assert ledger.bars_held(500, 400, 180) is None       # exit before entry is unusable
    assert ledger.bars_held(None, 400, 180) is None
    assert ledger.bars_held(0, 100, 0) is None


def test_interval_comes_from_the_entry_analytics_else_default():
    assert ledger.interval_seconds(cycle(entries=[{"analytics": {"strategy_interval_seconds": 300}}])) == 300
    assert ledger.interval_seconds(cycle(entries=[{"analytics": {}}])) == 180
    assert ledger.interval_seconds(cycle(entries=[])) == 180
    assert ledger.interval_seconds(cycle(entries=[{"analytics": {"strategy_interval_seconds": 0}}, {"analytics": {"strategy_interval_seconds": 120}}])) == 120


def test_capital_and_risk_are_summed_over_entries_and_unavailable_when_any_entry_lacks_them():
    scaled = cycle(entries=[{"analytics": {"effective_allocation_pct": 10, "effective_risk_pct": 1}}, {"analytics": {"effective_allocation_pct": 5.5, "effective_risk_pct": 0.5}}])
    assert ledger.capital_pct(scaled) == pytest.approx(15.5) and ledger.risk_pct(scaled) == pytest.approx(1.5)
    legacy = cycle(entries=[{"analytics": {"effective_allocation_pct": 10}}, {"analytics": {}}])
    assert ledger.capital_pct(legacy) is None
    assert ledger.risk_pct(cycle(entries=[{"analytics": {"effective_allocation_pct": 10, "effective_risk_pct": None}}])) is None
    assert ledger.capital_pct(cycle(entries=[])) is None
    assert ledger.capital_pct(cycle(entries=[{"analytics": {"effective_allocation_pct": float("nan")}}])) is None


def test_trade_row_shape_and_rounding():
    row = ledger.trade_row(cycle(net_pnl=123.456, pnl_pct=1.234567, entry_count=2, exit_count=3, strike=24000, right="CE"), ["b", "a", "a"])
    assert row["habits"] == ["a", "b"]
    assert row["net_pnl"] == 123.46 and row["pnl_pct"] == 1.2346
    assert (row["entries"], row["exits"], row["bars"], row["holding_seconds"]) == (2, 3, 1, 100)
    assert row["capital_pct"] == 12.5 and row["risk_pct"] == 1.5 and row["r_multiple"] == 2.0
    assert row["right"] == "CE" and row["strike"] == 24000.0 and row["entry_method"] == "MANUAL"
    # A trade with no usable pnl_pct stays null instead of becoming 0.
    assert ledger.trade_row(cycle(pnl_pct=None))["pnl_pct"] is None


# ── Join, dedupe and coverage ─────────────────────────────────────────────────

def mark(session, index, question, **extra):
    return {"session_id": session, "round_trip_index": index, "question_id": question, "kind": "entry", **extra}


def test_join_attaches_habits_to_closed_trades_only():
    cycles = [cycle(0), cycle(1), cycle(2, state="open", exit_time=None, holding_seconds=None)]
    marks = [mark("s1", 0, "qa"), mark("s1", 1, "qa"), mark("s1", 1, "qb"), mark("s1", 2, "qa")]
    result = ledger.build_ledger(cycles, marks, {}, [{"question_id": "qa"}])
    assert [(t["cycle_id"], t["habits"]) for t in result["trades"]] == [("s1-0", ["qa"]), ("s1-1", ["qa", "qb"])]
    assert result["coverage"] == {
        "closed_trades": 2, "marked_trades": 2, "marks": 3, "unmatched_marks": 0, "open_marked_trades": 1,
        "trades_without_capital": 0, "trades_without_bars": 0, "truncated": False,
    }
    assert result["questions"] == [{"question_id": "qa"}]


def test_marks_without_a_trade_are_counted_not_dropped_silently():
    result = ledger.build_ledger([cycle(0)], [mark("s1", 0, "qa"), mark("s1", 9, "qa"), mark("other", 0, "qa")], {}, [])
    assert result["coverage"]["unmatched_marks"] == 2 and result["coverage"]["marks"] == 1


def test_real_day_aliases_map_to_the_owner_session_and_duplicate_marks_collapse():
    sessions = {"alias": {"session_id": "alias", "broker_projection_owner": "owner"}, "owner": {"session_id": "owner"}}
    cycles = [cycle(0, session="owner", session_type="real")]
    marks = [mark("alias", 0, "qa"), mark("owner", 0, "qa"), mark("alias", 0, "qb")]
    result = ledger.build_ledger(cycles, marks, sessions, [])
    assert result["trades"][0]["habits"] == ["qa", "qb"]
    assert result["coverage"]["marks"] == 2 and result["coverage"]["unmatched_marks"] == 0


def test_shared_and_swing_cycles_never_join_the_viewers_marks():
    cycles = [cycle(0, shared=True), cycle(1, trading_style="swing"), cycle(2)]
    result = ledger.build_ledger(cycles, [mark("s1", 0, "qa"), mark("s1", 1, "qa"), mark("s1", 2, "qa")], {}, [])
    assert [t["cycle_id"] for t in result["trades"]] == ["s1-2"]
    assert result["coverage"]["unmatched_marks"] == 2


def test_rows_are_chronological_and_missing_features_are_counted():
    cycles = [
        cycle(0, entry_time=3_000, date="2026-10-06", entries=[{"analytics": {}}]),
        cycle(1, entry_time=1_000, date="2026-10-05"),
        cycle(2, entry_time=2_000, date="2026-10-05", exit_time=None),
    ]
    result = ledger.build_ledger(cycles, [], {}, [])
    assert [t["cycle_id"] for t in result["trades"]] == ["s1-1", "s1-2", "s1-0"]
    assert result["coverage"]["trades_without_capital"] == 1 and result["coverage"]["trades_without_bars"] == 1


def test_row_cap_keeps_the_most_recent_trades_and_flags_truncation():
    cycles = [cycle(i, entry_time=1_000 + i, date=f"2026-10-{i + 1:02d}") for i in range(5)]
    result = ledger.build_ledger(cycles, [], {}, [], max_rows=3)
    assert [t["cycle_id"] for t in result["trades"]] == ["s1-2", "s1-3", "s1-4"]
    assert result["coverage"]["truncated"] is True and result["coverage"]["closed_trades"] == 5


# ── Database round trip: joins on the real cycle index and reconciles with the Stats summary ─────────

@pytest.fixture
def db(p20_database, monkeypatch):
    client = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
    monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
    monkeypatch.setattr(bsvc, "_QUESTIONS_ENSURED", False)
    monkeypatch.setattr(bsvc, "_MARKS_ENSURED", False)
    return p20_database


DAY = 1_791_447_300  # an IST-as-UTC epoch inside a trading day


def add_session(db, sid, date, user=USER, symbol="NIFTY", session_type="paper", round_trips=((100, 110), (110, 105)), open_leg=False):
    session = dict(session_id=sid, user_id=user, symbol=symbol, date=date, session_capital=Decimal("10000"), session_type=session_type, instrument_type="equity")
    db.Table("Sessions").put_item(Item=session)
    tick, serial = DAY, 0
    for buy, sell in round_trips:
        for side, price in (("BUY", buy), ("SELL", sell)):
            serial += 1
            tick += 200
            db.Table("Trades").put_item(Item=dict(session_id=sid, trade_id=f"{sid}-{serial}", user_id=user, symbol=symbol, side=side, quantity=40, price=Decimal(price), timestamp=tick, commission=Decimal(1)))
    if open_leg:
        serial += 1
        db.Table("Trades").put_item(Item=dict(session_id=sid, trade_id=f"{sid}-{serial}", user_id=user, symbol=symbol, side="BUY", quantity=40, price=Decimal(100), timestamp=tick + 200, commission=Decimal(1)))
    return session


def question(kind, text):
    return bsvc.add_question(USER, text, kind)["question_id"]


def test_ledger_matches_marks_to_the_cycle_index_and_reconciles_with_the_stats_summary(db):
    s1 = add_session(db, "s1", "2026-10-05")
    s2 = add_session(db, "s2", "2026-10-06")
    qa, qb = question("entry", "Chased the move"), question("exit", "Exited early")
    bsvc.set_marks(USER, s1, 0, {qa: True})
    bsvc.set_marks(USER, s1, 1, {qa: True, qb: True})
    bsvc.set_marks(USER, s2, 0, {qb: True})
    criteria = {"start_date": None, "end_date": None}
    result = ledger.load_ledger(USER, criteria)
    habits = {(t["session_id"], t["entry_time"]): t["habits"] for t in result["trades"]}
    assert len(result["trades"]) == 4
    assert [t["habits"] for t in result["trades"] if t["session_id"] == "s1"] == [[qa], sorted([qa, qb])]
    assert [t["habits"] for t in result["trades"] if t["session_id"] == "s2"] == [[qb], []]
    assert result["coverage"] == {**result["coverage"], "closed_trades": 4, "marked_trades": 3, "marks": 4, "unmatched_marks": 0}
    assert {q["question_id"] for q in result["questions"]} == {qa, qb}
    # Reconciliation: the ledger is exactly the closed trades the Stats overview counts.
    cycles = perf.load_cycles(USER, **{**criteria, "include_shared": False})
    summary = perf.report(cycles)["summary"]
    assert len(result["trades"]) == summary["count"]
    assert sum(t["net_pnl"] for t in result["trades"]) == pytest.approx(summary["net_pnl"], abs=0.02)
    pcts = [c["pnl_pct"] for c in cycles if c["state"] == "closed"]
    assert sorted(t["pnl_pct"] for t in result["trades"]) == pytest.approx(sorted(round(p, 4) for p in pcts))
    # The seeded fills are 200 s apart, so every trade spans one or two 3-minute candles.
    assert all(t["holding_seconds"] == 200 and t["bars"] in (1, 2) and t["entries"] == 1 and t["exits"] == 1 for t in result["trades"])
    assert all(t["bars"] == ledger.bars_held(t["entry_time"], t["exit_time"], 180) for t in result["trades"])
    assert habits  # keyed rows exist


def test_filters_scope_both_trades_and_marks(db):
    s1 = add_session(db, "s1", "2026-10-05")
    s2 = add_session(db, "s2", "2026-10-06")
    other = add_session(db, "s3", "2026-10-06", symbol="BANKNIFTY")
    qa = question("entry", "Chased")
    for session in (s1, s2, other):
        bsvc.set_marks(USER, session, 0, {qa: True})
    by_date = ledger.load_ledger(USER, {"start_date": "2026-10-06", "end_date": "2026-10-06"})
    assert {t["session_id"] for t in by_date["trades"]} == {"s2", "s3"}
    assert by_date["coverage"]["marks"] == 2 and by_date["coverage"]["unmatched_marks"] == 0
    by_symbol = ledger.load_ledger(USER, {"symbol": "NIFTY"})
    assert {t["session_id"] for t in by_symbol["trades"]} == {"s1", "s2"}
    assert by_symbol["coverage"]["marks"] == 2 and by_symbol["coverage"]["unmatched_marks"] == 0, "marks of other symbols are out of scope, not unmatched"
    assert ledger.load_ledger(USER, {"session_type": "real"})["trades"] == []


def test_open_trades_unknown_round_trips_and_other_users_are_handled(db):
    s1 = add_session(db, "s1", "2026-10-05", round_trips=((100, 110),), open_leg=True)
    bob_session = add_session(db, "b1", "2026-10-05", user="bob")
    qa = question("entry", "Chased")
    bsvc.set_marks(USER, s1, 0, {qa: True})
    bsvc.set_marks(USER, s1, 1, {qa: True})     # the open trade
    bsvc.set_marks(USER, s1, 7, {qa: True})     # no such trade
    result = ledger.load_ledger(USER, {})
    assert [t["habits"] for t in result["trades"]] == [[qa]]
    assert result["coverage"]["open_marked_trades"] == 1 and result["coverage"]["unmatched_marks"] == 1
    bob_question = bsvc.add_question("bob", "Bob's habit", "exit")["question_id"]
    bsvc.set_marks("bob", bob_session, 0, {bob_question: True})
    mine = ledger.load_ledger(USER, {})
    assert all(t["session_id"] != "b1" for t in mine["trades"]) and bob_question not in {q["question_id"] for q in mine["questions"]}


def test_archived_questions_stay_in_the_ledger(db):
    s1 = add_session(db, "s1", "2026-10-05")
    qa = question("entry", "Old habit")
    bsvc.set_marks(USER, s1, 0, {qa: True})
    bsvc.archive_question(USER, qa)
    result = ledger.load_ledger(USER, {})
    assert result["trades"][0]["habits"] == [qa]
    assert [(q["question_id"], q["status"]) for q in result["questions"]] == [(qa, "archived")]


# ── HTTP + desktop proxy ─────────────────────────────────────────────────────

def test_endpoint_returns_the_ledger_for_the_caller_and_validates_filters(db):
    s1 = add_session(db, "s1", "2026-10-05")
    add_session(db, "b1", "2026-10-05", user="bob")
    qa = question("entry", "Chased")
    bsvc.set_marks(USER, s1, 0, {qa: True})
    client = TestClient(app)
    response = client.get("/api/behavior/habit-ledger?symbol=NIFTY", headers={"X-User-Id": USER})
    assert response.status_code == 200, response.text
    body = response.json()
    assert {t["session_id"] for t in body["trades"]} == {"s1"}
    assert body["trades"][0]["habits"] == [qa] and body["coverage"]["marks"] == 1
    assert client.get("/api/behavior/habit-ledger?start_date=2026-10-09&end_date=2026-10-01", headers={"X-User-Id": USER}).status_code == 422
    assert client.get("/api/behavior/habit-ledger?session_type=bogus", headers={"X-User-Id": USER}).status_code == 422
    assert client.get("/api/behavior/habit-ledger", headers={"X-User-Id": "nobody"}).json()["trades"] == []


def test_desktop_proxy_exposes_the_ledger_read_only(db):
    s1 = add_session(db, "s1", "2026-10-05")
    qa = question("exit", "Exited early")
    bsvc.set_marks(USER, s1, 1, {qa: True})
    app.dependency_overrides[desktop_analysis.get_analysis_user_id] = lambda: USER
    try:
        client = TestClient(app)
        response = client.get("/api/desktop/v1/analysis/behavior/habit-ledger?start_date=2026-10-01")
        assert response.status_code == 200, response.text
        assert response.json()["coverage"]["marks"] == 1
        assert client.post("/api/desktop/v1/analysis/behavior/habit-ledger").status_code in (404, 405)
    finally:
        app.dependency_overrides.pop(desktop_analysis.get_analysis_user_id, None)
