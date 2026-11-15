"""DynamoDB persistence for Games progress (Phase 25, sprint G2).

One small table, ``GameProfiles`` (partition ``user_id``, sort ``record_id``), keeps compact
per-user progress only: never rounds, answers, market windows or trial logs.

Records (sort keys sort as ``day# < game# < month# < profile``, which lets one range query
fetch the recent days, every game, every month and the profile together):

* ``profile``            settings and counters
* ``game#<gameId>``      level, counters, last scores, small stats
* ``day#YYYY-MM-DD``     per-day totals; carries ``expires_at`` (epoch seconds, TTL)
* ``month#YYYY-MM``      monthly rollup, no TTL

Writes are one DynamoDB transaction per completed session. Every record carries a
``revision`` (optimistic concurrency) and ``last_mutation_id`` (idempotent retries).
This module never touches orders, sessions, brokers or market data.
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from boto3.dynamodb.types import TypeSerializer
from botocore.exceptions import ClientError

TABLE = "GameProfiles"
DAY_TTL_DAYS = 200
RECENT_DAYS = 30

MARKET_GAMES = (
    "tick_reader", "entry_sniper", "exit_discipline", "risk_calculator", "hotkey_drill",
    "level_recall", "regime_switch", "strike_picker", "spot_the_trap", "no_trade_day",
)
BRAIN_GAMES = (
    "quick_match", "colour_clash", "green_light", "grid_recall", "sequence_echo", "n_back_stream",
    "flanker_flock", "needle_finder", "track_the_dots", "rule_switch", "card_sorter", "flip_map",
    "number_sprint", "equation_drop", "make_target", "pattern_matrix", "number_series", "code_breaker",
    "anagram_dash", "letter_grid", "word_ladder",
)
GAME_IDS = frozenset(MARKET_GAMES + BRAIN_GAMES)
CATEGORIES = frozenset({"speed", "memory", "attention", "flexibility", "math", "reasoning", "discipline", "word"})

# Size caps in bytes of the compact JSON form (spec 8.5, 17.9). Anything above MAX_ITEM_BYTES is
# rejected outright; the per-type caps are the budgeted sizes.
MAX_ITEM_BYTES = 8 * 1024
TYPE_CAPS = {"profile": 4 * 1024, "game": 3 * 1024, "day": 2560, "month": 3 * 1024}

_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
_KEY_RE = re.compile(r"^[a-z0-9_]{1,40}$")

_ENSURED = False
_serialize = TypeSerializer().serialize


class ValidationFailed(ValueError):
    """The request body is not acceptable (HTTP 422)."""


class RevisionConflict(Exception):
    """A record changed since the client read it (HTTP 409); carries the current records."""

    def __init__(self, current: dict[str, dict | None]):
        super().__init__("revision_conflict")
        self.current = current


# ---------------------------------------------------------------- table


def ensure_table() -> None:
    """Create the table lazily (as the other desktop tables do) and switch its TTL on."""
    global _ENSURED
    if _ENSURED:
        return
    from app.services.db import get_dynamodb_client
    client = get_dynamodb_client()
    existing = set(client.list_tables()["TableNames"])
    if TABLE not in existing:
        client.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}, {"AttributeName": "record_id", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"}, {"AttributeName": "record_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
    try:
        client.update_time_to_live(TableName=TABLE, TimeToLiveSpecification={"Enabled": True, "AttributeName": "expires_at"})
    except ClientError:
        # Already enabled, or the endpoint (DynamoDB Local) does not support it. Not fatal: expiry is a
        # storage-hygiene feature, never a correctness one.
        pass
    _ENSURED = True


def _table():
    ensure_table()
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(TABLE)


# ---------------------------------------------------------------- validation


def _is_number(value) -> bool:
    return isinstance(value, (int, float, Decimal)) and not isinstance(value, bool)


def _size(item: dict) -> int:
    return len(json.dumps(item, separators=(",", ":"), default=str).encode("utf-8"))


def _check_fields(item: dict, allowed: set[str], where: str) -> None:
    unknown = set(item) - allowed
    if unknown:
        raise ValidationFailed(f"{where}: unknown field(s) {sorted(unknown)}")


def _int_in(value, lo: int, hi: int, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise ValidationFailed(f"{name} must be an integer {lo}..{hi}")
    return value


def _num_in(value, lo: float, hi: float, name: str):
    if not _is_number(value) or not lo <= float(value) <= hi:
        raise ValidationFailed(f"{name} must be a number {lo}..{hi}")
    return value


def _numeric_map(value, name: str, max_keys: int, key_ok) -> dict:
    if not isinstance(value, dict) or len(value) > max_keys:
        raise ValidationFailed(f"{name} must be an object with at most {max_keys} keys")
    for key, number in value.items():
        if not isinstance(key, str) or not key_ok(key):
            raise ValidationFailed(f"{name}: bad key {key!r}")
        if not _is_number(number) or abs(float(number)) > 1e9:
            raise ValidationFailed(f"{name}.{key} must be a number")
    return value


def validate_game_item(game_id: str, item: dict) -> dict:
    if game_id not in GAME_IDS:
        raise ValidationFailed(f"unknown game id {game_id!r}")
    allowed = {"level", "consecutiveHigh", "consecutiveLow", "sessions", "practice", "best", "emaScore", "lastScores", "stats", "lastPlayed"}
    _check_fields(item, allowed, "game")
    out = dict(item)
    if "level" in item:
        _int_in(item["level"], 1, 20, "level")
    for name in ("consecutiveHigh", "consecutiveLow"):
        if name in item:
            _int_in(item[name], 0, 1000, name)
    for name in ("sessions", "practice"):
        if name in item:
            _int_in(item[name], 0, 10_000_000, name)
    if "best" in item:
        _num_in(item["best"], 0, 100, "best")
    if "emaScore" in item:
        _num_in(item["emaScore"], 0, 100, "emaScore")
    if "lastScores" in item:
        scores = item["lastScores"]
        if not isinstance(scores, list) or len(scores) > 20:
            raise ValidationFailed("lastScores must be a list of at most 20 integers")
        for score in scores:
            _int_in(score, 0, 100, "lastScores entry")
    if "stats" in item:
        _numeric_map(item["stats"], "stats", 20, lambda key: bool(_KEY_RE.match(key)))
    if "lastPlayed" in item and (not isinstance(item["lastPlayed"], str) or len(item["lastPlayed"]) > 32):
        raise ValidationFailed("lastPlayed must be a short string")
    return out


def _validate_totals(item: dict, where: str) -> dict:
    """Shared shape of day and month records."""
    allowed = {"games", "warmupDone", "minutes", "categoryScores", "expectancyR", "discipline", "days"}
    _check_fields(item, allowed, where)
    if "games" in item:
        games = item["games"]
        if not isinstance(games, dict) or len(games) > len(GAME_IDS):
            raise ValidationFailed(f"{where}.games must be an object keyed by game id")
        for game_id, entry in games.items():
            if game_id not in GAME_IDS:
                raise ValidationFailed(f"{where}.games: unknown game id {game_id!r}")
            if not isinstance(entry, dict):
                raise ValidationFailed(f"{where}.games.{game_id} must be an object")
            _check_fields(entry, {"n", "avg", "best"}, f"{where}.games.{game_id}")
            if "n" in entry:
                _int_in(entry["n"], 0, 1_000_000, "n")
            for name in ("avg", "best"):
                if name in entry:
                    _num_in(entry[name], 0, 100, name)
    if "warmupDone" in item and not isinstance(item["warmupDone"], (bool, int)):
        raise ValidationFailed(f"{where}.warmupDone must be a boolean or a count")
    if "minutes" in item:
        _num_in(item["minutes"], 0, 24 * 60 * 31, "minutes")
    if "days" in item:
        _int_in(item["days"], 0, 31, "days")
    if "categoryScores" in item:
        _numeric_map(item["categoryScores"], "categoryScores", len(CATEGORIES), lambda key: key in CATEGORIES)
    for name in ("expectancyR", "discipline"):
        if name in item:
            _num_in(item[name], -1000, 1000, name)
    return dict(item)


def validate_profile_item(item: dict) -> dict:
    _check_fields(item, {"settings", "createdAt", "version"}, "profile")
    if "settings" in item and not isinstance(item["settings"], dict):
        raise ValidationFailed("profile.settings must be an object")
    if "createdAt" in item and (not isinstance(item["createdAt"], str) or len(item["createdAt"]) > 40):
        raise ValidationFailed("profile.createdAt must be a short string")
    if "version" in item:
        _int_in(item["version"], 1, 1000, "version")
    return dict(item)


def _check_size(kind: str, record_id: str, item: dict) -> None:
    size = _size(item)
    if size > MAX_ITEM_BYTES:
        raise ValidationFailed(f"{record_id}: item is {size} bytes, over the {MAX_ITEM_BYTES} byte limit")
    if size > TYPE_CAPS[kind]:
        raise ValidationFailed(f"{record_id}: item is {size} bytes, over the {TYPE_CAPS[kind]} byte cap for a {kind} record")


# ---------------------------------------------------------------- helpers


def _plain(value):
    """Decimal -> int/float so FastAPI returns ordinary JSON numbers."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    if isinstance(value, set):
        return sorted(_plain(item) for item in value)
    return value


def _dynamo(value):
    """Floats become Decimal (DynamoDB rejects float)."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _dynamo(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dynamo(item) for item in value]
    return value


def _public(item: dict | None) -> dict | None:
    if item is None:
        return None
    hidden = {"user_id", "record_id", "expires_at"}
    return _plain({key: value for key, value in item.items() if key not in hidden})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def day_expiry(now: datetime | None = None) -> int:
    """Epoch seconds when a day record may be removed: DAY_TTL_DAYS after it was written."""
    return int(((now or _now()) + timedelta(days=DAY_TTL_DAYS)).timestamp())


# ---------------------------------------------------------------- reads


def get_state(user_id: str, today: datetime | None = None) -> dict:
    """One DynamoDB range query: recent days, every game, every month, and the profile."""
    from boto3.dynamodb.conditions import Key
    cutoff = ((today or _now()) - timedelta(days=RECENT_DAYS)).strftime("%Y-%m-%d")
    condition = Key("user_id").eq(user_id) & Key("record_id").between(f"day#{cutoff}", "profile")
    table = _table()
    items: list[dict] = []
    kwargs = {"KeyConditionExpression": condition, "ConsistentRead": True}
    while True:
        response = table.query(**kwargs)
        items.extend(response.get("Items", []))
        if "LastEvaluatedKey" not in response:
            break
        kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]
    state = {"version": 1, "profile": None, "games": {}, "days": {}, "months": {}}
    for item in items:
        record_id = item["record_id"]
        if record_id == "profile":
            state["profile"] = _public(item)
        elif record_id.startswith("game#"):
            state["games"][record_id[5:]] = _public(item)
        elif record_id.startswith("day#"):
            state["days"][record_id[4:]] = _public(item)
        elif record_id.startswith("month#"):
            state["months"][record_id[6:]] = _public(item)
    return state


def _current(user_id: str, record_ids: list[str]) -> dict[str, dict | None]:
    table = _table()
    out: dict[str, dict | None] = {}
    for record_id in record_ids:
        out[record_id] = _public(table.get_item(Key={"user_id": user_id, "record_id": record_id}, ConsistentRead=True).get("Item"))
    return out


# ---------------------------------------------------------------- writes


def _build_writes(body: dict) -> list[dict]:
    """Validate the PUT body and return a list of {record_id, kind, revision, item}."""
    allowed = {"mutation_id", "game", "day", "month", "profile"}
    _check_fields(body, allowed, "state")
    mutation_id = body.get("mutation_id")
    if not isinstance(mutation_id, str) or not 8 <= len(mutation_id) <= 64:
        raise ValidationFailed("mutation_id (8-64 characters) is required")
    writes: list[dict] = []
    if "game" in body:
        game = body["game"]
        if not isinstance(game, dict):
            raise ValidationFailed("game must be an object")
        _check_fields(game, {"id", "revision", "item"}, "game")
        item = validate_game_item(str(game.get("id")), game.get("item") or {})
        writes.append({"record_id": f"game#{game['id']}", "kind": "game", "revision": game.get("revision"), "item": item})
    for kind, regex, label in (("day", _DAY_RE, "date"), ("month", _MONTH_RE, "month")):
        if kind in body:
            entry = body[kind]
            if not isinstance(entry, dict):
                raise ValidationFailed(f"{kind} must be an object")
            _check_fields(entry, {label, "revision", "item"}, kind)
            key = entry.get(label)
            if not isinstance(key, str) or not regex.match(key):
                raise ValidationFailed(f"{kind}.{label} is required and must look like {'YYYY-MM-DD' if kind == 'day' else 'YYYY-MM'}")
            if kind == "day":
                try:
                    datetime.strptime(key, "%Y-%m-%d")
                except ValueError as error:
                    raise ValidationFailed("day.date is not a real date") from error
            writes.append({"record_id": f"{kind}#{key}", "kind": kind, "revision": entry.get("revision"), "item": _validate_totals(entry.get("item") or {}, kind)})
    if "profile" in body:
        profile = body["profile"]
        if not isinstance(profile, dict):
            raise ValidationFailed("profile must be an object")
        _check_fields(profile, {"revision", "item"}, "profile")
        writes.append({"record_id": "profile", "kind": "profile", "revision": profile.get("revision"), "item": validate_profile_item(profile.get("item") or {})})
    if not writes:
        raise ValidationFailed("nothing to write: send game, day, month or profile")
    for write in writes:
        revision = write["revision"]
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ValidationFailed(f"{write['record_id']}: revision must be an integer >= 0 (0 when the record is new)")
        _check_size(write["kind"], write["record_id"], write["item"])
    return writes


def put_state(user_id: str, body: dict, now: datetime | None = None) -> dict:
    """Apply one session's progress atomically. Idempotent per ``mutation_id``.

    Raises ``ValidationFailed`` (422) or ``RevisionConflict`` (409, with the current records).
    """
    writes = _build_writes(body)
    mutation_id = body["mutation_id"]
    record_ids = [write["record_id"] for write in writes]
    table = _table()

    # Idempotent retry: every target already carries this mutation, so the earlier attempt won.
    existing = {rid: table.get_item(Key={"user_id": user_id, "record_id": rid}, ConsistentRead=True).get("Item") for rid in record_ids}
    if all(item is not None and item.get("last_mutation_id") == mutation_id for item in existing.values()):
        return {"version": 1, "applied": False, "records": {rid: _public(item) for rid, item in existing.items()}}

    stamp = (now or _now())
    actions = []
    new_items: dict[str, dict] = {}
    for write in writes:
        revision = write["revision"]
        item = {
            **_dynamo(write["item"]),
            "user_id": user_id,
            "record_id": write["record_id"],
            "revision": revision + 1,
            "last_mutation_id": mutation_id,
            "updated_at": stamp.isoformat(),
        }
        if write["kind"] == "day":
            item["expires_at"] = day_expiry(stamp)
        new_items[write["record_id"]] = item
        condition = {"ConditionExpression": "attribute_not_exists(user_id)"} if revision == 0 else {
            "ConditionExpression": "revision = :expected",
            "ExpressionAttributeValues": {":expected": _serialize(revision)},
        }
        actions.append({"Put": {"TableName": TABLE, "Item": {key: _serialize(value) for key, value in item.items()}, **condition}})

    from app.services.db import get_dynamodb_client
    try:
        get_dynamodb_client().transact_write_items(TransactItems=actions)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        if code in {"TransactionCanceledException", "ConditionalCheckFailedException"}:
            raise RevisionConflict(_current(user_id, record_ids)) from error
        raise
    return {"version": 1, "applied": True, "records": {rid: _public(item) for rid, item in new_items.items()}}
