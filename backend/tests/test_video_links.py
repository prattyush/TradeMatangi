"""Phase 24 Y3 — saved YouTube links for Video Maker videos: service, API and desktop transport."""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import video_links_service as svc
from tests.test_behavior import add_session, database as behavior_database  # noqa: F401  (fixtures)
from tests.test_desktop_behavior import as_user  # noqa: F401  (fixture)

VIDEO = "dQw4w9WgXcQ"
OTHER_VIDEO = "abcdefghijk"
WEB = "/api/video-links"
DESKTOP = "/api/desktop/v1/analysis/video-links"


@pytest.fixture
def database(behavior_database, monkeypatch):
    monkeypatch.setattr(svc, "_ENSURED", False)
    return behavior_database


def body(session_id="s1", video_id=VIDEO, **extra):
    return {"session_id": session_id, "video_id": video_id, "title": "NIFTY trades", "privacy": "private", **extra}


def headers(user):
    return {"X-User-Id": user}


# ── Service ──────────────────────────────────────────────────────────────────

def test_save_builds_the_url_from_the_video_id_and_lists_newest_first(database):
    add_session(database)
    first = svc.save_link("alice", "s1", VIDEO, "  NIFTY   trades ", "private", "0:00 Open")
    assert first["url"] == f"https://www.youtube.com/watch?v={VIDEO}"
    assert first["title"] == "NIFTY trades"
    assert first["chapters"] == "0:00 Open"
    svc.save_link("alice", "s1", OTHER_VIDEO, "Second", "unlisted")
    assert [r["video_id"] for r in svc.list_links("s1")] == [OTHER_VIDEO, VIDEO]


def test_saving_the_same_video_again_updates_it_and_keeps_the_upload_time(database):
    add_session(database)
    first = svc.save_link("alice", "s1", VIDEO, "Old", "private")
    again = svc.save_link("alice", "s1", VIDEO, "New", "public")
    assert len(svc.list_links("s1")) == 1
    assert (again["title"], again["privacy"]) == ("New", "public")
    assert again["uploaded_at"] == first["uploaded_at"]


@pytest.mark.parametrize("video_id,title,privacy,chapters", [
    ("short", "T", "private", ""),
    ("has space!!", "T", "private", ""),
    ("javascript:alert(1)", "T", "private", ""),
    (VIDEO, "   ", "private", ""),
    (VIDEO, "x" * 101, "private", ""),
    (VIDEO, "T", "secret", ""),
    (VIDEO, "T", "private", "é" * 2501),
])
def test_save_validation(database, video_id, title, privacy, chapters):
    with pytest.raises(ValueError):
        svc.save_link("alice", "s1", video_id, title, privacy, chapters)


def test_per_session_cap_allows_updating_an_existing_video(database, monkeypatch):
    monkeypatch.setattr(svc, "MAX_LINKS_PER_SESSION", 1)
    svc.save_link("alice", "s1", VIDEO, "A", "private")
    with pytest.raises(ValueError):
        svc.save_link("alice", "s1", OTHER_VIDEO, "B", "private")
    assert svc.save_link("alice", "s1", VIDEO, "A2", "private")["title"] == "A2"


def test_delete_removes_only_the_link(database):
    svc.save_link("alice", "s1", VIDEO, "A", "private")
    svc.save_link("alice", "s1", OTHER_VIDEO, "B", "private")
    svc.delete_link("s1", VIDEO)
    assert [r["video_id"] for r in svc.list_links("s1")] == [OTHER_VIDEO]
    with pytest.raises(LookupError):
        svc.delete_link("s1", VIDEO)


def test_list_user_links_covers_all_sessions_of_that_user_newest_first(database):
    svc.save_link("alice", "s1", VIDEO, "First", "private")
    svc.save_link("alice", "s2", OTHER_VIDEO, "Second", "unlisted")
    svc.save_link("bob", "s9", "zzzzzzzzzzz", "Not mine", "private")
    rows = svc.list_user_links("alice")
    assert [(r["session_id"], r["title"]) for r in rows] == [("s2", "Second"), ("s1", "First")]
    assert svc.list_user_links("nobody") == []


def test_list_user_links_is_capped(database, monkeypatch):
    monkeypatch.setattr(svc, "MAX_LINKS_LISTED", 2)
    for i, vid in enumerate(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]):
        svc.save_link("alice", f"s{i}", vid, f"T{i}", "private")
    assert len(svc.list_user_links("alice")) == 2


# ── Website API ──────────────────────────────────────────────────────────────

def test_api_save_list_delete_round_trip(database):
    add_session(database)
    client = TestClient(app)
    saved = client.post(WEB, json=body(), headers=headers("alice"))
    assert saved.status_code == 200, saved.text
    assert saved.json()["url"].endswith(VIDEO)
    listed = client.get(f"{WEB}?session_id=s1", headers=headers("alice")).json()["links"]
    assert [r["video_id"] for r in listed] == [VIDEO]
    assert client.delete(f"{WEB}?session_id=s1&video_id={VIDEO}", headers=headers("alice")).json() == {"deleted": True}
    assert client.get(f"{WEB}?session_id=s1", headers=headers("alice")).json()["links"] == []
    assert client.delete(f"{WEB}?session_id=s1&video_id={VIDEO}", headers=headers("alice")).status_code == 404


def test_api_rejects_bad_input_with_400(database):
    add_session(database)
    client = TestClient(app)
    assert client.post(WEB, json=body(video_id="nope"), headers=headers("alice")).status_code == 400
    assert client.post(WEB, json=body(privacy="secret"), headers=headers("alice")).status_code == 422


def test_api_mine_lists_only_the_callers_links(database):
    add_session(database, "s1", user="alice")
    add_session(database, "s2", user="bob")
    client = TestClient(app)
    client.post(WEB, json=body("s1"), headers=headers("alice"))
    client.post(WEB, json=body("s2", video_id=OTHER_VIDEO), headers=headers("bob"))
    mine = client.get(f"{WEB}/mine", headers=headers("alice")).json()["links"]
    assert [(r["session_id"], r["video_id"]) for r in mine] == [("s1", VIDEO)]
    assert client.get(f"{WEB}/mine", headers=headers("carol")).json() == {"links": []}


def test_other_users_get_404_and_cannot_change_anything(database):
    add_session(database, "s1", user="alice")
    client = TestClient(app)
    client.post(WEB, json=body(), headers=headers("alice"))
    assert client.get(f"{WEB}?session_id=s1", headers=headers("bob")).status_code == 404
    assert client.post(WEB, json=body(video_id=OTHER_VIDEO), headers=headers("bob")).status_code == 404
    assert client.delete(f"{WEB}?session_id=s1&video_id={VIDEO}", headers=headers("bob")).status_code == 404
    assert [r["video_id"] for r in svc.list_links("s1")] == [VIDEO]


def test_unknown_session_is_404(database):
    client = TestClient(app)
    assert client.post(WEB, json=body("missing"), headers=headers("alice")).status_code == 404


def test_shared_read_viewer_cannot_see_links(database, monkeypatch):
    """Analysis may share a real session read-only; the links to private videos stay with the owner."""
    add_session(database, "s1", user="alice", session_type="real")
    monkeypatch.setattr("app.services.analysis_sharing.can_read", lambda session, user: True)
    client = TestClient(app)
    client.post(WEB, json=body(), headers=headers("alice"))
    assert client.get(f"{WEB}?session_id=s1", headers=headers("bob")).status_code == 404


# ── Desktop transport ────────────────────────────────────────────────────────

def test_desktop_route_is_owner_only_and_exposes_only_the_listed_methods(database, as_user):
    add_session(database, "s1", user="alice")
    client = TestClient(app)
    assert client.post(DESKTOP, json=body()).status_code == 200
    assert [r["video_id"] for r in client.get(f"{DESKTOP}?session_id=s1").json()["links"]] == [VIDEO]
    as_user["user"] = "bob"
    assert client.get(f"{DESKTOP}?session_id=s1").status_code == 404
    assert client.post(DESKTOP, json=body(video_id=OTHER_VIDEO)).status_code == 404
    assert client.delete(f"{DESKTOP}?session_id=s1&video_id={VIDEO}").status_code == 404
    as_user["user"] = "alice"
    assert client.put(DESKTOP, json=body()).status_code in (404, 405)
    assert client.delete(f"{DESKTOP}?session_id=s1&video_id={VIDEO}").json() == {"deleted": True}


def test_desktop_mine_route_lists_the_callers_links(database, as_user):
    add_session(database, "s1", user="alice")
    client = TestClient(app)
    client.post(DESKTOP, json=body())
    assert [r["video_id"] for r in client.get(f"{DESKTOP}/mine").json()["links"]] == [VIDEO]
    as_user["user"] = "bob"
    assert client.get(f"{DESKTOP}/mine").json() == {"links": []}
    assert client.post(f"{DESKTOP}/mine", json=body()).status_code in (404, 405)


def test_desktop_shared_read_viewer_gets_404(database, as_user, monkeypatch):
    add_session(database, "s1", user="alice", session_type="real")
    client = TestClient(app)
    client.post(DESKTOP, json=body())
    monkeypatch.setattr("app.services.analysis_sharing.can_read", lambda session, user: True)
    as_user["user"] = "bob"
    assert client.get(f"{DESKTOP}?session_id=s1").status_code == 404


# ── Session cleanup ──────────────────────────────────────────────────────────

def test_cascade_delete_removes_links_and_tolerates_a_missing_table(database, monkeypatch):
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
    add_session(database)
    delete_session_cascade("s1", "alice", "2026-10-06", reset_wallet=False)  # no VideoLinks table yet
    add_session(database)
    svc.save_link("alice", "s1", VIDEO, "A", "private")
    svc.save_link("alice", "s2", OTHER_VIDEO, "B", "private")
    delete_session_cascade("s1", "alice", "2026-10-06", reset_wallet=False)
    assert svc.list_links("s1") == []
    assert [r["video_id"] for r in svc.list_links("s2")] == [OTHER_VIDEO]
