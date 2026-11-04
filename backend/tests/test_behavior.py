"""Phase 23 — Manual Behavioral Analysis: questions, marks, stats and API."""
from decimal import Decimal

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.main import app
from app.services import behavior_service as svc

USER = "alice"
OTHER = "bob"


@pytest.fixture
def database(monkeypatch):
    with mock_aws():
        db = boto3.resource("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        db.create_table(
            TableName="Sessions", BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}],
        )
        db.create_table(
            TableName="TradeLabels", BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": "round_trip_index", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": "round_trip_index", "AttributeType": "N"}],
        )
        client = boto3.client("dynamodb", region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: db)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        monkeypatch.setattr(svc, "_QUESTIONS_ENSURED", False)
        monkeypatch.setattr(svc, "_MARKS_ENSURED", False)
        yield db


def add_session(db, sid="s1", user=USER, date="2026-10-06", session_type="paper"):
    session = dict(session_id=sid, user_id=user, symbol="NIFTY", date=date, session_type=session_type, instrument_type="options")
    db.Table("Sessions").put_item(Item=session)
    return session


# ── Questions ────────────────────────────────────────────────────────────────

def test_add_list_and_isolate_per_user(database):
    first = svc.add_question(USER, "  Exited after one bar in profit ", "exit")
    svc.add_question(USER, "Chased the move", "entry")
    svc.add_question(OTHER, "Not mine", "entry")
    assert first["text"] == "Exited after one bar in profit"
    assert first["status"] == "active"
    rows = svc.list_questions(USER)
    assert [(r["kind"], r["text"]) for r in rows] == [("entry", "Chased the move"), ("exit", "Exited after one bar in profit")]
    assert [r["text"] for r in svc.list_questions(OTHER)] == ["Not mine"]


@pytest.mark.parametrize("text,kind", [("", "entry"), ("   ", "exit"), ("x" * 141, "entry"), ("ok", "both")])
def test_add_validation(database, text, kind):
    with pytest.raises(ValueError):
        svc.add_question(USER, text, kind)


def test_duplicate_active_text_is_rejected_case_insensitively_but_per_kind(database):
    svc.add_question(USER, "Chased the move", "entry")
    with pytest.raises(ValueError):
        svc.add_question(USER, "chased  THE move", "entry")
    assert svc.add_question(USER, "Chased the move", "exit")["kind"] == "exit"


def test_active_question_cap(database, monkeypatch):
    monkeypatch.setattr(svc, "MAX_ACTIVE_QUESTIONS", 2)
    svc.add_question(USER, "a", "entry")
    svc.add_question(USER, "b", "entry")
    with pytest.raises(ValueError):
        svc.add_question(USER, "c", "entry")


def test_update_changes_text_only_and_checks_duplicates(database):
    a = svc.add_question(USER, "First", "entry")
    svc.add_question(USER, "Second", "entry")
    updated = svc.update_question(USER, a["question_id"], "First (fixed)")
    assert updated["text"] == "First (fixed)" and updated["kind"] == "entry"
    with pytest.raises(ValueError):
        svc.update_question(USER, a["question_id"], "second")
    with pytest.raises(LookupError):
        svc.update_question(OTHER, a["question_id"], "hijack")


def test_archive_and_restore_round_trip(database):
    q = svc.add_question(USER, "Held too long", "exit")
    archived = svc.archive_question(USER, q["question_id"])
    assert archived["status"] == "archived" and archived["archived_at"]
    assert svc.list_questions(USER) == []
    everything = svc.list_questions(USER, include_archived=True)
    assert [r["question_id"] for r in everything] == [q["question_id"]]
    assert svc.archive_question(USER, q["question_id"])["status"] == "archived"  # idempotent
    restored = svc.restore_question(USER, q["question_id"])
    assert restored["status"] == "active" and restored["archived_at"] is None
    assert [r["question_id"] for r in svc.list_questions(USER)] == [q["question_id"]]


def test_restore_conflicts_with_active_duplicate(database):
    q = svc.add_question(USER, "Same text", "entry")
    svc.archive_question(USER, q["question_id"])
    svc.add_question(USER, "Same text", "entry")
    with pytest.raises(ValueError):
        svc.restore_question(USER, q["question_id"])


# ── Marks ────────────────────────────────────────────────────────────────────

def test_set_marks_is_idempotent_and_clearable(database):
    session = add_session(database)
    q = svc.add_question(USER, "Chased", "entry")
    qid = q["question_id"]
    svc.set_marks(USER, session, 0, {qid: True})
    svc.set_marks(USER, session, 0, {qid: True})
    assert svc.get_marks("s1") == [{"round_trip_index": 0, "question_id": qid, "kind": "entry"}]
    assert svc.set_marks(USER, session, 0, {qid: False}) == []
    assert svc.set_marks(USER, session, 0, {qid: False}) == []
    assert svc.get_marks("s1") == []


def test_marks_are_per_round_trip_and_sorted(database):
    session = add_session(database)
    a = svc.add_question(USER, "A", "entry")["question_id"]
    b = svc.add_question(USER, "B", "exit")["question_id"]
    svc.set_marks(USER, session, 10, {a: True})
    svc.set_marks(USER, session, 2, {b: True, a: True})
    assert [(m["round_trip_index"], m["question_id"]) for m in svc.get_marks("s1")] == sorted([(10, a), (2, a), (2, b)])


def test_unknown_question_and_negative_index_rejected(database):
    session = add_session(database)
    with pytest.raises(ValueError):
        svc.set_marks(USER, session, 0, {"nope": True})
    q = svc.add_question(USER, "A", "entry")["question_id"]
    with pytest.raises(ValueError):
        svc.set_marks(USER, session, -1, {q: True})


def test_archived_question_keeps_and_can_clear_old_marks_but_not_add_new_ones(database):
    session = add_session(database)
    qid = svc.add_question(USER, "Old habit", "exit")["question_id"]
    svc.set_marks(USER, session, 0, {qid: True})
    svc.archive_question(USER, qid)
    assert len(svc.get_marks("s1")) == 1
    svc.set_marks(USER, session, 0, {qid: True})  # re-sending an existing mark is a no-op
    with pytest.raises(ValueError):
        svc.set_marks(USER, session, 1, {qid: True})
    assert svc.set_marks(USER, session, 0, {qid: False}) == []


def test_cannot_use_another_users_question(database):
    session = add_session(database)
    theirs = svc.add_question(OTHER, "Theirs", "entry")["question_id"]
    with pytest.raises(ValueError):
        svc.set_marks(USER, session, 0, {theirs: True})


def test_delete_session_marks(database):
    s1, s2 = add_session(database, "s1"), add_session(database, "s2")
    qid = svc.add_question(USER, "A", "entry")["question_id"]
    svc.set_marks(USER, s1, 0, {qid: True})
    svc.set_marks(USER, s2, 0, {qid: True})
    assert svc.delete_session_marks("s1") == 1
    assert svc.get_marks("s1") == [] and len(svc.get_marks("s2")) == 1


# ── Stats ────────────────────────────────────────────────────────────────────

def seed_stats(database):
    a = svc.add_question(USER, "A", "entry")["question_id"]
    b = svc.add_question(USER, "B", "exit")["question_id"]
    day1 = add_session(database, "d1", date="2026-10-05")
    day2 = add_session(database, "d2", date="2026-10-06")
    day2b = add_session(database, "d2b", date="2026-10-06", session_type="real")
    svc.set_marks(USER, day1, 0, {a: True, b: True})
    svc.set_marks(USER, day1, 1, {a: True})
    svc.set_marks(USER, day2, 0, {a: True})
    svc.set_marks(USER, day2b, 0, {b: True})
    other_session = add_session(database, "o1", user=OTHER, date="2026-10-06")
    svc.set_marks(OTHER, other_session, 0, {svc.add_question(OTHER, "X", "entry")["question_id"]: True})
    return a, b


def test_stats_counts_per_day_for_the_user_only(database):
    a, b = seed_stats(database)
    stats = svc.get_stats(USER)
    assert stats["days"] == [
        {"date": "2026-10-05", "counts": {a: 2, b: 1}},
        {"date": "2026-10-06", "counts": {a: 1, b: 1}},
    ]
    assert {q["question_id"] for q in stats["questions"]} == {a, b}


def test_stats_filters_by_date_and_session_type(database):
    a, b = seed_stats(database)
    assert [d["date"] for d in svc.get_stats(USER, start_date="2026-10-06")["days"]] == ["2026-10-06"]
    assert [d["date"] for d in svc.get_stats(USER, end_date="2026-10-05")["days"]] == ["2026-10-05"]
    assert svc.get_stats(USER, session_type="real")["days"] == [{"date": "2026-10-06", "counts": {b: 1}}]
    assert svc.get_stats(USER, symbol="BANKNIFTY")["days"] == []


def test_stats_include_archived_questions_with_history(database):
    a, _ = seed_stats(database)
    svc.archive_question(USER, a)
    stats = svc.get_stats(USER)
    assert any(q["question_id"] == a and q["status"] == "archived" for q in stats["questions"])
    assert stats["days"][0]["counts"][a] == 2


def test_stats_read_every_page(database, monkeypatch):
    a = svc.add_question(USER, "A", "entry")["question_id"]
    session = add_session(database)
    for index in range(30):
        svc.set_marks(USER, session, index, {a: True})
    real_query = svc._marks().query
    pages = []

    class Paged:
        def query(self, **params):
            params = dict(params, Limit=7)
            pages.append(1)
            return real_query(**params)

    monkeypatch.setattr(svc, "_marks", lambda: Paged())
    assert svc.get_stats(USER)["days"] == [{"date": "2026-10-06", "counts": {a: 30}}]
    assert len(pages) > 1


def test_marks_by_question_lists_flagged_trades_with_label_pnl(database):
    a, _ = seed_stats(database)
    database.Table("TradeLabels").put_item(Item={"session_id": "d1", "round_trip_index": 1, "round_trip_pnl": Decimal("-42.5")})
    rows = svc.marks_by_question(USER, a)
    assert [(r["session_id"], r["round_trip_index"]) for r in rows] == [("d2", 0), ("d1", 1), ("d1", 0)]
    assert next(r for r in rows if r["session_id"] == "d1" and r["round_trip_index"] == 1)["pnl"] == -42.5
    assert next(r for r in rows if r["session_id"] == "d2")["pnl"] is None


# ── API ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(database):
    return TestClient(app)


def headers(user=USER):
    return {"X-User-Id": user}


def test_api_question_lifecycle(client):
    created = client.post("/api/behavior/questions", json={"text": "Chased", "kind": "entry"}, headers=headers())
    assert created.status_code == 200
    qid = created.json()["question_id"]
    assert client.post("/api/behavior/questions", json={"text": "chased", "kind": "entry"}, headers=headers()).status_code == 400
    assert client.post("/api/behavior/questions", json={"text": "x", "kind": "bad"}, headers=headers()).status_code == 422
    assert client.post(f"/api/behavior/questions/{qid}/update", json={"text": "Chased price"}, headers=headers()).json()["text"] == "Chased price"
    assert client.post(f"/api/behavior/questions/{qid}/archive", headers=headers()).json()["status"] == "archived"
    assert client.get("/api/behavior/questions", headers=headers()).json()["questions"] == []
    listed = client.get("/api/behavior/questions?include_archived=true", headers=headers()).json()["questions"]
    assert [q["status"] for q in listed] == ["archived"]
    assert client.post(f"/api/behavior/questions/{qid}/restore", headers=headers()).json()["status"] == "active"
    assert client.post(f"/api/behavior/questions/{qid}/archive", headers=headers(OTHER)).status_code == 404


def test_api_marks_ownership(client, database):
    add_session(database)
    qid = client.post("/api/behavior/questions", json={"text": "A", "kind": "entry"}, headers=headers()).json()["question_id"]
    body = {"session_id": "s1", "round_trip_index": 0, "answers": {qid: True}}
    saved = client.post("/api/behavior/marks", json=body, headers=headers())
    assert saved.status_code == 200 and saved.json()["marks"] == [{"round_trip_index": 0, "question_id": qid, "kind": "entry"}]
    assert client.get("/api/behavior/marks?session_id=s1", headers=headers()).json()["marks"][0]["question_id"] == qid
    assert client.post("/api/behavior/marks", json=body, headers=headers(OTHER)).status_code == 404
    assert client.get("/api/behavior/marks?session_id=s1", headers=headers(OTHER)).status_code == 404  # paper sessions are private
    assert client.post("/api/behavior/marks", json={**body, "session_id": "missing"}, headers=headers()).status_code == 404
    assert client.post("/api/behavior/marks", json={**body, "round_trip_index": -1}, headers=headers()).status_code == 422


def test_api_stats_and_drilldown(client, database):
    a, b = seed_stats(database)
    stats = client.get("/api/behavior/stats?start_date=2026-10-05&end_date=2026-10-06", headers=headers()).json()
    assert [d["date"] for d in stats["days"]] == ["2026-10-05", "2026-10-06"]
    flagged = client.get(f"/api/behavior/marks/by-question?question_id={a}", headers=headers()).json()["trades"]
    assert len(flagged) == 3
    assert client.get(f"/api/behavior/marks/by-question?question_id={a}", headers=headers(OTHER)).json()["trades"] == []


def test_api_shared_real_session_is_readable_by_viewer_but_not_writable(client, database, monkeypatch):
    add_session(database, "real1", session_type="real")
    qid = client.post("/api/behavior/questions", json={"text": "A", "kind": "entry"}, headers=headers()).json()["question_id"]
    client.post("/api/behavior/marks", json={"session_id": "real1", "round_trip_index": 0, "answers": {qid: True}}, headers=headers())
    monkeypatch.setattr("app.services.analysis_sharing.can_read", lambda session, viewer: viewer in (session["user_id"], OTHER))
    assert client.get("/api/behavior/marks?session_id=real1", headers=headers(OTHER)).status_code == 200
    body = {"session_id": "real1", "round_trip_index": 1, "answers": {qid: True}}
    assert client.post("/api/behavior/marks", json=body, headers=headers(OTHER)).status_code == 404


def test_cascade_delete_removes_marks_and_tolerates_missing_table(database, monkeypatch):
    from app.services.session_cleanup_service import delete_session_cascade
    monkeypatch.setattr("app.services.snapshot_service.delete_snapshots", lambda sid: None)
    monkeypatch.setattr("app.services.simulation.get_session", lambda sid: None)
    monkeypatch.setattr("app.services.wallet_service.delete_entry", lambda *a, **k: None)
    for name, sort, kind in [("Trades", "trade_id", "S"), ("Orders", "order_id", "S"), ("AIDecisionLog", "ts_command_id", "S")]:
        database.create_table(
            TableName=name, BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": sort, "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": sort, "AttributeType": kind}],
        )
    for name, index, key in [("Strategies", "SessionIdIndex", "session_id"), ("AICommands", "SessionCommandsIndex", "session_id")]:
        keys = [{"AttributeName": "strategy_id" if name == "Strategies" else "user_id", "KeyType": "HASH"}]
        attrs = [{"AttributeName": keys[0]["AttributeName"], "AttributeType": "S"}, {"AttributeName": "session_id", "AttributeType": "S"}]
        if name == "AICommands":
            keys.append({"AttributeName": "command_id", "KeyType": "RANGE"})
            attrs.append({"AttributeName": "command_id", "AttributeType": "S"})
        database.create_table(
            TableName=name, BillingMode="PAY_PER_REQUEST", KeySchema=keys, AttributeDefinitions=attrs,
            GlobalSecondaryIndexes=[{"IndexName": index, "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
        )
    session = add_session(database)
    # No BehaviorMarks table yet: cascade still succeeds.
    delete_session_cascade("s1", USER, "2026-10-06", reset_wallet=False)
    session = add_session(database)
    qid = svc.add_question(USER, "A", "entry")["question_id"]
    svc.set_marks(USER, session, 0, {qid: True})
    delete_session_cascade("s1", USER, "2026-10-06", reset_wallet=False)
    assert svc.get_marks("s1") == []


def test_label_view_setting_defaults_and_validates():
    from app.models.schemas import UserSettingsResponse, UserSettingsUpdateRequest
    from app.services.user_settings_service import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["analysis_label_view"] == "one_by_one"
    assert UserSettingsResponse().analysis_label_view == "one_by_one"
    assert UserSettingsUpdateRequest(analysis_label_view="all").analysis_label_view == "all"
    with pytest.raises(ValueError):
        UserSettingsUpdateRequest(analysis_label_view="grid")
