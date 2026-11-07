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


def add_session(db, sid, date, user=USER, symbol="NIFTY", session_type="paper", round_trips=((100, 110), (110, 105)), open_leg=False, created_at=None):
    session = dict(session_id=sid, user_id=user, symbol=symbol, date=date, session_capital=Decimal("10000"), session_type=session_type, instrument_type="equity")
    if created_at is not None:
        session["created_at"] = Decimal(created_at)
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


# ── Run-on (session created_at) filter and session order ─────────────────────

def utc_ms(text):
    """UTC epoch milliseconds for an ISO instant, e.g. ``2026-10-12T20:00:00+00:00``."""
    from datetime import datetime

    return int(datetime.fromisoformat(text).timestamp() * 1000)


def test_run_on_filter_selects_sessions_by_the_ist_day_they_were_run(db):
    # Replayed dates are unrelated to when the sessions were run; 20:00 UTC on 12 Oct is already 13 Oct in IST.
    add_session(db, "old", "2026-01-05", created_at=utc_ms("2026-10-11T05:00:00+00:00"))
    add_session(db, "late", "2026-01-06", created_at=utc_ms("2026-10-12T20:00:00+00:00"))
    add_session(db, "new", "2026-01-07", created_at=utc_ms("2026-10-13T05:00:00+00:00"))
    add_session(db, "legacy", "2026-01-08")  # no created_at: never matches a Run-on range
    assert {t["session_id"] for t in ledger.load_ledger(USER, {"created_from": "2026-10-13", "created_to": "2026-10-13"})["trades"]} == {"late", "new"}
    assert {t["session_id"] for t in ledger.load_ledger(USER, {"created_to": "2026-10-12"})["trades"]} == {"old"}
    assert {t["session_id"] for t in ledger.load_ledger(USER, {"created_from": "2026-10-12"})["trades"]} == {"late", "new"}
    assert {t["session_id"] for t in ledger.load_ledger(USER, {})["trades"]} == {"old", "late", "new", "legacy"}
    # The Stats overview applies the same predicate, so Performance and Habits still reconcile.
    cycles = perf.load_cycles(USER, created_from="2026-10-13", created_to="2026-10-13")
    assert {c["session_id"] for c in cycles} == {"late", "new"}


def test_run_on_filter_scopes_marks_with_their_sessions(db):
    inside = add_session(db, "in", "2026-01-05", created_at=utc_ms("2026-10-13T05:00:00+00:00"))
    outside = add_session(db, "out", "2026-01-05", created_at=utc_ms("2026-10-01T05:00:00+00:00"))
    qa = question("entry", "Chased")
    bsvc.set_marks(USER, inside, 0, {qa: True})
    bsvc.set_marks(USER, outside, 0, {qa: True})
    result = ledger.load_ledger(USER, {"created_from": "2026-10-13"})
    assert {t["session_id"] for t in result["trades"]} == {"in"}
    assert result["coverage"]["marks"] == 1 and result["coverage"]["unmatched_marks"] == 0


def test_ledger_is_in_the_order_sessions_were_run_not_the_replayed_date(db):
    # Two sessions on the same replayed day, then one replayed from an earlier date but run last.
    add_session(db, "first", "2026-03-10", created_at=utc_ms("2026-10-13T04:00:00+00:00"))
    add_session(db, "second", "2026-03-10", created_at=utc_ms("2026-10-13T06:00:00+00:00"))
    add_session(db, "third", "2026-02-01", created_at=utc_ms("2026-10-14T04:00:00+00:00"))
    trades = ledger.load_ledger(USER, {})["trades"]
    assert [t["session_id"] for t in trades] == ["first", "first", "second", "second", "third", "third"]
    assert [t["session_seq"] for t in trades] == [0, 0, 1, 1, 2, 2]
    assert trades[0]["created_date"] == "2026-10-13" and trades[-1]["created_date"] == "2026-10-14"


def test_run_on_range_validation_and_desktop_passthrough(db):
    add_session(db, "s1", "2026-01-05", created_at=utc_ms("2026-10-13T05:00:00+00:00"))
    add_session(db, "s2", "2026-01-05", created_at=utc_ms("2026-10-20T05:00:00+00:00"))
    client = TestClient(app)
    headers = {"X-User-Id": USER}
    assert client.get("/api/behavior/habit-ledger?created_from=2026-10-20&created_to=2026-10-01", headers=headers).status_code == 422
    assert client.get("/api/analysis/performance?created_from=2026-10-20&created_to=2026-10-01", headers=headers).status_code == 422
    body = client.get("/api/behavior/habit-ledger?created_from=2026-10-13&created_to=2026-10-14", headers=headers).json()
    assert {t["session_id"] for t in body["trades"]} == {"s1"}
    app.dependency_overrides[desktop_analysis.get_analysis_user_id] = lambda: USER
    try:
        desktop = client.get("/api/desktop/v1/analysis/behavior/habit-ledger?created_from=2026-10-19")
        assert desktop.status_code == 200, desktop.text
        assert {t["session_id"] for t in desktop.json()["trades"]} == {"s2"}
        report = client.get("/api/desktop/v1/analysis/performance?created_from=2026-10-19")
        assert report.status_code == 200 and report.json()["summary"]["count"] == 2
    finally:
        app.dependency_overrides.pop(desktop_analysis.get_analysis_user_id, None)


def test_created_date_ist_handles_missing_and_boundary_values():
    assert perf.created_date_ist(None) is None and perf.created_date_ist(0) is None and perf.created_date_ist("bad") is None
    assert perf.created_date_ist(utc_ms("2026-10-12T18:29:59+00:00")) == "2026-10-12"
    assert perf.created_date_ist(utc_ms("2026-10-12T18:30:00+00:00")) == "2026-10-13"


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


# ── Sprint 8 hardening ───────────────────────────────────────────────────────

def test_swing_scope_returns_an_empty_ledger_without_reading_cycles(db, monkeypatch):
    qa = question("entry", "Chased")
    monkeypatch.setattr(perf, "load_cycles", lambda *a, **k: (_ for _ in ()).throw(AssertionError("swing books must not be read")))
    result = ledger.load_ledger(USER, {"trading_style": "swing"})
    assert result["trades"] == [] and [q["question_id"] for q in result["questions"]] == [qa]
    assert result["coverage"]["closed_trades"] == 0


def test_ledger_reads_only_intraday_sessions(db, monkeypatch):
    s1 = add_session(db, "s1", "2026-10-05")
    qa = question("entry", "Chased")
    bsvc.set_marks(USER, s1, 0, {qa: True})
    seen = {}
    real = perf.load_cycles
    monkeypatch.setattr(perf, "load_cycles", lambda user, **scope: seen.update(scope) or real(user, **scope))
    ledger.load_ledger(USER, {"symbol": "NIFTY"})
    assert seen["trading_style"] == "intraday" and seen["include_shared"] is False and seen["symbol"] == "NIFTY"


def test_session_rows_are_fetched_in_batches_of_100_and_unprocessed_keys_are_retried(db, monkeypatch):
    for index in range(230):
        db.Table("Sessions").put_item(Item=dict(session_id=f"x{index:03d}", user_id=USER, date="2026-10-05"))
    calls = []
    real = db.batch_get_item

    def flaky(RequestItems):
        calls.append(len(RequestItems["Sessions"]["Keys"]))
        response = real(RequestItems=RequestItems)
        if len(calls) == 2:  # pretend DynamoDB returned part of the second batch as unprocessed
            keys = RequestItems["Sessions"]["Keys"]
            done = {item["session_id"] for item in response["Responses"]["Sessions"][:40]}
            response = {"Responses": {"Sessions": [i for i in response["Responses"]["Sessions"] if i["session_id"] in done]},
                        "UnprocessedKeys": {"Sessions": {"Keys": [k for k in keys if k["session_id"] not in done], "ConsistentRead": True}}}
        return response

    monkeypatch.setattr(db, "batch_get_item", flaky)
    rows = ledger._fetch_sessions({f"x{index:03d}" for index in range(230)} | {"missing"})
    assert len(rows) == 230 and "missing" not in rows
    assert calls == [100, 100, 60, 31]   # 100, 100 (40 processed), the 60 unprocessed retried, then the last 31 (230 sessions + 1 unknown id)


def test_a_trade_cannot_be_marked_against_an_unbounded_number_of_questions(db):
    s1 = add_session(db, "s1", "2026-10-05")
    client = TestClient(app)
    answers = {f"q{i}": True for i in range(101)}
    response = client.post("/api/behavior/marks", json={"session_id": "s1", "round_trip_index": 0, "answers": answers}, headers={"X-User-Id": USER})
    assert response.status_code == 422
    assert client.post("/api/behavior/marks", json={"session_id": "s1", "round_trip_index": 0, "answers": {}}, headers={"X-User-Id": USER}).status_code == 200


@pytest.mark.parametrize("query", [
    "", "symbol=NIFTY", "symbol=BANKNIFTY", "session_type=paper", "session_type=real", "start_date=2026-10-06", "end_date=2026-10-05",
    "start_date=2026-10-05&end_date=2026-10-06&symbol=NIFTY", "instrument_type=equity", "direction=LONG", "direction=SHORT", "session_type=paper&symbol=NIFTY&direction=LONG",
])
def test_ledger_reconciles_with_the_stats_overview_for_every_filter(db, query):
    """The Habits ledger is exactly the set of closed trades the Stats overview counts, whatever the filters."""
    add_session(db, "s1", "2026-10-05")
    add_session(db, "s2", "2026-10-06", round_trips=((100, 90), (95, 99), (50, 60)))
    add_session(db, "s3", "2026-10-06", symbol="BANKNIFTY", session_type="sim", round_trips=((200, 210),))
    add_session(db, "s4", "2026-10-07", session_type="real", open_leg=True)
    add_session(db, "b1", "2026-10-05", user="bob")
    qa = question("entry", "Chased the move")
    for sid, index in (("s1", 0), ("s2", 1), ("s3", 0)):
        bsvc.set_marks(USER, db.Table("Sessions").get_item(Key={"session_id": sid})["Item"], index, {qa: True})
    client = TestClient(app)
    headers = {"X-User-Id": USER}
    overview = client.get(f"/api/analysis/performance?{query}", headers=headers).json()["summary"]
    result = client.get(f"/api/behavior/habit-ledger?{query}", headers=headers).json()
    assert len(result["trades"]) == overview["count"], query
    assert sum(t["net_pnl"] for t in result["trades"]) == pytest.approx(overview["net_pnl"], abs=0.05), query
    assert result["coverage"]["closed_trades"] == overview["count"]
    cycles = client.get(f"/api/analysis/performance/cycles?limit=200&{query}", headers=headers).json()["items"]
    closed = {c["cycle_id"]: c for c in cycles if c["state"] == "closed"}
    assert {t["cycle_id"] for t in result["trades"]} == set(closed), query
    for row in result["trades"]:
        assert row["pnl_pct"] == pytest.approx(round(closed[row["cycle_id"]]["pnl_pct"], 4)), query


def test_a_large_ledger_is_gzipped_only_when_asked_and_small_ones_never(db, monkeypatch):
    rows = [ledger.trade_row(cycle(i, entry_time=1_000 + i)) for i in range(400)]
    big = {"questions": [], "trades": rows, "coverage": ledger.build_ledger([cycle(0)], [], {}, [])["coverage"]}
    small = {**big, "trades": rows[:3]}
    state = {"data": big}
    monkeypatch.setattr(ledger, "load_ledger", lambda user, criteria: state["data"])
    client = TestClient(app)
    plain = client.get("/api/behavior/habit-ledger", headers={"X-User-Id": USER, "Accept-Encoding": "identity"})
    assert plain.status_code == 200 and "content-encoding" not in plain.headers and len(plain.json()["trades"]) == 400
    assert len(plain.content) > 64 * 1024
    zipped = client.get("/api/behavior/habit-ledger", headers={"X-User-Id": USER, "Accept-Encoding": "gzip"})
    assert zipped.headers["content-encoding"] == "gzip" and zipped.headers["vary"] == "Accept-Encoding"
    assert zipped.json() == plain.json()                               # the client decompresses transparently
    assert zipped.num_bytes_downloaded < len(plain.content) / 10        # bytes on the wire, before the client decompresses
    state["data"] = small
    tiny = client.get("/api/behavior/habit-ledger", headers={"X-User-Id": USER, "Accept-Encoding": "gzip"})
    assert "content-encoding" not in tiny.headers and len(tiny.json()["trades"]) == 3
