"""Games progress persistence (Phase 25, G2): table, /state routes, validation, concurrency, TTL."""
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from app.main import app
from app.routers import desktop_games
from app.services import games_persistence_service as games
from app.services.games_rate_limit import TokenBucket


@pytest.fixture
def db(monkeypatch):
    with mock_aws():
        kwargs = dict(region_name="us-east-1", aws_access_key_id="fake", aws_secret_access_key="fake")
        resource = boto3.resource("dynamodb", **kwargs)
        client = boto3.client("dynamodb", **kwargs)
        monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
        monkeypatch.setattr("app.services.db.get_dynamodb_client", lambda: client)
        monkeypatch.setattr(games, "_ENSURED", False)
        # Fresh limiter state per test.
        monkeypatch.setattr(desktop_games, "_state_reads", TokenBucket(1000, 1000))
        monkeypatch.setattr(desktop_games, "_state_writes", TokenBucket(1000, 1000))
        yield client


@pytest.fixture
def api(db):
    return TestClient(app)


def headers(user="alice"):
    return {"X-User-Id": user}


def game_body(mutation="mutation-0001", revision=0, game_id="quick_match", **item):
    return {"mutation_id": mutation, "game": {"id": game_id, "revision": revision, "item": {"level": 1, "sessions": 1, "lastScores": [55], **item}}}


# ----------------------------------------------------------------- registry and flag


def test_registry_has_the_31_ids_and_the_capability_flag():
    assert len(games.GAME_IDS) == 31 and len(games.MARKET_GAMES) == 10 and len(games.BRAIN_GAMES) == 21
    from app.routers.desktop import DesktopCapabilities
    assert "games" in DesktopCapabilities().features


@pytest.mark.parametrize("game_id", sorted(games.GAME_IDS))
def test_every_registry_id_is_accepted(api, game_id):
    response = api.put("/api/desktop/v1/games/state", json=game_body(game_id=game_id), headers=headers())
    assert response.status_code == 200, response.text
    assert response.json()["records"][f"game#{game_id}"]["revision"] == 1


# ----------------------------------------------------------------- round trip


def test_empty_state(api):
    state = api.get("/api/desktop/v1/games/state", headers=headers()).json()
    assert state == {"version": 1, "user_id": "alice", "profile": None, "games": {}, "days": {}, "months": {}}


def test_round_trip_one_transaction_for_game_day_month_and_profile(api):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    body = {
        "mutation_id": "mutation-0001",
        "game": {"id": "tick_reader", "revision": 0, "item": {"level": 3, "sessions": 5, "best": 81.5, "emaScore": 70.25, "lastScores": [60, 70, 81], "stats": {"expectancy_r": 0.35}, "lastPlayed": today}},
        "day": {"date": today, "revision": 0, "item": {"games": {"tick_reader": {"n": 2, "avg": 70, "best": 81}}, "warmupDone": True, "minutes": 12, "categoryScores": {"speed": 66.5}, "expectancyR": 0.2}},
        "month": {"month": today[:7], "revision": 0, "item": {"games": {"tick_reader": {"n": 9, "avg": 64.5, "best": 81}}, "days": 4}},
        "profile": {"revision": 0, "item": {"settings": {"soundOn": False}, "version": 1}},
    }
    put = api.put("/api/desktop/v1/games/state", json=body, headers=headers())
    assert put.status_code == 200 and put.json()["applied"] is True
    state = api.get("/api/desktop/v1/games/state", headers=headers()).json()
    assert state["games"]["tick_reader"]["level"] == 3 and state["games"]["tick_reader"]["best"] == 81.5
    assert state["games"]["tick_reader"]["revision"] == 1
    assert state["days"][today]["minutes"] == 12 and state["days"][today]["categoryScores"] == {"speed": 66.5}
    assert state["months"][today[:7]]["days"] == 4
    assert state["profile"]["settings"] == {"soundOn": False}
    # Storage keys and the TTL attribute are not part of the public record.
    assert "user_id" not in state["games"]["tick_reader"] and "expires_at" not in state["days"][today]


def test_second_write_with_the_current_revision_advances_it(api):
    api.put("/api/desktop/v1/games/state", json=game_body("mutation-0001"), headers=headers())
    second = api.put("/api/desktop/v1/games/state", json=game_body("mutation-0002", revision=1, level=2, sessions=2), headers=headers())
    assert second.status_code == 200
    state = api.get("/api/desktop/v1/games/state", headers=headers()).json()
    assert state["games"]["quick_match"]["revision"] == 2 and state["games"]["quick_match"]["level"] == 2


# ----------------------------------------------------------------- idempotency and conflicts


def test_retrying_the_same_mutation_is_a_no_op(api):
    first = api.put("/api/desktop/v1/games/state", json=game_body("mutation-0001"), headers=headers()).json()
    again = api.put("/api/desktop/v1/games/state", json=game_body("mutation-0001"), headers=headers())
    assert again.status_code == 200
    assert first["applied"] is True and again.json()["applied"] is False
    assert again.json()["records"]["game#quick_match"]["revision"] == 1


def test_stale_revision_gets_409_with_the_current_record(api):
    api.put("/api/desktop/v1/games/state", json=game_body("mutation-0001"), headers=headers())
    api.put("/api/desktop/v1/games/state", json=game_body("mutation-0002", revision=1, level=2), headers=headers())
    stale = api.put("/api/desktop/v1/games/state", json=game_body("mutation-0003", revision=1, level=9), headers=headers())
    assert stale.status_code == 409
    current = stale.json()["current"]["game#quick_match"]
    assert current["revision"] == 2 and current["level"] == 2
    assert api.get("/api/desktop/v1/games/state", headers=headers()).json()["games"]["quick_match"]["level"] == 2


def test_revision_zero_on_an_existing_record_conflicts(api):
    api.put("/api/desktop/v1/games/state", json=game_body("mutation-0001"), headers=headers())
    assert api.put("/api/desktop/v1/games/state", json=game_body("mutation-0002", revision=0), headers=headers()).status_code == 409


def test_transaction_is_all_or_nothing(api):
    """A conflict on the day record must leave the game record untouched."""
    day = {"date": "2026-11-14", "revision": 0, "item": {"minutes": 5}}
    api.put("/api/desktop/v1/games/state", json={"mutation_id": "mutation-0001", "day": day}, headers=headers())
    body = {**game_body("mutation-0002"), "day": {"date": "2026-11-14", "revision": 0, "item": {"minutes": 9}}}
    conflict = api.put("/api/desktop/v1/games/state", json=body, headers=headers())
    assert conflict.status_code == 409
    assert conflict.json()["current"]["game#quick_match"] is None
    state = api.get("/api/desktop/v1/games/state", headers=headers()).json()
    assert state["games"] == {}


def test_users_are_isolated(api):
    api.put("/api/desktop/v1/games/state", json=game_body("mutation-0001", level=7), headers=headers("alice"))
    api.put("/api/desktop/v1/games/state", json=game_body("mutation-0001", level=2), headers=headers("bob"))
    assert api.get("/api/desktop/v1/games/state", headers=headers("alice")).json()["games"]["quick_match"]["level"] == 7
    assert api.get("/api/desktop/v1/games/state", headers=headers("bob")).json()["games"]["quick_match"]["level"] == 2
    assert api.get("/api/desktop/v1/games/state", headers=headers("carol")).json()["games"] == {}


# ----------------------------------------------------------------- validation


@pytest.mark.parametrize("mutate,fragment", [
    (lambda b: b["game"].update(id="not_a_game"), "unknown game id"),
    (lambda b: b["game"]["item"].update(level=21), "level"),
    (lambda b: b["game"]["item"].update(level=0), "level"),
    (lambda b: b["game"]["item"].update(level=True), "level"),
    (lambda b: b["game"]["item"].update(unknown_field=1), "unknown field"),
    (lambda b: b["game"]["item"].update(lastScores=[1] * 21), "lastScores"),
    (lambda b: b["game"]["item"].update(lastScores=[101]), "lastScores"),
    (lambda b: b["game"]["item"].update(stats={f"k{i}": 1 for i in range(21)}), "stats"),
    (lambda b: b["game"]["item"].update(stats={"Bad Key": 1}), "stats"),
    (lambda b: b["game"]["item"].update(stats={"ok": "text"}), "stats"),
    (lambda b: b["game"].update(revision=-1), "revision"),
    (lambda b: b["game"].pop("revision"), "revision"),
    (lambda b: b.pop("mutation_id"), "mutation_id"),
    (lambda b: b.update(extra=1), "unknown field"),
    (lambda b: b.update(day={"date": "2026-13-45", "revision": 0, "item": {}}), "real date"),
    (lambda b: b.update(day={"date": "yesterday", "revision": 0, "item": {}}), "date"),
    (lambda b: b.update(day={"date": "2026-11-14", "revision": 0, "item": {"games": {"nope": {"n": 1}}}}), "unknown game id"),
    (lambda b: b.update(day={"date": "2026-11-14", "revision": 0, "item": {"categoryScores": {"cooking": 1}}}), "categoryScores"),
])
def test_invalid_bodies_are_rejected_with_422(api, mutate, fragment):
    body = game_body()
    mutate(body)
    response = api.put("/api/desktop/v1/games/state", json=body, headers=headers())
    assert response.status_code == 422, response.text
    assert fragment in response.json()["detail"]
    assert api.get("/api/desktop/v1/games/state", headers=headers()).json()["games"] == {}


def test_empty_write_is_rejected(api):
    assert api.put("/api/desktop/v1/games/state", json={"mutation_id": "mutation-0001"}, headers=headers()).status_code == 422


def test_size_caps(api):
    big_settings = {"blob": "x" * 5000}
    over_type_cap = api.put("/api/desktop/v1/games/state", json={"mutation_id": "mutation-0001", "profile": {"revision": 0, "item": {"settings": big_settings}}}, headers=headers())
    assert over_type_cap.status_code == 422 and "byte cap" in over_type_cap.json()["detail"]
    huge = api.put("/api/desktop/v1/games/state", json={"mutation_id": "mutation-0002", "profile": {"revision": 0, "item": {"settings": {"blob": "x" * 9000}}}}, headers=headers())
    assert huge.status_code == 422 and "limit" in huge.json()["detail"]
    ok = api.put("/api/desktop/v1/games/state", json={"mutation_id": "mutation-0003", "profile": {"revision": 0, "item": {"settings": {"blob": "x" * 3000}}}}, headers=headers())
    assert ok.status_code == 200


def test_a_full_day_record_fits_its_cap():
    """All 31 games on one day, one category each: the budget in spec 8.5/17.9 must hold."""
    item = {"games": {game_id: {"n": 12, "avg": 66.5, "best": 91} for game_id in sorted(games.GAME_IDS)}, "warmupDone": True, "minutes": 55,
            "categoryScores": {name: 71.25 for name in sorted(games.CATEGORIES)}, "expectancyR": 0.42, "discipline": 88.5}
    assert games._size(item) <= games.TYPE_CAPS["day"]


def test_authentication_is_required(api):
    assert api.get("/api/desktop/v1/games/state").status_code == 401
    assert api.put("/api/desktop/v1/games/state", json=game_body()).status_code == 401


# ----------------------------------------------------------------- TTL and the recent-days window


def test_day_records_carry_an_epoch_expiry_about_200_days_out_and_others_do_not(api, db):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    api.put("/api/desktop/v1/games/state", json={**game_body(), "day": {"date": today, "revision": 0, "item": {"minutes": 3}}, "month": {"month": today[:7], "revision": 0, "item": {"days": 1}}}, headers=headers())
    table = boto3.resource("dynamodb", region_name="us-east-1").Table(games.TABLE)
    items = {item["record_id"]: item for item in table.scan()["Items"]}
    assert set(items) == {f"day#{today}", f"month#{today[:7]}", "game#quick_match"}
    expires = int(items[f"day#{today}"]["expires_at"])
    assert abs(expires - (datetime.now(timezone.utc) + timedelta(days=200)).timestamp()) < 120
    assert "expires_at" not in items["game#quick_match"] and "expires_at" not in items[f"month#{today[:7]}"]
    assert db.describe_time_to_live(TableName=games.TABLE)["TimeToLiveDescription"]["AttributeName"] == "expires_at"


def test_get_state_returns_recent_days_but_all_games_months_and_profile(api):
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=10)).strftime("%Y-%m-%d")
    edge_out = (now - timedelta(days=45)).strftime("%Y-%m-%d")
    for index, date in enumerate((recent, edge_out)):
        api.put("/api/desktop/v1/games/state", json={"mutation_id": f"mutation-day{index}", "day": {"date": date, "revision": 0, "item": {"minutes": 1}}}, headers=headers())
    api.put("/api/desktop/v1/games/state", json={**game_body("mutation-game1"), "month": {"month": "2026-01", "revision": 0, "item": {"days": 3}}, "profile": {"revision": 0, "item": {"version": 1}}}, headers=headers())
    state = api.get("/api/desktop/v1/games/state", headers=headers()).json()
    assert list(state["days"]) == [recent]
    assert "quick_match" in state["games"] and "2026-01" in state["months"] and state["profile"]["version"] == 1


# ----------------------------------------------------------------- limiter, isolation from trading code


def test_token_bucket_burst_refill_and_per_user_limits():
    now = [0.0]
    bucket = TokenBucket(rate_per_second=2, burst=3, clock=lambda: now[0])
    assert [bucket.allow("a") for _ in range(4)] == [True, True, True, False]
    assert bucket.allow("b") is True
    now[0] = 0.5
    assert bucket.allow("a") is True and bucket.allow("a") is False
    assert bucket.retry_after("a") > 0


def test_token_bucket_bounds_its_memory():
    bucket = TokenBucket(1, 1, clock=lambda: 0.0, max_users=5)
    for index in range(50):
        bucket.allow(f"user{index}")
    assert len(bucket._state) <= 5


def test_rate_limited_requests_get_429(api, monkeypatch):
    monkeypatch.setattr(desktop_games, "_state_reads", TokenBucket(0.001, 2))
    statuses = [api.get("/api/desktop/v1/games/state", headers=headers()).status_code for _ in range(3)]
    assert statuses == [200, 200, 429]
    assert api.get("/api/desktop/v1/games/state", headers=headers()).headers["retry-after"]


def test_games_modules_import_no_trading_code():
    forbidden = re.compile(r"^\s*(?:from|import)\s+app\.(?:services\.(?:order|trading|session|simulation|kotak|breeze|kite|fyers|broker|execution|guardrail|strateg|wallet|real_)\w*|routers\.(?:orders|trading|simulation|kotak|breeze|execution_brokers|guardrails|strategies|wallet))", re.M)
    root = Path(__file__).resolve().parents[1] / "app"
    for relative in ("services/games_persistence_service.py", "services/games_rate_limit.py", "routers/desktop_games.py"):
        assert not forbidden.search((root / relative).read_text()), relative
