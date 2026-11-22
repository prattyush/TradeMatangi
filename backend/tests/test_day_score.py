"""Phase 27 S6 — the day score: the five rules, the drawdown from candles, the stored score and the guardrail snapshot."""
from decimal import Decimal
from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import day_score_service as svc
from app.services import performance_service
from app.services.performance_service import build_cycles
from tests.test_behavior import database as behavior_database  # noqa: F401  (fixture)
from tests.test_desktop_behavior import as_user  # noqa: F401  (fixture)

SESSION = dict(session_id="s1", user_id="alice", symbol="NIFTY", date="2026-11-16", session_capital=100000, session_type="sim", instrument_type="options")
T0 = 1_763_280_000  # a whole minute (and a whole 3-minute bar)
BAR = 180
CE = dict(right="CE", strike=24500, expiry="2026-11-19")
PE = dict(right="PE", strike=24400, expiry="2026-11-19")


def fill(n, side, quantity, price, at, contract=CE, strategy_interval=BAR, **extra):
    return dict(trade_id=str(n), execution_id=str(n), side=side, quantity=quantity, price=price, timestamp=T0 + at, commission=0, symbol="NIFTY", right=contract["right"],
                strike=contract["strike"], expiry=contract["expiry"], analytics={"strategy_interval_seconds": strategy_interval}, **extra)


def cycles_of(*fills, session=SESSION):
    return build_cycles(session, list(fills))


def trade(n, at, pnl_price, contract=CE, qty=10, side="BUY", hold=60):
    """One closed trade: bought at 100, sold at 100 + pnl_price (a loss when negative), `hold` seconds later."""
    opposite = "SELL" if side == "BUY" else "BUY"
    return [fill(f"{n}a", side, qty, 100, at, contract), fill(f"{n}b", opposite, qty, 100 + pnl_price if side == "BUY" else 100 - pnl_price, at + hold, contract)]


def flat(*groups):
    return cycles_of(*[f for g in groups for f in g])


# ── Rule 2: repeat entries ───────────────────────────────────────────────────

def test_repeat_losses_inside_the_window_form_a_chain():
    # Three losing trades, each entered one minute after the last one closed (the window is three 3-minute bars).
    cycles = flat(trade(1, 0, -5), trade(2, 120, -5), trade(3, 240, -5))
    events = svc.repeat_entry_events(cycles)
    assert [e["position"] for e in events] == [1, 2]
    assert len(set(e["cycle_id"] for e in events)) == 2
    assert svc._escalating(2, svc.CONFIG["repeat_points"]) == 6 + 10


def test_a_slow_re_entry_a_win_or_another_contract_is_not_a_repeat():
    slow = flat(trade(1, 0, -5), trade(2, 60 + BAR * 3 + 1, -5))
    assert svc.repeat_entry_events(slow) == []
    boundary = flat(trade(1, 0, -5), trade(2, 60 + BAR * 3, -5))
    assert len(svc.repeat_entry_events(boundary)) == 1, "exactly three bars after the close still counts"
    win_first = flat(trade(1, 0, +5), trade(2, 120, -5))
    assert svc.repeat_entry_events(win_first) == []
    other = flat(trade(1, 0, -5, CE), trade(2, 120, -5, PE))
    assert svc.repeat_entry_events(other) == []
    # the repeat has to lose too: a quick re-entry that wins ends the chain
    wins_back = flat(trade(1, 0, -5), trade(2, 120, +5), trade(3, 240, -5))
    assert svc.repeat_entry_events(wins_back) == []


def test_the_same_expected_strategy_is_required_only_when_both_are_labelled():
    cycles = flat(trade(1, 0, -5), trade(2, 120, -5))
    first, second = sorted(cycles, key=lambda c: c["entry_time"])
    first["label"], second["label"] = {"expected_strategy": "Breakout"}, {"expected_strategy": "Reversal"}
    assert svc.repeat_entry_events(cycles) == []
    second["label"] = {"expected_strategy": "Breakout"}
    assert len(svc.repeat_entry_events(cycles)) == 1
    second["label"] = {"expected_strategy": ""}  # labelled, but no strategy named: not a different one
    assert len(svc.repeat_entry_events(cycles)) == 1


def test_the_window_uses_the_bar_size_of_the_strategy():
    # The second trade starts 10 minutes after the first closed: too slow on 3-minute bars (9 minutes), a repeat on 5-minute bars (15 minutes).
    def day(interval):
        return cycles_of(fill("1a", "BUY", 10, 100, 0, CE, interval), fill("1b", "SELL", 10, 95, 60, CE, interval),
                         fill("2a", "BUY", 10, 100, 660, CE, interval), fill("2b", "SELL", 10, 95, 720, CE, interval))
    assert svc.repeat_entry_events(day(180)) == []
    assert len(svc.repeat_entry_events(day(300))) == 1


# ── Rule 3: adding to a loser ────────────────────────────────────────────────

def test_adding_to_a_loser_that_ends_in_a_loss_on_both_entries():
    cycles = cycles_of(fill(1, "BUY", 40, 100, 0), fill(2, "BUY", 40, 90, 60), fill(3, "SELL", 80, 80, 120))
    events = svc.add_to_loser_events(cycles)
    assert len(events) == 1 and events[0]["time"] == T0 + 60


def test_adding_that_works_out_is_not_flagged():
    won_back = cycles_of(fill(1, "BUY", 40, 100, 0), fill(2, "BUY", 40, 90, 60), fill(3, "SELL", 80, 120, 120))
    assert svc.add_to_loser_events(won_back) == []
    only_the_second_wins = cycles_of(fill(1, "BUY", 40, 100, 0), fill(2, "BUY", 40, 90, 60), fill(3, "SELL", 80, 95, 120))
    assert svc.add_to_loser_events(only_the_second_wins) == [], "the first entry lost, the second won: not both"
    adding_while_winning = cycles_of(fill(1, "BUY", 40, 100, 0), fill(2, "BUY", 40, 110, 60), fill(3, "SELL", 80, 90, 120))
    assert svc.add_to_loser_events(adding_while_winning) == []


# ── Rule 4: a clean day ──────────────────────────────────────────────────────

def test_clean_day_needs_the_running_closed_pnl_to_stay_at_or_above_zero():
    wins = flat(trade(1, 0, 5), trade(2, 300, 3), trade(3, 600, 2))
    assert svc.clean_day(wins, 100000)["clean"] is True
    dips = flat(trade(1, 0, -1), trade(2, 300, 5), trade(3, 600, 5))
    assert svc.clean_day(dips, 100000)["clean"] is False and svc.clean_day(dips, 100000)["lowest"] == -10
    assert svc.clean_day([], 100000) == {"trades": 0, "clean": False, "lowest": 0.0, "lowest_pct": 0.0, "final": 0.0}


@pytest.mark.parametrize("count,bonus", [(1, 0), (2, 0), (3, 15), (5, 15), (6, 20), (9, 20)])
def test_clean_day_bonus_grows_with_the_number_of_trades(count, bonus):
    cycles = flat(*[trade(n, n * 300, 2) for n in range(count)])
    result = svc.score_day(cycles, capital=100000, limit_pct=12, limit_source="saved", load_frame=lambda c: (None, None, 1))
    assert next(i for i in result["items"] if i["key"] == "clean_day")["points"] == bonus


# ── Rule 5: one loss wiping out the wins before it ───────────────────────────

def test_one_loss_that_wipes_three_wins():
    cycles = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3), trade(4, 900, -9))
    events = svc.big_loss_events(cycles)
    assert len(events) == 1 and events[0]["wins_count"] == 3 and events[0]["multiple"] == 1.0
    assert _wipe_points(events) == -10


def _wipe_points(events):
    return sum(svc._tier(e["multiple"], svc.CONFIG["wipe_tiers"]) for e in events)


def test_the_penalty_grows_with_the_size_of_the_wipe_and_needs_three_wins():
    big = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3), trade(4, 900, -20))
    assert big and svc.big_loss_events(big)[0]["multiple"] == pytest.approx(2.22, abs=0.01) and _wipe_points(svc.big_loss_events(big)) == -16
    huge = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3), trade(4, 900, -30))
    assert _wipe_points(svc.big_loss_events(huge)) == -22
    two_wins = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, -9))
    assert svc.big_loss_events(two_wins) == []
    small_loss = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3), trade(4, 900, -8))
    assert svc.big_loss_events(small_loss) == []
    broken_run = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, -1), trade(4, 900, 3), trade(5, 1200, -30))
    assert svc.big_loss_events(broken_run) == [], "only the wins right before the loss count (one win here)"


def test_system_flags_name_the_cycles_and_habits():
    cycles = flat(trade(1, 0, -5), trade(2, 120, -5))
    flags = svc.system_flags(cycles)
    assert list(flags.values()) == [["sys:repeat_entry"]]


# ── Rule 1: the drawdown from the candles ────────────────────────────────────

def frame(rows):
    """Minute candles: rows are (seconds after T0, low, high); all observed."""
    index = pd.to_datetime([T0 + at for at, _, _ in rows], unit="s", utc=True)
    return pd.DataFrame({"low": [r[1] for r in rows], "high": [r[2] for r in rows], "observed": True}, index=index)


def candles(rows):
    data = frame(rows)
    return lambda cycle: (data, "breeze", 60)


def test_an_open_drawdown_that_recovered_still_counts():
    # Long 100 at 100 from minute 0; the price falls to 90 (a 1,000 loss) in minute 2 and the trade ends at 105 with a profit.
    cycles = cycles_of(fill(1, "BUY", 100, 100, 0), fill(2, "SELL", 100, 105, 600))
    rows = [(m * 60, 99 if m != 2 else 90, 101 if m != 2 else 99) for m in range(0, 12)]
    result = svc.worst_total(cycles, candles(rows))
    assert result["worst"] == pytest.approx(-1000)
    assert result["at"] == T0 + 120 and result["missing"] == 0
    assert cycles[0]["net_pnl"] == 500


def test_a_short_lot_is_marked_at_the_high():
    cycles = cycles_of(fill(1, "SELL", 100, 100, 0), fill(2, "BUY", 100, 95, 600))
    rows = [(m * 60, 99, 110 if m == 3 else 101) for m in range(0, 12)]
    assert svc.worst_total(cycles, candles(rows))["worst"] == pytest.approx(-1000)


def test_closed_losses_are_added_to_the_open_drawdown_of_the_next_trade():
    # A trade closes at -300, then a second trade is under water by 400 at its worst: the day touched -700.
    cycles = flat(trade(1, 0, -3, qty=100, hold=60), [fill("2a", "BUY", 100, 100, 600), fill("2b", "SELL", 100, 98, 900)])
    rows = [(m * 60, 99, 101) for m in range(0, 16)]
    rows[11] = (11 * 60, 96, 99)
    result = svc.worst_total(cycles, candles(rows))
    assert result["worst"] == pytest.approx(-700)


def test_without_candles_the_closed_trades_still_give_a_lower_bound_and_it_is_partial():
    cycles = flat(trade(1, 0, -3, qty=100), trade(2, 300, -2, qty=100))
    result = svc.worst_total(cycles, lambda c: (None, None, 1))
    assert result["worst"] == pytest.approx(-500) and result["missing"] == 1
    scored = svc.score_day(cycles, capital=100000, limit_pct=12, limit_source="saved", load_frame=lambda c: (None, None, 1))
    assert scored["drawdown"]["partial"] is True


@pytest.mark.parametrize("limit,points,share", [(12.0, 0, 0.0), (2.0, -8, 0.5), (1.34, -8, 0.746), (1.33, -14, 0.752), (1.0, -25, 1.0), (0.6, -35, 1.667)])
def test_drawdown_points_step_up_at_50_75_100_and_150_percent_of_the_limit(limit, points, share):
    # A 1,000 drawdown on 100,000 capital is 1%.
    cycles = cycles_of(fill(1, "BUY", 100, 100, 0), fill(2, "SELL", 100, 105, 600))
    rows = [(m * 60, 99 if m != 2 else 90, 101) for m in range(0, 12)]
    if limit == 12.0:
        rows = [(m * 60, 99.9, 101) for m in range(0, 12)]  # a 10 rupee dip: 0.01%
    result = svc.score_day(cycles, capital=100000, limit_pct=limit, limit_source="saved", load_frame=candles(rows))
    assert next(i for i in result["items"] if i["key"] == "drawdown")["points"] == points


# ── The score, the limits and the day statuses ───────────────────────────────

def test_score_is_the_base_plus_every_rule_clamped_to_0_100():
    clean = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3))
    result = svc.score_day(clean, capital=100000, limit_pct=12, limit_source="saved", load_frame=lambda c: (None, None, 1))
    assert result["score"] == svc.CONFIG["base"] + 15 and result["closed"] == 3
    awful = flat(*[trade(n, n * 150, -9, qty=5000) for n in range(8)])
    low = svc.score_day(awful, capital=100000, limit_pct=1, limit_source="saved", load_frame=lambda c: (None, None, 1))
    assert low["score"] == 0
    assert all({"key", "title", "points", "detail"} <= set(i) for i in low["items"]) and [i["key"] for i in low["items"]] == list(svc.RULES)


def test_a_session_without_a_saved_limit_uses_the_fixed_legacy_limit():
    assert svc.session_limit({"guardrail_limit_snapshot": {"ban_capital_pct": Decimal("8.5"), "ban_enabled": True}}) == (8.5, "saved")
    assert svc.session_limit({}) == (12.0, "estimated")
    assert svc.session_limit({"guardrail_limit_snapshot": {"ban_capital_pct": Decimal("0")}}) == (12.0, "estimated")
    assert svc.LEGACY_GUARDRAIL_LIMIT_PCT == 12.0


@pytest.fixture
def database(behavior_database, monkeypatch):
    monkeypatch.setattr(svc, "_ENSURED", False)
    return behavior_database


def stub_day(monkeypatch, sessions, cycles_by_session):
    monkeypatch.setattr(svc, "_day_sessions", lambda user, date: [s for s in sessions if s["date"] == date])
    monkeypatch.setattr(performance_service, "load_session_cycles", lambda session, **kw: cycles_by_session[session["session_id"]])


def labelled(cycles, strategy="Breakout"):
    for c in cycles:
        c["label"] = {"expected_strategy": strategy}
    return cycles


NO_CANDLES = lambda c: (None, None, 1)  # noqa: E731


def test_status_is_no_trades_then_pending_labels_then_scored(database, monkeypatch):
    stub_day(monkeypatch, [], {})
    assert svc.compute_day("alice", "2026-11-16")["status"] == "no_trades"
    cycles = flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3))
    stub_day(monkeypatch, [{**SESSION, "guardrail_limit_snapshot": {"ban_capital_pct": 10.0}}], {"s1": cycles})
    pending = svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)
    assert pending["status"] == "pending_labels" and pending["labelled"] == 0 and pending["closed"] == 3 and pending["score"] is None
    labelled(cycles[:2])
    assert svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)["labelled"] == 2
    labelled(cycles)
    done = svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)
    assert done["status"] == "scored" and done["score"] == 75
    assert done["limit_pct"] == 10.0 and done["limit_source"] == "saved" and done["capital"] == 100000


def test_a_pending_day_says_which_session_still_has_trades_without_a_label(database, monkeypatch):
    # The score is for the whole date: one session fully labelled does not make the day scorable while another one is not.
    a = labelled(flat(trade(1, 0, 3), trade(2, 300, 3)))
    other = {**SESSION, "session_id": "s2", "symbol": "BSESEN", "session_type": "paper", "created_at": 2}
    b = cycles_of(*[f for g in [trade(3, 900, 3), trade(4, 1200, 3), trade(5, 1500, 3)] for f in g], session=other)
    labelled(b[:1])
    stub_day(monkeypatch, [SESSION, other], {"s1": a, "s2": b})
    pending = svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)
    assert pending["status"] == "pending_labels" and pending["labelled"] == len(a) + 1 and pending["closed"] == len(a) + len(b)
    assert [(r["session_id"], r["session_type"], r["symbol"], r["count"], len(r["trades"])) for r in pending["unlabelled"]] == [("s2", "paper", "BSESEN", len(b) - 1, len(b) - 1)]
    assert set(pending["unlabelled"][0]["trades"][0]) == {"entry_time", "right", "strike", "direction"}
    labelled(b)
    assert svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)["status"] == "scored"


def test_a_pending_day_writes_one_diagnostic_line_per_change(database, monkeypatch, caplog):
    import json
    import logging
    svc._LOGGED.clear()
    a = labelled(flat(trade(1, 0, 3), trade(2, 300, 3)))
    other = {**SESSION, "session_id": "s2", "symbol": "BSESEN", "session_type": "paper", "created_at": 2}
    b = cycles_of(*[f for g in [trade(3, 900, 3), trade(4, 1200, 3)] for f in g], session=other)
    stub_day(monkeypatch, [SESSION, other], {"s1": a, "s2": b})
    monkeypatch.setattr(svc, "_user_session_rows", lambda user: [SESSION, other, {**SESSION, "session_id": "s3", "date": "2026-11-16", "practice": {"strategy": "x"}}])
    from app.services import trade_label_service, analysis_service
    monkeypatch.setattr(trade_label_service, "compute_round_trips_for_session", lambda sid: [])
    monkeypatch.setattr(trade_label_service, "get_labels_for_session", lambda sid: [{"round_trip_index": 0, "analytics_cycle_id": None, "expected_strategy": "S"}])
    monkeypatch.setattr(analysis_service, "get_trades_for_session", lambda sid: [{"side": "BUY", "quantity": 10, "timestamp": 1, "trade_id": "t1"}])
    with caplog.at_level(logging.INFO, logger=svc.logger.name):
        svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)
        svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)  # nothing changed: not written again
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("DAYSCORE-DIAG")]
    assert len(lines) == 1
    data = json.loads(lines[0].split(" ", 1)[1])
    assert data["status"] == "pending_labels" and data["closed"] == len(a) + len(b) and data["labelled"] == len(a)
    assert {r["id"]: r["skipped"] for r in data["session_rows_of_the_date"]} == {"s1": None, "s2": None, "s3": "practice"}
    scored = {d["id"]: d for d in data["scored_sessions"]}
    assert scored["s1"]["unlabelled"] == [] and len(scored["s2"]["unlabelled"]) == len(b) and scored["s2"]["fills"] and scored["s1"]["fills"] == []
    assert scored["s2"]["unlabelled"][0]["index_has_label_row"] in (True, False) and "fills" in scored["s2"]["unlabelled"][0]


def test_two_sessions_on_a_day_use_the_strictest_limit_and_are_estimated_if_any_is(database, monkeypatch):
    a = flat(trade(1, 0, 3), trade(2, 300, 3))
    other = {**SESSION, "session_id": "s2", "created_at": 2}
    b = cycles_of(*[f for g in [trade(3, 900, 3)] for f in g], session=other)
    labelled(a); labelled(b)
    stub_day(monkeypatch, [{**SESSION, "guardrail_limit_snapshot": {"ban_capital_pct": 10.0}}, other], {"s1": a, "s2": b})
    result = svc.compute_day("alice", "2026-11-16", load_frame=NO_CANDLES)
    assert result["limit_pct"] == 10.0 and result["limit_source"] == "estimated" and result["sessions"] == 2


def test_the_score_is_stored_and_reused_until_a_trade_or_label_changes(database, monkeypatch):
    cycles = labelled(flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3)))
    stub_day(monkeypatch, [dict(SESSION)], {"s1": cycles})
    calls = []
    original = svc.score_day
    monkeypatch.setattr(svc, "score_day", lambda *a, **k: calls.append(1) or original(*a, **{**k, "load_frame": NO_CANDLES}))
    first = svc.get_day_score("alice", "2026-11-16")
    assert first["status"] == "scored" and len(calls) == 1
    again = svc.get_day_score("alice", "2026-11-16")
    assert again["score"] == first["score"] and len(calls) == 1, "served from the table"
    assert svc.list_scores("alice")[0]["date"] == "2026-11-16" and svc.list_scores("alice")[0]["score"] == first["score"]
    cycles[0]["label"] = {"expected_strategy": "Reversal"}  # a label changed
    svc.get_day_score("alice", "2026-11-16")
    assert len(calls) == 2
    cycles[0]["net_pnl"] = -50.0  # a fill changed
    assert svc.get_day_score("alice", "2026-11-16")["score"] != first["score"] and len(calls) == 3
    cycles[1]["label"] = None  # a label was removed: the day cannot be scored, and the old score is dropped
    assert svc.get_day_score("alice", "2026-11-16")["status"] == "pending_labels"
    assert svc.list_scores("alice") == []
    assert svc.list_scores("bob") == []


def test_range_lists_stored_scores_and_computes_a_bounded_number_of_missing_days(database, monkeypatch):
    days = [f"2026-11-{n:02d}" for n in range(1, 11)]
    sessions = [{**SESSION, "session_id": f"s{n}", "date": d} for n, d in enumerate(days)]
    cycles = {s["session_id"]: labelled(cycles_of(*[f for g in [trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3)] for f in g], session=s)) for s in sessions}
    stub_day(monkeypatch, sessions, cycles)
    monkeypatch.setattr(svc, "session_dates", lambda user, start=None, end=None: [d for d in days if (not start or d >= start) and (not end or d <= end)])
    original = svc.score_day
    monkeypatch.setattr(svc, "score_day", lambda *a, **k: original(*a, **{**k, "load_frame": NO_CANDLES}))
    assert svc.scores_in_range("alice", "2026-11-01", "2026-11-30") == {"scores": [], "pending": 0}
    monkeypatch.setattr(svc, "MAX_RANGE_COMPUTE", 4)
    first = svc.scores_in_range("alice", "2026-11-01", "2026-11-30", compute=True)
    assert [r["date"] for r in first["scores"]] == days[-4:] and first["pending"] == 6, "the newest days first"
    rest = svc.scores_in_range("alice", "2026-11-01", "2026-11-30", compute=True)
    assert len(rest["scores"]) == 8 and rest["pending"] == 2
    assert svc.scores_in_range("alice", "2026-11-03", "2026-11-05")["scores"][0]["date"] == "2026-11-03"


@pytest.mark.parametrize("date", ["", "2026-13-01", "yesterday"])
def test_a_bad_date_is_refused(database, date):
    with pytest.raises(ValueError):
        svc.get_day_score("alice", date)


# ── API ──────────────────────────────────────────────────────────────────────

def test_api_and_desktop_routes_are_owner_only_and_read_only(database, monkeypatch, as_user):
    cycles = labelled(flat(trade(1, 0, 3), trade(2, 300, 3), trade(3, 600, 3)))
    stub_day(monkeypatch, [dict(SESSION)], {"s1": cycles})
    original = svc.score_day
    monkeypatch.setattr(svc, "score_day", lambda *a, **k: original(*a, **{**k, "load_frame": NO_CANDLES}))
    client = TestClient(app)
    web = client.get("/api/analysis/day-score?date=2026-11-16", headers={"X-User-Id": "alice"}).json()
    assert web["status"] == "scored" and web["score"] == 75 and [i["key"] for i in web["items"]] == list(svc.RULES)
    assert client.get("/api/analysis/day-score?date=bad", headers={"X-User-Id": "alice"}).status_code == 400
    desktop = client.get("/api/desktop/v1/analysis/day-score?date=2026-11-16").json()
    assert desktop["score"] == 75
    assert client.get("/api/desktop/v1/analysis/day-scores").json()["scores"][0]["score"] == 75
    for method, path in (("post", "/api/desktop/v1/analysis/day-score"), ("put", "/api/desktop/v1/analysis/day-score"), ("delete", "/api/desktop/v1/analysis/day-scores")):
        assert getattr(client, method)(path).status_code in (404, 405), (method, path)


# ── The guardrail snapshot ───────────────────────────────────────────────────

def test_the_snapshot_reads_the_users_limit_and_never_raises(monkeypatch):
    from app.services import guardrail_service, user_settings_service
    monkeypatch.setattr(user_settings_service, "get_settings", lambda user: {"guardrail_ban_capital_pct": 8.0, "guardrail_ban_enabled": True})
    assert guardrail_service.guardrail_limit_snapshot("alice") == {"ban_capital_pct": 8.0, "ban_enabled": True}
    monkeypatch.setattr(user_settings_service, "get_settings", lambda user: {})
    assert guardrail_service.guardrail_limit_snapshot("alice") == {"ban_capital_pct": 10.0, "ban_enabled": False}
    def boom(user): raise RuntimeError("no settings table")
    monkeypatch.setattr(user_settings_service, "get_settings", boom)
    assert guardrail_service.guardrail_limit_snapshot("alice") is None


class FakeTable:
    def __init__(self): self.items = []
    def put_item(self, Item): self.items.append(Item)


def test_the_snapshot_is_written_with_the_session_and_read_back_on_resume(monkeypatch):
    from app.services import simulation as sim
    table = FakeTable()
    monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: SimpleNamespace(Table=lambda name: table))
    session = sim.SimulationSession(session_id="x1", symbol="NIFTY", date="2026-11-16", start_time="09:15:00", speed=1.0)
    session.user_id = "alice"
    session.guardrail_limit_snapshot = {"ban_capital_pct": 8.0, "ban_enabled": True}
    sim._upsert_session_to_db(session)
    saved = table.items[-1]["guardrail_limit_snapshot"]
    assert saved == {"ban_capital_pct": Decimal("8.0"), "ban_enabled": True}
    # a session without a snapshot (created before this change) writes no such field
    older = sim.SimulationSession(session_id="x2", symbol="NIFTY", date="2026-11-16", start_time="09:15:00", speed=1.0)
    older.user_id = "alice"
    sim._upsert_session_to_db(older)
    assert "guardrail_limit_snapshot" not in table.items[-1]


def test_a_resumed_session_reads_its_saved_limit_back_and_keeps_writing_it(monkeypatch):
    from app.services import simulation as sim
    row = {"guardrail_limit_snapshot": {"ban_capital_pct": Decimal("8.5"), "ban_enabled": True}}
    assert sim.limit_snapshot_from_record(row) == {"ban_capital_pct": 8.5, "ban_enabled": True}
    assert sim.limit_snapshot_from_record({}) is None
    assert sim.limit_snapshot_from_record({"guardrail_limit_snapshot": "junk"}) is None
    assert sim.limit_snapshot_from_record({"guardrail_limit_snapshot": {"ban_capital_pct": "x"}}) is None
    # The setting changed after the session was created: the resumed session still writes the old limit.
    table = FakeTable()
    monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: SimpleNamespace(Table=lambda name: table))
    session = sim.SimulationSession(session_id="x3", symbol="NIFTY", date="2026-11-16", start_time="09:15:00", speed=1.0)
    session.user_id = "alice"
    session.guardrail_limit_snapshot = sim.limit_snapshot_from_record(row)
    session.guardrail_ban_capital_pct = 20.0  # what initialize_guardrails re-reads from today's settings
    sim._upsert_session_to_db(session)
    assert table.items[-1]["guardrail_limit_snapshot"]["ban_capital_pct"] == Decimal("8.5")


def test_notes_tab_rule_numbers_match_the_config():
    """The Notes tab explains each rule with `RULE_NUMBERS` in `shared/analysis/dayScore/ruleHelp.ts`; it must be a copy of `CONFIG`."""
    import json
    import re
    from pathlib import Path

    source = (Path(__file__).resolve().parents[2] / "shared" / "analysis" / "dayScore" / "ruleHelp.ts").read_text()
    literal = re.search(r"export const RULE_NUMBERS = (\{.*?\n\})", source, re.S).group(1)
    literal = re.sub(r"(\w+):", r'"\1":', literal)  # keys to JSON
    literal = re.sub(r",(\s*[}\]])", r"\1", literal)  # trailing commas
    shown = json.loads(literal)
    config = svc.CONFIG
    assert shown["base"] == config["base"]
    assert shown["drawdownTiers"] == [list(tier) for tier in config["drawdown_tiers"]]
    assert shown["repeatWindowBars"] == config["repeat_window_bars"]
    assert shown["defaultBarSeconds"] == config["default_bar_seconds"]
    assert shown["repeatPoints"] == list(config["repeat_points"])
    assert shown["addPoints"] == list(config["add_points"])
    assert shown["cleanDayTiers"] == [list(tier) for tier in config["clean_day_tiers"]]
    assert shown["wipeMinWins"] == config["wipe_min_wins"]
    assert shown["wipeTiers"] == [list(tier) for tier in config["wipe_tiers"]]
