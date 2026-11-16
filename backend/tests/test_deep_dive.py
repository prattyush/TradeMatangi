"""Phase 26 — Patterns Strategy Deep Dive: questions, marked days, answers, gaps, stats, sharing, API."""
import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.dependencies import get_request_user_id
from app.main import app
from app.services import deep_dive_service as svc
from app.services import pattern_logger_service as patterns

USER = "alice"
OTHER = "bob"
CAT, STRAT = "Breakout", "Opening range"
D1, D2, D3 = "2026-10-06", "2026-10-07", "2026-10-08"  # Tue, Wed, Thu trading days
WEEKEND = "2026-10-10"


@pytest.fixture
def database(monkeypatch):
    with mock_aws():
        db = boto3.resource("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        client = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: db)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        monkeypatch.setattr(svc, "_SETUPS_ENSURED", False)
        monkeypatch.setattr(svc, "_QUESTIONS_ENSURED", False)
        monkeypatch.setattr(patterns, "_names_table_ready", False, raising=False)
        monkeypatch.setattr(patterns, "get_accessible_owner_ids", lambda user_id: [user_id])
        yield db


def mark(day=D1, side="buy", user=USER, symbol="NIFTY", **fields):
    return svc.upsert_setup(user, CAT, STRAT, symbol, day, side, fields)


def ask(text, user=USER):
    return svc.add_question(user, CAT, STRAT, text)


def annotation(id="a1", instrument="underlying"):
    return {"id": id, "time": 1_000, "price": 24_000.5, "type": "entry", "instrument": instrument,
            "strategy_name": "whatever", "category": "", "text": ""}


# ── Questions ────────────────────────────────────────────────────────────────

def test_add_list_and_isolate_per_user_and_per_dive(database):
    first = ask("  Second leg? ")
    svc.add_question(USER, CAT, "Other strategy", "Not this dive")
    svc.add_question(OTHER, CAT, STRAT, "Not mine")
    assert first["text"] == "Second leg?" and first["status"] == "active"
    assert [q["text"] for q in svc.list_questions(USER, CAT, STRAT)] == ["Second leg?"]
    assert [q["text"] for q in svc.list_questions(OTHER, CAT, STRAT)] == ["Not mine"]


@pytest.mark.parametrize("text", ["", "   ", "x" * 141])
def test_question_text_validation(database, text):
    with pytest.raises(ValueError):
        ask(text)


@pytest.mark.parametrize("category,strategy", [("", "S"), ("C", ""), ("A::B", "S"), ("C", "S#1"), ("x" * 61, "S")])
def test_names_are_validated(database, category, strategy):
    with pytest.raises(ValueError):
        svc.add_question(USER, category, strategy, "ok")


def test_duplicate_active_question_rejected_case_insensitively_but_archived_can_repeat(database):
    first = ask("Second leg?")
    with pytest.raises(ValueError, match="already exists"):
        ask("second LEG?")
    svc.archive_question(USER, CAT, STRAT, first["question_id"])
    again = ask("second leg?")
    with pytest.raises(ValueError, match="already exists"):
        svc.restore_question(USER, CAT, STRAT, first["question_id"])
    assert again["status"] == "active"


def test_at_most_forty_active_questions(database):
    for index in range(svc.MAX_ACTIVE_QUESTIONS):
        ask(f"Question {index}")
    with pytest.raises(ValueError, match="At most"):
        ask("One too many")


def test_update_archive_restore_keep_the_question(database):
    question = ask("Old text")
    assert svc.update_question(USER, CAT, STRAT, question["question_id"], "New text")["text"] == "New text"
    assert svc.archive_question(USER, CAT, STRAT, question["question_id"])["status"] == "archived"
    assert svc.list_questions(USER, CAT, STRAT, include_archived=False) == []
    assert svc.restore_question(USER, CAT, STRAT, question["question_id"])["status"] == "active"
    with pytest.raises(LookupError):
        svc.archive_question(USER, CAT, STRAT, "missing")


# ── Marked days ──────────────────────────────────────────────────────────────

def test_upsert_creates_a_day_with_defaults_and_keeps_unsent_fields(database):
    first = mark(strike_ce=24_500, strike_mode="max_price")
    assert first["answers"] == {} and first["interval_minutes"] == 3 and first["outcome"] is None
    second = mark(outcome="success", notes="clean")
    assert (second["strike_ce"], second["strike_mode"], second["outcome"], second["notes"]) == (24_500, "max_price", "success", "clean")
    assert mark(outcome=None)["outcome"] is None
    assert mark(interval_minutes=5)["interval_minutes"] == 5
    assert mark(strike_ce=None)["strike_ce"] is None


def test_a_day_with_both_sides_is_two_items_buy_first(database):
    mark(D2, "sell")
    mark(D2, "buy")
    mark(D1, "sell")
    dive = svc.get_dive(USER, CAT, STRAT)
    assert [(s["date"], s["side"]) for s in dive["setups"]] == [(D1, "sell"), (D2, "buy"), (D2, "sell")]


@pytest.mark.parametrize("kwargs,message", [
    (dict(day=WEEKEND), "not a trading day"),
    (dict(day="2026-13-40"), "YYYY-MM-DD"),
    (dict(symbol="NOPE"), "Unsupported symbol"),
    (dict(side="both"), "Side"),
    (dict(outcome="maybe"), "Outcome"),
    (dict(interval_minutes=0), "Interval"),
    (dict(strike_ce=-5), "positive"),
    (dict(strike_mode="guess"), "strike mode"),
    (dict(notes="x" * 2001), "Notes"),
])
def test_setup_validation(database, kwargs, message):
    with pytest.raises(ValueError, match=message):
        mark(**kwargs)


def test_marks_are_normalised_to_the_dive_strategy(database):
    saved = mark(annotations=[annotation()])
    assert saved["annotations"][0]["strategy_name"] == STRAT and saved["annotations"][0]["category"] == CAT
    with pytest.raises(ValueError, match="At most"):
        mark(annotations=[annotation(str(i)) for i in range(svc.MAX_ANNOTATIONS + 1)])


def test_delete_setup_removes_one_side_and_its_answers(database):
    question = ask("Second leg?")
    mark(side="buy"); mark(side="sell")
    svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {question["question_id"]: True})
    assert svc.delete_setup(USER, CAT, STRAT, "NIFTY", D1, "buy") is True
    assert svc.delete_setup(USER, CAT, STRAT, "NIFTY", D1, "buy") is False
    assert [s["side"] for s in svc.get_dive(USER, CAT, STRAT)["setups"]] == ["sell"]


# ── Answers and gaps ─────────────────────────────────────────────────────────

def test_answers_set_clear_and_stay_idempotent(database):
    one, two = ask("Second leg?"), ask("Exhaustion bar?")
    mark()
    ids = (one["question_id"], two["question_id"])
    result = svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {ids[0]: True, ids[1]: False})
    assert result["answers"] == {ids[0]: True, ids[1]: False}
    again = svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {ids[0]: True})
    assert again["answers"] == {ids[0]: True, ids[1]: False}
    cleared = svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {ids[0]: None})
    assert cleared["answers"] == {ids[1]: False}


def test_answer_validation(database):
    question = ask("Second leg?")
    mark()
    with pytest.raises(ValueError, match="Unknown"):
        svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {"nope": True})
    with pytest.raises(LookupError):
        svc.set_answers(USER, CAT, STRAT, "NIFTY", D2, "buy", {question["question_id"]: True})
    svc.archive_question(USER, CAT, STRAT, question["question_id"])
    with pytest.raises(ValueError, match="Archived"):
        svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {question["question_id"]: True})


def test_archived_question_keeps_its_old_answer_and_can_be_cleared(database):
    question = ask("Second leg?")
    mark()
    svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {question["question_id"]: True})
    svc.archive_question(USER, CAT, STRAT, question["question_id"])
    assert svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {question["question_id"]: True})["answers"]
    assert svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {question["question_id"]: None})["answers"] == {}


def test_a_question_added_later_leaves_earlier_days_incomplete(database):
    first = ask("Second leg?")
    mark(D1); mark(D2)
    for day in (D1, D2):
        svc.set_answers(USER, CAT, STRAT, "NIFTY", day, "buy", {first["question_id"]: True})
    assert svc.get_dive(USER, CAT, STRAT)["incomplete_days"] == 0
    second = ask("Double top?")
    svc.set_answers(USER, CAT, STRAT, "NIFTY", D2, "buy", {second["question_id"]: False})
    dive = svc.get_dive(USER, CAT, STRAT)
    assert [(s["date"], s["complete"], s["missing"]) for s in dive["setups"]] == [
        (D1, False, [second["question_id"]]), (D2, True, [])]
    assert (dive["incomplete_days"], dive["unanswered_total"]) == (1, 1)
    svc.archive_question(USER, CAT, STRAT, second["question_id"])  # an archived question stops counting
    assert svc.get_dive(USER, CAT, STRAT)["incomplete_days"] == 0


# ── Stats ────────────────────────────────────────────────────────────────────

def setup_row(side="buy", outcome=None, answers=None, day=D1):
    return {"side": side, "outcome": outcome, "answers": answers or {}, "date": day, "symbol": "NIFTY"}


def question_row(question_id, status="active"):
    return {"question_id": question_id, "text": question_id, "status": status}


def test_stats_use_answered_days_per_question_and_flag_thin_samples():
    setups = [setup_row(answers={"q1": True, "q2": True}, outcome="success"),
              setup_row(answers={"q1": True}, outcome="failed"),
              setup_row(answers={"q1": False}),
              setup_row(answers={"q1": True}, outcome="success")]
    stats = svc.compute_stats(setups, [question_row("q1"), question_row("q2"), question_row("q3", "archived")])
    q1, q2 = stats["questions"]
    assert (q1["yes"], q1["no"], q1["answered"], q1["pct"], q1["few_days"]) == (3, 1, 4, 75.0, True)
    assert (q2["answered"], q2["pct"]) == (1, 100.0)  # one day: shown, but flagged as thin
    assert (stats["success"], stats["failed"], stats["with_outcome"], stats["success_pct"]) == (2, 1, 3, 66.7)
    assert len(stats["questions"]) == 2  # the archived question is not counted


def test_stats_without_answers_have_no_percentage_and_enough_days_are_not_flagged():
    stats = svc.compute_stats([setup_row()], [question_row("q1")])
    assert stats["questions"][0]["pct"] is None and stats["success_pct"] is None
    many = [setup_row(answers={"q1": index % 2 == 0}, day=f"2026-10-{6 + index:02d}") for index in range(svc.FEW_DAYS)]
    assert svc.compute_stats(many, [question_row("q1")])["questions"][0]["few_days"] is False


def test_stats_filter_by_side(database):
    question = ask("Second leg?")
    mark(D1, "buy"); mark(D2, "buy"); mark(D1, "sell")
    for day, side, answer in ((D1, "buy", True), (D2, "buy", True), (D1, "sell", False)):
        svc.set_answers(USER, CAT, STRAT, "NIFTY", day, side, {question["question_id"]: answer})
    overall = svc.stats(USER, CAT, STRAT)
    assert (overall["days"], overall["buy_days"], overall["sell_days"]) == (3, 2, 1)
    assert overall["questions"][0]["pct"] == 66.7
    assert svc.stats(USER, CAT, STRAT, "buy")["questions"][0]["pct"] == 100.0
    assert svc.stats(USER, CAT, STRAT, "sell")["questions"][0]["pct"] == 0.0
    with pytest.raises(ValueError):
        svc.stats(USER, CAT, STRAT, "both")


def test_list_dives_counts_days_questions_and_gaps(database):
    ask("Second leg?")
    mark(D1, "buy"); mark(D1, "sell")
    svc.add_question(USER, CAT, "Questions only", "Anything?")
    dives = {d["strategy"]: d for d in svc.list_dives(USER)}
    assert (dives[STRAT]["days"], dives[STRAT]["buy_days"], dives[STRAT]["sell_days"], dives[STRAT]["incomplete_days"]) == (2, 1, 1, 2)
    assert (dives["Questions only"]["days"], dives["Questions only"]["questions"]) == (0, 1)


# ── Sharing ──────────────────────────────────────────────────────────────────

def share(monkeypatch, viewer, owners):
    monkeypatch.setattr(patterns, "get_accessible_owner_ids", lambda user_id: [user_id] + (owners if user_id == viewer else []))


def test_a_shared_dive_is_readable_never_writable(database, monkeypatch):
    question = ask("Second leg?")
    mark()
    svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {question["question_id"]: True})
    share(monkeypatch, OTHER, [USER])
    seen = svc.get_dive(OTHER, CAT, STRAT, owner_id=USER)
    assert seen["owner_id"] == USER and seen["can_edit"] is False and len(seen["setups"]) == 1
    assert svc.stats(OTHER, CAT, STRAT, owner_id=USER)["questions"][0]["pct"] == 100.0
    assert svc.get_dive(OTHER, CAT, STRAT)["setups"] == []  # without owner_id a viewer sees their own (empty) dive
    mark(D2, user=OTHER)  # a viewer's write lands in the viewer's own data
    assert len(svc.get_dive(USER, CAT, STRAT)["setups"]) == 1
    assert [s["date"] for s in svc.get_dive(OTHER, CAT, STRAT)["setups"]] == [D2]


def test_a_stranger_cannot_read_someone_elses_dive(database):
    mark()
    with pytest.raises(LookupError):
        svc.get_dive(OTHER, CAT, STRAT, owner_id=USER)
    with pytest.raises(LookupError):
        svc.stats(OTHER, CAT, STRAT, owner_id=USER)


def test_stats_all_prefers_own_dive_then_first_sharer(database, monkeypatch):
    question = ask("Second leg?")
    mark()
    svc.set_answers(USER, CAT, STRAT, "NIFTY", D1, "buy", {question["question_id"]: True})
    share(monkeypatch, OTHER, [USER])
    shared = svc.stats_all(OTHER)
    assert len(shared) == 1 and shared[0]["shared"] is True and shared[0]["owner_id"] == USER
    assert shared[0]["all"]["questions"][0]["pct"] == 100.0 and shared[0]["sell"]["days"] == 0
    mark(D2, user=OTHER)
    own = svc.stats_all(OTHER)
    assert len(own) == 1 and own[0]["shared"] is False and own[0]["owner_id"] == OTHER
    assert svc.stats_all(USER)[0]["shared"] is False


def test_stats_all_skips_dives_without_marked_days(database):
    ask("Anything?")
    assert svc.stats_all(USER) == []


# ── Save to the Pattern Library ──────────────────────────────────────────────

@pytest.fixture
def library(monkeypatch):
    charts = []
    monkeypatch.setattr(patterns, "register_annotation_names", lambda user_id, marks: None)

    def create_chart(**kwargs):
        chart = {**kwargs, "chart_id": f"c{len(charts)}", "can_delete": True}
        charts.append(chart)
        return chart

    def find(user_id, symbol, date, instrument_type, right=None):
        return next((c for c in charts if (c["symbol"], c["date"], c["instrument_type"]) == (symbol, date, instrument_type)), None)

    def update(chart_id, annotations, notes, **kwargs):
        next(c for c in charts if c["chart_id"] == chart_id)["annotations"] = annotations

    monkeypatch.setattr(patterns, "create_chart", create_chart)
    monkeypatch.setattr(patterns, "find_chart_by_date", find)
    monkeypatch.setattr(patterns, "update_chart", update)
    return charts


def test_save_creates_a_chart_then_merges_new_marks_by_id(database, library):
    mark(annotations=[annotation("a1"), annotation("a2", "CE")], strike_ce=24_500, strike_pe=24_300, notes="n")
    created = svc.save_to_patterns(USER, CAT, STRAT, "NIFTY", D1, "buy")
    assert created == {"chart_id": "c0", "merged": False, "added": 2}
    chart = library[0]
    assert (chart["instrument_type"], chart["right"], chart["strike"], chart["strike_pe"]) == ("options", "CE", 24_500, 24_300)
    mark(annotations=[annotation("a1"), annotation("a2", "CE"), annotation("a3")])
    merged = svc.save_to_patterns(USER, CAT, STRAT, "NIFTY", D1, "buy")
    assert merged == {"chart_id": "c0", "merged": True, "added": 1}
    assert [a["id"] for a in library[0]["annotations"]] == ["a1", "a2", "a3"]


def test_save_refuses_a_chart_on_other_strikes_and_empty_marks(database, library):
    mark(annotations=[annotation("a2", "CE")], strike_ce=24_500)
    svc.save_to_patterns(USER, CAT, STRAT, "NIFTY", D1, "buy")
    mark(annotations=[annotation("a2", "CE"), annotation("a4", "CE")], strike_ce=24_600)
    with pytest.raises(ValueError, match="different CE strike"):
        svc.save_to_patterns(USER, CAT, STRAT, "NIFTY", D1, "buy")
    mark(D2)
    with pytest.raises(ValueError, match="Mark the setup"):
        svc.save_to_patterns(USER, CAT, STRAT, "NIFTY", D2, "buy")
    with pytest.raises(LookupError):
        svc.save_to_patterns(USER, CAT, STRAT, "NIFTY", D3, "buy")


def test_underlying_only_marks_make_an_equity_chart(database, library):
    mark(annotations=[annotation("a1")])
    svc.save_to_patterns(USER, CAT, STRAT, "NIFTY", D1, "buy")
    assert library[0]["instrument_type"] == "equity" and library[0]["right"] is None


# ── HTTP ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(database):
    app.dependency_overrides[get_request_user_id] = lambda: USER
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_request_user_id, None)


REF = {"category": CAT, "strategy": STRAT}


def test_api_walkthrough(client):
    question = client.post("/api/deep-dive/questions", json={**REF, "text": "Second leg?"})
    assert question.status_code == 200, question.text
    qid = question.json()["question_id"]
    setup = {**REF, "symbol": "NIFTY", "date": D1, "side": "buy"}
    put = client.put("/api/deep-dive/setup", json={**setup, "outcome": "success", "annotations": [annotation()]})
    assert put.status_code == 200, put.text
    assert put.json()["outcome"] == "success" and put.json()["annotations"][0]["category"] == CAT
    answers = client.put("/api/deep-dive/setup/answers", json={**setup, "answers": {qid: True}})
    assert answers.json()["answers"] == {qid: True}
    dive = client.get("/api/deep-dive/dive", params=REF).json()
    assert dive["can_edit"] is True and dive["incomplete_days"] == 0 and dive["questions"][0]["question_id"] == qid
    assert client.get("/api/deep-dive/dives").json()["dives"][0]["days"] == 1
    stats = client.get("/api/deep-dive/stats", params={**REF, "side": "buy"}).json()
    assert stats["questions"][0]["pct"] == 100.0 and stats["success_pct"] == 100.0
    assert client.get("/api/deep-dive/stats/all").json()["dives"][0]["all"]["days"] == 1
    assert client.post(f"/api/deep-dive/questions/{qid}/archive", json=REF).json()["status"] == "archived"
    assert client.post(f"/api/deep-dive/questions/{qid}/restore", json=REF).json()["status"] == "active"
    assert client.post(f"/api/deep-dive/questions/{qid}/update", json={**REF, "text": "Second leg?!"}).json()["text"] == "Second leg?!"
    gone = client.delete("/api/deep-dive/setup", params={k: v for k, v in setup.items()})
    assert gone.json() == {"status": "deleted"}
    assert client.delete("/api/deep-dive/setup", params=setup).json() == {"status": "not_found"}


def test_api_errors_are_400_and_404(client):
    setup = {**REF, "symbol": "NIFTY", "date": WEEKEND, "side": "buy"}
    assert client.put("/api/deep-dive/setup", json=setup).status_code == 400
    assert client.put("/api/deep-dive/setup", json={**setup, "date": D1, "side": "both"}).status_code == 422
    missing = client.put("/api/deep-dive/setup/answers", json={**setup, "date": D1, "answers": {}})
    assert missing.status_code == 404
    assert client.get("/api/deep-dive/dive", params={**REF, "owner_id": "stranger"}).status_code == 404
    assert client.post("/api/deep-dive/questions/missing/archive", json=REF).status_code == 404
