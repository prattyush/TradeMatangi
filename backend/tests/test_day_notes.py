"""Phase 27 S5 — day notes and carried-over TODOs: service, API and the desktop transport."""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import day_notes_service as svc
from tests.test_behavior import database as behavior_database  # noqa: F401  (fixture)
from tests.test_desktop_behavior import as_user  # noqa: F401  (fixture)

WEB = "/api/day-notes"
DESKTOP = "/api/desktop/v1/analysis/day-notes"
D1, D2, D3, D4 = "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"


@pytest.fixture
def database(behavior_database, monkeypatch):
    monkeypatch.setattr(svc, "_ENSURED", set())
    return behavior_database


def headers(user):
    return {"X-User-Id": user}


def texts(todos):
    return [t["text"] for t in todos]


# ── Notes ────────────────────────────────────────────────────────────────────

def test_a_note_is_trimmed_replaced_and_private(database):
    assert svc.get_note("alice", D1) is None
    saved = svc.save_note("alice", D1, {"went_well": "  Waited for the retest ", "to_improve": "Size", "specific_points": "", "context": "Gap-up day"})
    assert saved["went_well"] == "Waited for the retest" and saved["context"] == "Gap-up day" and saved["specific_points"] == ""
    svc.save_note("alice", D1, {"went_well": "Replaced"})
    assert svc.get_note("alice", D1)["went_well"] == "Replaced" and svc.get_note("alice", D1)["to_improve"] == ""
    assert svc.get_note("bob", D1) is None
    assert svc.get_note("alice", D2) is None


def test_a_note_with_every_part_empty_is_removed(database):
    svc.save_note("alice", D1, {"context": "x"})
    assert svc.save_note("alice", D1, {"context": "   ", "went_well": ""}) is None
    assert svc.get_note("alice", D1) is None


@pytest.mark.parametrize("date", ["", "2026-13-01", "2026-02-30", "16-11-2026", "yesterday"])
def test_a_bad_date_is_refused(database, date):
    with pytest.raises(ValueError):
        svc.save_note("alice", date, {"context": "x"})
    with pytest.raises(ValueError):
        svc.add_todo("alice", date, "x")


def test_a_note_part_has_a_length_limit(database):
    with pytest.raises(ValueError):
        svc.save_note("alice", D1, {"context": "x" * (svc.NOTE_MAX_CHARS + 1)})
    svc.save_note("alice", D1, {"context": "x" * svc.NOTE_MAX_CHARS})


# ── TODOs ────────────────────────────────────────────────────────────────────

def test_a_todo_is_carried_until_it_is_closed(database):
    todo = svc.add_todo("alice", D1, "  Wait for the retest  ")
    assert todo["text"] == "Wait for the retest" and todo["status"] == "open" and todo["carried"] is False
    # Open on every later day, marked as carried, until it is closed.
    assert [(t["text"], t["carried"]) for t in svc.todos_for_day("alice", D2)] == [("Wait for the retest", True)]
    svc.set_status("alice", todo["todo_id"], D2, "working")
    assert svc.todos_for_day("alice", D3)[0]["status"] == "working"
    svc.set_status("alice", todo["todo_id"], D3, "improved")
    closed_day = svc.todos_for_day("alice", D3)
    assert [(t["status"]) for t in closed_day] == ["improved"], "the day it was closed still shows it"
    assert svc.todos_for_day("alice", D4) == [], "and no later day does"


def test_reviewing_an_older_day_shows_the_todo_as_it_stood_then(database):
    todo = svc.add_todo("alice", D1, "Cut losers early")
    svc.set_status("alice", todo["todo_id"], D2, "working")
    svc.set_status("alice", todo["todo_id"], D4, "done")
    assert svc.todos_for_day("alice", D1)[0]["status"] == "open"
    assert svc.todos_for_day("alice", D3)[0]["status"] == "working"
    assert [t["status"] for t in svc.todos_for_day("alice", D4)] == ["done"]
    assert svc.todos_for_day("alice", "2026-11-15") == [], "a day before it was written does not show it"


def test_carried_todos_come_first_and_each_is_listed_oldest_first(database):
    svc.add_todo("alice", D2, "Today's own")
    svc.add_todo("alice", D1, "Old one")
    assert texts(svc.todos_for_day("alice", D2)) == ["Old one", "Today's own"]
    assert [t["carried"] for t in svc.todos_for_day("alice", D2)] == [True, False]


def test_status_history_keeps_one_entry_per_day_and_can_reopen(database):
    todo = svc.add_todo("alice", D1, "Size down")
    svc.set_status("alice", todo["todo_id"], D2, "done")
    svc.set_status("alice", todo["todo_id"], D2, "working")  # changed my mind the same day
    svc.set_status("alice", todo["todo_id"], D3, "open")
    history = svc.list_todos("alice")[0]["history"]
    assert [(h["date"], h["status"]) for h in history] == [(D1, "open"), (D2, "working"), (D3, "open")]
    assert svc.list_todos("alice")[0]["status"] == "open"
    assert svc.todos_for_day("alice", D4)[0]["status"] == "open"


def test_a_todo_cannot_change_before_it_was_written_and_bad_values_are_refused(database):
    todo = svc.add_todo("alice", D2, "x")
    with pytest.raises(ValueError):
        svc.set_status("alice", todo["todo_id"], D1, "done")
    with pytest.raises(ValueError):
        svc.set_status("alice", todo["todo_id"], D2, "finished")
    with pytest.raises(LookupError):
        svc.set_status("alice", "nope", D2, "done")
    for text in ("", "   ", "x" * (svc.TODO_MAX_CHARS + 1)):
        with pytest.raises(ValueError):
            svc.add_todo("alice", D1, text)


def test_todos_are_private_and_deletable_and_capped(database, monkeypatch):
    todo = svc.add_todo("alice", D1, "Mine")
    assert svc.list_todos("bob") == [] and svc.todos_for_day("bob", D2) == []
    with pytest.raises(LookupError):
        svc.set_status("bob", todo["todo_id"], D1, "done")
    with pytest.raises(LookupError):
        svc.delete_todo("bob", todo["todo_id"])
    monkeypatch.setattr(svc, "MAX_TODOS", 2)
    svc.add_todo("alice", D1, "Two")
    with pytest.raises(ValueError):
        svc.add_todo("alice", D1, "Three")
    svc.delete_todo("alice", todo["todo_id"])
    assert texts(svc.list_todos("alice")) == ["Two"]
    svc.add_todo("alice", D1, "Three")


def test_the_review_list_is_newest_first_with_every_history(database):
    a = svc.add_todo("alice", D1, "First")
    svc.add_todo("alice", D3, "Third")
    svc.set_status("alice", a["todo_id"], D2, "improved")
    rows = svc.list_todos("alice")
    assert texts(rows) == ["Third", "First"]
    assert [h["status"] for h in rows[1]["history"]] == ["open", "improved"] and rows[1]["status"] == "improved"


# ── API ──────────────────────────────────────────────────────────────────────

def test_api_round_trip(database):
    client = TestClient(app)
    alice = headers("alice")
    assert client.get(f"{WEB}?date={D1}", headers=alice).json() == {"date": D1, "note": None, "todos": []}
    day = client.post(WEB, json={"date": D1, "went_well": "Patience", "context": "Trend day"}, headers=alice).json()
    assert day["note"]["went_well"] == "Patience" and day["note"]["to_improve"] == ""
    day = client.post(f"{WEB}/todos", json={"date": D1, "text": "Wait for the retest"}, headers=alice).json()
    todo_id = day["todos"][0]["todo_id"]
    carried = client.get(f"{WEB}?date={D2}", headers=alice).json()
    assert carried["note"] is None and [(t["text"], t["carried"]) for t in carried["todos"]] == [("Wait for the retest", True)]
    closed = client.post(f"{WEB}/todos/status", json={"todo_id": todo_id, "date": D2, "status": "improved"}, headers=alice).json()
    assert closed["todos"][0]["status"] == "improved"
    assert client.get(f"{WEB}?date={D3}", headers=alice).json()["todos"] == []
    assert client.get(f"{WEB}/todos", headers=alice).json()["todos"][0]["history"][-1] == {**closed["todos"][0]["history"][-1]}
    assert client.delete(f"{WEB}/todos?todo_id={todo_id}&date={D2}", headers=alice).json()["todos"] == []
    # another user sees none of it
    assert client.get(f"{WEB}?date={D1}", headers=headers("bob")).json()["note"] is None


def test_api_errors(database):
    client = TestClient(app)
    alice = headers("alice")
    assert client.get(f"{WEB}?date=bad", headers=alice).status_code == 400
    assert client.post(f"{WEB}/todos", json={"date": D1, "text": "  "}, headers=alice).status_code == 400
    assert client.post(f"{WEB}/todos/status", json={"todo_id": "nope", "date": D1, "status": "done"}, headers=alice).status_code == 404
    assert client.post(f"{WEB}/todos/status", json={"todo_id": "x", "date": D1, "status": "finished"}, headers=alice).status_code == 422
    assert client.delete(f"{WEB}/todos?todo_id=nope&date={D1}", headers=alice).status_code == 404


def test_desktop_route_exposes_exactly_the_listed_paths_and_methods(database, as_user):
    client = TestClient(app)
    assert client.post(DESKTOP, json={"date": D1, "context": "x"}).status_code == 200
    todo = client.post(f"{DESKTOP}/todos", json={"date": D1, "text": "Size"}).json()["todos"][0]
    assert client.get(f"{DESKTOP}?date={D2}").json()["todos"][0]["carried"] is True
    assert client.post(f"{DESKTOP}/todos/status", json={"todo_id": todo["todo_id"], "date": D2, "status": "working"}).status_code == 200
    assert client.get(f"{DESKTOP}/todos").json()["todos"][0]["status"] == "working"
    as_user["user"] = "bob"
    assert client.get(f"{DESKTOP}/todos").json() == {"todos": []}
    assert client.post(f"{DESKTOP}/todos/status", json={"todo_id": todo["todo_id"], "date": D2, "status": "done"}).status_code == 404
    as_user["user"] = "alice"
    for method, path in (("put", DESKTOP), ("delete", DESKTOP), ("get", f"{DESKTOP}/todos/status"), ("put", f"{DESKTOP}/todos"), ("patch", DESKTOP)):
        assert getattr(client, method)(path).status_code in (404, 405), (method, path)
    assert client.delete(f"{DESKTOP}/todos?todo_id={todo['todo_id']}&date={D2}").status_code == 200
