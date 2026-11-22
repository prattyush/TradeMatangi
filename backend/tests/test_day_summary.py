"""Phase 27 S10 — the day summary: one card per market date (totals, strategies, labels, best and worst, journeys, score, note) and its routes."""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import day_notes_service, day_score_service, performance_service
from app.services import day_summary_service as svc
from tests.test_behavior import database as behavior_database  # noqa: F401  (fixture)
from tests.test_day_score import SESSION, cycles_of, fill, trade
from tests.test_desktop_behavior import as_user  # noqa: F401  (fixture)

D1, D2, D3 = "2026-11-16", "2026-11-17", "2026-11-18"


def day(date, *trades, session_id="s1", symbol="NIFTY", mode="sim"):
    """The cycles of one session on a date: every trade is a closed cycle; the contract is the same, one after the other."""
    session = {**SESSION, "session_id": session_id, "date": date, "symbol": symbol, "session_type": mode}
    cycles = cycles_of(*[f for t in trades for f in t], session=session)
    for cycle in cycles:
        cycle["symbol"] = symbol
    return cycles


def label(cycle, expected=None, actual=None):
    cycle["label"] = {"expected_strategy": expected, "actual_strategy": actual}
    return cycle


def by_pnl(cycles):
    return sorted(cycles, key=lambda c: c["entry_time"])


def test_a_day_card_has_totals_strategies_labels_best_and_worst():
    cycles = by_pnl(day(D1, trade(1, 0, +5), trade(2, 300, -10), trade(3, 600, +3), trade(4, 900, -2), trade(5, 1200, +1)))
    label(cycles[0], "Breakout", "Breakout")
    label(cycles[1], "Breakout", "Reversal")
    label(cycles[2], "Reversal", "Reversal")
    label(cycles[3], "", "")  # labelled, but no strategy named; the fifth is not labelled at all
    card = svc.build_days(cycles)["days"][0]
    assert card["date"] == D1
    totals = card["totals"]
    assert (totals["trades"], totals["wins"], totals["losses"]) == (5, 3, 2)
    assert totals["net_pnl"] == pytest.approx(50 - 100 + 30 - 20 + 10)
    assert totals["pnl_pct"] == pytest.approx(0.05 - 0.10 + 0.03 - 0.02 + 0.01)
    assert totals["win_pct"] == pytest.approx(60.0)
    # named strategies first (largest net P&L first), then the unnamed, then the unlabelled
    assert [row["strategy"] for row in card["strategies"]] == ["Reversal", "Breakout", svc.NO_STRATEGY, svc.UNLABELLED]
    breakout = card["strategies"][1]
    assert (breakout["trades"], breakout["wins"], breakout["losses"]) == (2, 1, 1)
    assert breakout["net_pnl"] == pytest.approx(-50) and breakout["pnl_pct"] == pytest.approx(-0.05) and breakout["mean_pnl_pct"] == pytest.approx(-0.025)
    assert card["labels"] == {"closed": 5, "labelled": 4, "plan_followed": 2, "plan_not_followed": 1, "plan_unknown": 1}
    assert card["best"]["cycle_id"] == cycles[0]["cycle_id"] and card["best"]["strategy"] == "Breakout"
    assert card["worst"]["cycle_id"] == cycles[1]["cycle_id"] and card["worst"]["net_pnl"] == pytest.approx(-100)
    assert card["worst"]["symbol"] == "NIFTY" and card["worst"]["right"] == "CE" and card["worst"]["session_id"] == "s1"


def test_best_and_worst_exist_only_for_a_win_and_a_loss():
    losing = svc.build_days(day(D1, trade(1, 0, -5), trade(2, 300, -2)))["days"][0]
    assert losing["best"] is None and losing["worst"]["net_pnl"] == pytest.approx(-50)
    winning = svc.build_days(day(D1, trade(1, 0, +5), trade(2, 300, +2)))["days"][0]
    assert winning["worst"] is None and winning["best"]["net_pnl"] == pytest.approx(50)
    flat_day = svc.build_days(day(D1, trade(1, 0, 0)))["days"][0]
    assert flat_day["best"] is None and flat_day["worst"] is None


def test_an_open_trade_is_not_counted_in_the_totals():
    cycles = day(D1, trade(1, 0, +5), [fill("9a", "BUY", 10, 100, 900)])
    card = svc.build_days(cycles)["days"][0]
    assert card["totals"]["trades"] == 1 and card["open_trades"] == 1
    assert card["symbols"][0]["trades"] == 1


def test_symbols_modes_and_one_journey_per_mode():
    cycles = day(D1, trade(1, 0, +5), trade(2, 300, -2)) + day(D1, trade(3, 0, +3), session_id="s2", symbol="BANKNIFTY") \
        + day(D1, trade(4, 0, +1), session_id="s3", mode="paper")
    card = svc.build_days(cycles)["days"][0]
    assert [(s["symbol"], s["trades"], s["modes"], s["session_ids"]) for s in card["symbols"]] == [
        ("NIFTY", 3, ["paper", "sim"], ["s1", "s3"]), ("BANKNIFTY", 1, ["sim"], ["s2"])]
    assert [j["mode"] for j in card["journeys"]] == ["paper", "sim"]
    sim = next(j for j in card["journeys"] if j["mode"] == "sim")
    assert sim["completed"] == 3 and sim["net_pnl"] == pytest.approx(50 - 20 + 30)
    assert "sizing" not in sim and sim["points"], "the journey is the chart's data, without the sizing block"


def test_days_come_newest_first_and_older_ones_are_cut_off():
    cycles = [c for n, date in enumerate(("2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"))
              for c in day(date, trade(n, 0, +1), session_id=f"s{n}")]
    result = svc.build_days(cycles, max_days=3)
    assert [d["date"] for d in result["days"]] == ["2026-11-19", "2026-11-18", "2026-11-17"]
    assert result["total_days"] == 5 and result["truncated"] is True
    full = svc.build_days(cycles)
    assert len(full["days"]) == 5 and full["truncated"] is False
    assert svc.build_days([]) == {"days": [], "total_days": 0, "truncated": False}


def test_a_note_shows_only_when_something_is_written_and_the_score_when_stored():
    cycles = day(D1, trade(1, 0, +5), session_id="a") + day(D2, trade(2, 0, +5), session_id="b") + day(D3, trade(3, 0, +5), session_id="c")
    notes = {D1: {"date": D1, "went_well": "", "to_improve": "", "specific_points": "", "context": "  ", "updated_at": "x"},
             D2: {"date": D2, "went_well": "", "to_improve": "", "specific_points": "", "context": "Gap-up open", "updated_at": "y"}}
    scores = {D2: [{"date": D2, "mode": "sim", "score": 82, "limit_source": "saved", "partial": True}, {"date": D2, "mode": "paper", "score": 40, "limit_source": "saved", "partial": False}]}
    cards = {d["date"]: d for d in svc.build_days(cycles, scores, notes)["days"]}
    assert cards[D1]["note"] is None and cards[D3]["note"] is None
    assert cards[D2]["note"]["context"] == "Gap-up open" and cards[D2]["note"]["went_well"] == ""
    # one score per session type the day was traded in; a stored score of a type with no trades in the card is not shown
    assert cards[D2]["scores"] == [{"mode": "sim", "score": 82, "limit_source": "saved", "partial": True}]
    assert cards[D1]["scores"] == []


# ── The service: which cycles, which lookups ─────────────────────────────────

def test_the_service_asks_for_own_intraday_cycles_only_and_looks_up_scores_and_notes(monkeypatch):
    asked = {}
    own = day(D1, trade(1, 0, +5), session_id="mine") + day(D2, trade(2, 0, -5), session_id="mine2")
    shared = day(D3, trade(3, 0, +5), session_id="theirs")
    for cycle in own:
        cycle["user_id"] = "alice"
    for cycle in shared:
        cycle["user_id"], cycle["shared"] = "bob", True

    def load(user, **criteria):
        asked.update(criteria, user=user)
        return own + shared

    ranges = {}
    monkeypatch.setattr(performance_service, "load_cycles", load)
    monkeypatch.setattr(day_score_service, "list_scores", lambda user, start, end: ranges.update(scores=(user, start, end)) or [{"date": D1, "mode": "sim", "score": 70, "limit_source": "saved", "partial": False}])
    monkeypatch.setattr(day_notes_service, "notes_between", lambda user, start, end: ranges.update(notes=(user, start, end)) or {D2: {"date": D2, "context": "Trend day", "went_well": "", "to_improve": "", "specific_points": ""}})
    result = svc.day_summary("alice", {"symbol": "NIFTY", "session_type": "sim", "start_date": D1, "end_date": D3, "trading_style": "swing", "include_shared": True})
    assert asked["trading_style"] == "intraday" and asked["include_shared"] is False and asked["include_practice"] is False
    assert asked["symbol"] == "NIFTY" and asked["session_type"] == "sim" and asked["user"] == "alice"
    assert [d["date"] for d in result["days"]] == [D2, D1], "someone else's shared trades are not in the Summary"
    assert ranges == {"scores": ("alice", D1, D2), "notes": ("alice", D1, D2)}
    assert result["days"][1]["scores"][0]["score"] == 70 and result["days"][1]["scores"][0]["mode"] == "sim" and result["days"][0]["note"]["context"] == "Trend day"


def test_no_days_means_no_lookups(monkeypatch):
    monkeypatch.setattr(performance_service, "load_cycles", lambda user, **c: [])
    monkeypatch.setattr(day_score_service, "list_scores", lambda *a: pytest.fail("no scores to look up"))
    assert svc.day_summary("alice", {}) == {"days": [], "total_days": 0, "truncated": False}


# ── Notes in a range (a real table) ──────────────────────────────────────────

@pytest.fixture
def database(behavior_database, monkeypatch):
    monkeypatch.setattr(day_notes_service, "_ENSURED", set())
    return behavior_database


def test_notes_between_reads_one_range_for_one_user(database):
    day_notes_service.save_note("alice", "2026-11-15", {"context": "before"})
    day_notes_service.save_note("alice", D1, {"context": "first", "went_well": "Patience"})
    day_notes_service.save_note("alice", D3, {"context": "last"})
    day_notes_service.save_note("alice", "2026-11-19", {"context": "after"})
    day_notes_service.save_note("bob", D2, {"context": "someone else"})
    found = day_notes_service.notes_between("alice", D1, D3)
    assert sorted(found) == [D1, D3] and found[D1]["context"] == "first" and found[D1]["went_well"] == "Patience" and found[D3]["to_improve"] == ""
    assert day_notes_service.notes_between("alice", "2026-12-01", "2026-12-31") == {}
    with pytest.raises(ValueError):
        day_notes_service.notes_between("alice", "bad", D3)


# ── Routes ───────────────────────────────────────────────────────────────────

@pytest.fixture
def stubbed(monkeypatch):
    seen = {}

    def load(user, **criteria):
        seen.update(criteria, user=user)
        cycles = day(D1, trade(1, 0, +5), trade(2, 300, -10))
        for cycle in cycles:
            cycle["user_id"] = user
        return cycles

    monkeypatch.setattr(performance_service, "load_cycles", load)
    monkeypatch.setattr(day_score_service, "list_scores", lambda user, start, end: [])
    monkeypatch.setattr(day_notes_service, "notes_between", lambda user, start, end: {})
    return seen


def test_the_web_route_takes_the_stats_filters(stubbed):
    client = TestClient(app)
    body = client.get("/api/analysis/day-summary?start_date=2026-11-01&end_date=2026-11-30&session_type=real&symbol=NIFTY", headers={"X-User-Id": "alice"}).json()
    assert [d["date"] for d in body["days"]] == [D1] and body["truncated"] is False and body["total_days"] == 1
    assert body["days"][0]["totals"]["trades"] == 2
    assert stubbed["user"] == "alice" and stubbed["start_date"] == "2026-11-01" and stubbed["end_date"] == "2026-11-30"
    assert stubbed["session_type"] == "real" and stubbed["symbol"] == "NIFTY" and stubbed["trading_style"] == "intraday"
    assert client.get("/api/analysis/day-summary?start_date=2026-12-01&end_date=2026-11-01", headers={"X-User-Id": "alice"}).status_code == 422
    assert client.get("/api/analysis/day-summary?session_type=nonsense", headers={"X-User-Id": "alice"}).status_code == 422


def test_a_read_failure_is_a_plain_503(monkeypatch):
    def boom(user, **criteria):
        raise RuntimeError("table gone")

    monkeypatch.setattr(performance_service, "load_cycles", boom)
    response = TestClient(app).get("/api/analysis/day-summary", headers={"X-User-Id": "alice"})
    assert response.status_code == 503 and "table gone" not in response.text


def test_the_desktop_route_is_read_only(stubbed, as_user):
    client = TestClient(app)
    body = client.get("/api/desktop/v1/analysis/day-summary?session_type=sim").json()
    assert body["days"][0]["date"] == D1 and stubbed["user"] == "alice" and stubbed["session_type"] == "sim"
    as_user["user"] = "bob"
    assert client.get("/api/desktop/v1/analysis/day-summary").json()["days"][0]["totals"]["trades"] == 2 and stubbed["user"] == "bob"
    for method in ("post", "put", "delete"):
        assert getattr(client, method)("/api/desktop/v1/analysis/day-summary").status_code in (404, 405), method
    assert client.get("/api/desktop/v1/analysis/day-summary/extra").status_code == 404
