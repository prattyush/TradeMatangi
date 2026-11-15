"""Phase 24 What If — saved scenarios: service, API, range comparison, desktop transport, cleanup."""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import whatif_service as svc
from tests.test_behavior import add_session, database as behavior_database  # noqa: F401  (fixtures)
from tests.test_desktop_behavior import as_user  # noqa: F401  (fixture)

WEB = "/api/whatif"
DESKTOP = "/api/desktop/v1/analysis/whatif"


@pytest.fixture
def database(behavior_database, monkeypatch):
    monkeypatch.setattr(svc, "_ENSURED", False)
    return behavior_database


def edit(round_trip=0, leg_id="t1", role="exit", price=105.5, quantity=75):
    return {"round_trip": round_trip, "leg_id": leg_id, "role": role, "price": price, "quantity": quantity}


def summary(**extra):
    return {"actual_pnl": 1000.0, "whatif_pnl": 1500.5, "delta": 500.5, "delta_pct": 0.1001, "trips_edited": 1, "warnings": 0, **extra}


def body(session_id="s1", name="Exit at close", **extra):
    return {"session_id": session_id, "name": name, "edits": [edit()], "summary": summary(), **extra}


def headers(user):
    return {"X-User-Id": user}


def session_of(database, session_id="s1", user="alice", date="2026-11-09"):
    add_session(database, session_id, user=user, date=date)
    from app.services import trade_label_service
    return trade_label_service._load_session(session_id)


# ── Service ──────────────────────────────────────────────────────────────────

def test_slug_is_the_name_in_lower_case_words(database):
    assert svc.scenario_slug("Exit at Close!") == "exit-at-close"
    assert svc.scenario_slug("  No   averaging 2 ") == "no-averaging-2"
    assert svc.scenario_slug("!!!") == ""
    assert len(svc.scenario_slug("x" * 100)) <= 40


def test_save_keeps_date_and_symbol_from_the_session_and_lists_newest_first(database):
    session = session_of(database)
    first = svc.save_scenario("alice", session, "  Exit   at close ", [edit(), edit(1, "t9", "entry", 99.25, 0)], summary())
    assert first["scenario_id"] == "exit-at-close"
    assert first["name"] == "Exit at close"
    assert first["date"] == session["date"] and first["symbol"] == session["symbol"]
    assert first["edits"][1] == {"round_trip": 1, "leg_id": "t9", "role": "entry", "price": 99.25, "quantity": 0}
    assert first["summary"]["whatif_pnl"] == 1500.5
    svc.save_scenario("alice", session, "No averaging", [edit()], summary())
    assert [r["scenario_id"] for r in svc.list_scenarios("s1")] == ["no-averaging", "exit-at-close"]


def test_saving_the_same_name_replaces_it(database):
    session = session_of(database)
    svc.save_scenario("alice", session, "Idea", [edit(price=100)], summary(whatif_pnl=1.0, delta=-999.0))
    again = svc.save_scenario("alice", session, "idea", [edit(price=200), edit(2, "t3")], summary(whatif_pnl=7.0, delta=-993.0))
    rows = svc.list_scenarios("s1")
    assert len(rows) == 1
    assert rows[0]["edits"] == again["edits"] and len(rows[0]["edits"]) == 2
    assert rows[0]["summary"]["whatif_pnl"] == 7.0


@pytest.mark.parametrize("edits", [
    "not a list",
    [{"round_trip": 0, "leg_id": "", "role": "exit", "price": 1, "quantity": 1}],
    [{"round_trip": 0, "leg_id": "t", "role": "hold", "price": 1, "quantity": 1}],
    [edit(price=0)], [edit(price=-5)], [edit(price=float("inf"))], [edit(price=float("nan"))], [edit(price=True)],
    [edit(quantity=-1)], [edit(quantity=1.5)], [edit(round_trip=-1)], [edit(round_trip=1.5)],
    [edit(leg_id="x" * 121)],
    [edit(), edit()],  # the same leg twice
    [{"round_trip": 0, "leg_id": "t", "role": "exit", "price": 1}],  # no quantity
    ["nope"],
])
def test_edit_validation(database, edits):
    with pytest.raises(ValueError):
        svc.save_scenario("alice", session_of(database), "Idea", edits, summary())


@pytest.mark.parametrize("bad", [
    {**summary(), "actual_pnl": None}, {**summary(), "whatif_pnl": float("inf")}, {**summary(), "delta": "10"},
    {**summary(), "trips_edited": -1}, {**summary(), "delta_pct": float("nan")}, "nope",
])
def test_summary_validation(database, bad):
    with pytest.raises(ValueError):
        svc.save_scenario("alice", session_of(database), "Idea", [edit()], bad)


@pytest.mark.parametrize("name", ["", "   ", "!!!", "x" * 61])
def test_name_validation(database, name):
    with pytest.raises(ValueError):
        svc.save_scenario("alice", session_of(database), name, [edit()], summary())


def test_a_summary_without_a_percent_is_kept_as_none(database):
    saved = svc.save_scenario("alice", session_of(database), "Idea", [edit()], summary(delta_pct=None))
    assert saved["summary"]["delta_pct"] is None


def test_too_many_edits_and_too_many_scenarios_are_refused_but_updating_one_is_allowed(database, monkeypatch):
    session = session_of(database)
    monkeypatch.setattr(svc, "MAX_EDITS", 2)
    with pytest.raises(ValueError):
        svc.save_scenario("alice", session, "Idea", [edit(leg_id="a"), edit(leg_id="b"), edit(leg_id="c")], summary())
    monkeypatch.setattr(svc, "MAX_SCENARIOS_PER_SESSION", 1)
    svc.save_scenario("alice", session, "One", [edit()], summary())
    with pytest.raises(ValueError):
        svc.save_scenario("alice", session, "Two", [edit()], summary())
    assert svc.save_scenario("alice", session, "one", [edit(price=9)], summary())["edits"][0]["price"] == 9


def test_delete_removes_only_that_scenario(database):
    session = session_of(database)
    svc.save_scenario("alice", session, "A", [edit()], summary())
    svc.save_scenario("alice", session, "B", [edit()], summary())
    svc.delete_scenario("s1", "a")
    assert [r["scenario_id"] for r in svc.list_scenarios("s1")] == ["b"]
    with pytest.raises(LookupError):
        svc.delete_scenario("s1", "a")


def test_range_lists_a_users_scenarios_across_days_without_edits(database):
    for sid, day in [("s1", "2026-11-05"), ("s2", "2026-11-09"), ("s3", "2026-11-20")]:
        svc.save_scenario("alice", session_of(database, sid, "alice", day), "Exit at close", [edit()], summary(actual_pnl=100.0, whatif_pnl=150.0, delta=50.0))
    svc.save_scenario("bob", session_of(database, "s9", "bob", "2026-11-09"), "Exit at close", [edit()], summary())
    rows = svc.list_range("alice", "2026-11-05", "2026-11-12")
    assert [(r["date"], r["session_id"]) for r in rows] == [("2026-11-05", "s1"), ("2026-11-09", "s2")]
    assert all("edits" not in r for r in rows)
    assert rows[0]["summary"]["delta"] == 50.0
    assert [r["session_id"] for r in svc.list_range("alice", start_date="2026-11-09")] == ["s2", "s3"]
    assert [r["session_id"] for r in svc.list_range("alice", end_date="2026-11-05")] == ["s1"]
    assert len(svc.list_range("alice")) == 3
    assert svc.list_range("nobody") == []


def test_range_is_capped(database, monkeypatch):
    monkeypatch.setattr(svc, "MAX_RANGE_ROWS", 2)
    for i in range(3):
        svc.save_scenario("alice", session_of(database, f"s{i}", "alice", f"2026-11-0{i + 1}"), "Idea", [edit()], summary())
    assert len(svc.list_range("alice")) == 2


# ── Website API ──────────────────────────────────────────────────────────────

def test_api_save_list_delete_round_trip(database):
    session_of(database)
    client = TestClient(app)
    saved = client.post(WEB, json=body(), headers=headers("alice"))
    assert saved.status_code == 200, saved.text
    assert saved.json()["scenario_id"] == "exit-at-close"
    listed = client.get(f"{WEB}?session_id=s1", headers=headers("alice")).json()["scenarios"]
    assert [r["name"] for r in listed] == ["Exit at close"]
    assert listed[0]["edits"] == [edit()]
    assert client.delete(f"{WEB}?session_id=s1&scenario_id=exit-at-close", headers=headers("alice")).json() == {"deleted": True}
    assert client.get(f"{WEB}?session_id=s1", headers=headers("alice")).json()["scenarios"] == []
    assert client.delete(f"{WEB}?session_id=s1&scenario_id=exit-at-close", headers=headers("alice")).status_code == 404


def test_api_rejects_bad_input(database):
    session_of(database)
    client = TestClient(app)
    assert client.post(WEB, json=body(name="   "), headers=headers("alice")).status_code == 400
    assert client.post(WEB, json={**body(), "edits": [edit(price=0)]}, headers=headers("alice")).status_code == 422
    assert client.post(WEB, json={**body(), "summary": {**summary(), "delta": "x"}}, headers=headers("alice")).status_code == 422
    assert client.post(WEB, json={**body(), "edits": [edit(role="hold")]}, headers=headers("alice")).status_code == 422
    assert client.get(f"{WEB}/range?start=2026-11-30&end=2026-11-01", headers=headers("alice")).status_code == 400
    assert client.get(f"{WEB}/range?start=notadate", headers=headers("alice")).status_code == 422


def test_api_range_returns_only_the_callers_summaries(database):
    session_of(database, "s1", "alice", "2026-11-05")
    session_of(database, "s2", "bob", "2026-11-05")
    client = TestClient(app)
    client.post(WEB, json=body("s1"), headers=headers("alice"))
    client.post(WEB, json=body("s2"), headers=headers("bob"))
    rows = client.get(f"{WEB}/range?start=2026-11-01&end=2026-11-30", headers=headers("alice")).json()["scenarios"]
    assert [(r["session_id"], r["date"], r["summary"]["delta"]) for r in rows] == [("s1", "2026-11-05", 500.5)]
    assert "edits" not in rows[0] or rows[0]["edits"] is None
    assert client.get(f"{WEB}/range", headers=headers("carol")).json() == {"scenarios": []}


def test_other_users_get_404_and_cannot_change_anything(database):
    session_of(database)
    client = TestClient(app)
    client.post(WEB, json=body(), headers=headers("alice"))
    assert client.get(f"{WEB}?session_id=s1", headers=headers("bob")).status_code == 404
    assert client.post(WEB, json=body(name="Other"), headers=headers("bob")).status_code == 404
    assert client.delete(f"{WEB}?session_id=s1&scenario_id=exit-at-close", headers=headers("bob")).status_code == 404
    assert [r["scenario_id"] for r in svc.list_scenarios("s1")] == ["exit-at-close"]


def test_unknown_session_is_404(database):
    assert TestClient(app).post(WEB, json=body("missing"), headers=headers("alice")).status_code == 404


def test_swing_portfolio_days_are_refused(database):
    add_session(database, "sw", user="alice")
    database.Table("Sessions").update_item(Key={"session_id": "sw"}, UpdateExpression="SET trading_style = :s", ExpressionAttributeValues={":s": "swing"})
    assert TestClient(app).post(WEB, json=body("sw"), headers=headers("alice")).status_code == 400


def test_shared_read_viewer_cannot_see_scenarios(database, monkeypatch):
    """Analysis may share a real session read-only; a what-if stays with its owner."""
    session_of(database)
    monkeypatch.setattr("app.services.analysis_sharing.can_read", lambda session, user: True)
    client = TestClient(app)
    client.post(WEB, json=body(), headers=headers("alice"))
    assert client.get(f"{WEB}?session_id=s1", headers=headers("bob")).status_code == 404


# ── Desktop transport ────────────────────────────────────────────────────────

def test_desktop_route_is_owner_only_and_exposes_only_the_listed_methods(database, as_user):
    session_of(database)
    client = TestClient(app)
    assert client.post(DESKTOP, json=body()).status_code == 200
    assert [r["scenario_id"] for r in client.get(f"{DESKTOP}?session_id=s1").json()["scenarios"]] == ["exit-at-close"]
    as_user["user"] = "bob"
    assert client.get(f"{DESKTOP}?session_id=s1").status_code == 404
    assert client.post(DESKTOP, json=body(name="Other")).status_code == 404
    assert client.delete(f"{DESKTOP}?session_id=s1&scenario_id=exit-at-close").status_code == 404
    as_user["user"] = "alice"
    assert client.put(DESKTOP, json=body()).status_code in (404, 405)
    assert client.delete(f"{DESKTOP}?session_id=s1&scenario_id=exit-at-close").json() == {"deleted": True}


def test_desktop_range_route_lists_the_callers_scenarios(database, as_user):
    session_of(database, "s1", "alice", "2026-11-05")
    client = TestClient(app)
    client.post(DESKTOP, json=body())
    rows = client.get(f"{DESKTOP}/range?start=2026-11-01&end=2026-11-30").json()["scenarios"]
    assert [r["session_id"] for r in rows] == ["s1"]
    as_user["user"] = "bob"
    assert client.get(f"{DESKTOP}/range").json() == {"scenarios": []}
    assert client.post(f"{DESKTOP}/range", json=body()).status_code in (404, 405)


# ── Session cleanup ──────────────────────────────────────────────────────────

def test_cascade_delete_removes_scenarios_and_tolerates_a_missing_table(database, monkeypatch):
    from app.services.session_cleanup_service import delete_session_cascade
    monkeypatch.setattr("app.services.snapshot_service.delete_snapshots", lambda sid: None)
    monkeypatch.setattr("app.services.simulation.get_session", lambda sid: None)
    monkeypatch.setattr("app.services.wallet_service.delete_entry", lambda *a, **k: None)
    for name, sort in [("Trades", "trade_id"), ("Orders", "order_id"), ("AIDecisionLog", "ts_command_id")]:
        database.create_table(
            TableName=name, BillingMode="PAY_PER_REQUEST",
            KeySchema=[{"AttributeName": "session_id", "KeyType": "HASH"}, {"AttributeName": sort, "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "session_id", "AttributeType": "S"}, {"AttributeName": sort, "AttributeType": "S"}],
        )
    for name, index, hash_key, extra in [("Strategies", "SessionIdIndex", "strategy_id", None), ("AICommands", "SessionCommandsIndex", "user_id", "command_id")]:
        keys = [{"AttributeName": hash_key, "KeyType": "HASH"}]
        attrs = [{"AttributeName": hash_key, "AttributeType": "S"}, {"AttributeName": "session_id", "AttributeType": "S"}]
        if extra:
            keys.append({"AttributeName": extra, "KeyType": "RANGE"})
            attrs.append({"AttributeName": extra, "AttributeType": "S"})
        database.create_table(
            TableName=name, BillingMode="PAY_PER_REQUEST", KeySchema=keys, AttributeDefinitions=attrs,
            GlobalSecondaryIndexes=[{"IndexName": index, "KeySchema": [{"AttributeName": "session_id", "KeyType": "HASH"}], "Projection": {"ProjectionType": "ALL"}}],
        )
    session = session_of(database)
    delete_session_cascade("s1", "alice", "2026-11-09", reset_wallet=False)  # no WhatIfScenarios table yet: nothing to delete, no error
    session = session_of(database)
    svc.save_scenario("alice", session, "Idea", [edit()], summary())
    svc.save_scenario("alice", session_of(database, "s2"), "Idea", [edit()], summary())
    assert len(svc.list_scenarios("s1")) == 1
    delete_session_cascade("s1", "alice", "2026-11-09", reset_wallet=False)
    assert svc.list_scenarios("s1") == []
    assert [r["session_id"] for r in svc.list_scenarios("s2")] == ["s2"]
