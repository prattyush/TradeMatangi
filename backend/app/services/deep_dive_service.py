"""
Deep Dive service — Patterns Strategy Deep Dive (Phase 26).

A deep dive studies one strategy (category + strategy): the user marks the days the setup
occurred (Buy, Sell or both), then marks per day which of the user's TAGS are valid or not
valid ("second leg", "reversed by double top") and flags the day a success or a failure.
The marks give frequency percentages ("breakouts have a second leg 70% of the time").

Tables (lazy ``ensure_*``, also in scripts/setup-dynamodb-tables.py)
  DeepDiveSetups    PK user_id, SK "<category>::<strategy>#<date>#<symbol>#<side>"
                    one item per marked day and side; ``tag_values`` is a map tag_id -> bool
                    (True valid, False not valid, an absent key is UNMARKED), ``annotations``
                    is the chart marks as JSON
  DeepDiveTags      PK user_id, SK "<category>::<strategy>#<tag_id>"
                    never deleted, only archived / restored (the marks survive)

A dive has no table of its own: it exists while it has setups or tags. Reads may name
an ``owner_id`` that shared patterns with the caller (read-only); writes are always the caller's.
"""
from __future__ import annotations

import copy
import json
import logging
import time
import uuid
from datetime import date as calendar_date, datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

SETUPS_TABLE = "DeepDiveSetups"
TAGS_TABLE = "DeepDiveTags"
SIDES = ("buy", "sell")
OUTCOMES = ("success", "failed")
STRIKE_MODES = ("max_price", "otm", "manual")
MAX_NAME_LENGTH = 60
MAX_TAG_LENGTH = 140
MAX_ACTIVE_TAGS = 40
MAX_ANNOTATIONS = 200
MAX_NOTES_LENGTH = 2000
FEW_DAYS = 5  # fewer marked days than this and a percentage is flagged as thin

_SETUPS_ENSURED = False
_TAGS_ENSURED = False

# The label forms and live popups ask for the percentages of every deep dive each time they open. That reads all of a user's
# marked days, so the answer is kept for a few seconds per process and dropped by every write made here. Another process (or a
# viewer of a shared deep dive) sees a change within the TTL at most.
STATS_ALL_TTL_SECONDS = 20.0
_stats_cache: dict[str, tuple[float, list[dict]]] = {}


def _changed() -> None:
    _stats_cache.clear()


# ── Tables ───────────────────────────────────────────────────────────────────

def _resource():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource()


def _create_if_missing(name: str) -> None:
    from app.services.db import get_dynamodb_client
    if name in set(_resource().meta.client.list_tables()["TableNames"]):
        return
    sort_key = "setup_key" if name == SETUPS_TABLE else "tag_key"
    client = get_dynamodb_client()
    client.create_table(
        TableName=name, BillingMode="PAY_PER_REQUEST",
        KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}, {"AttributeName": sort_key, "KeyType": "RANGE"}],
        AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"},
                              {"AttributeName": sort_key, "AttributeType": "S"}],
    )
    client.get_waiter("table_exists").wait(TableName=name)
    logger.info("Created %s table", name)


def ensure_setups_table() -> None:
    global _SETUPS_ENSURED
    if _SETUPS_ENSURED:
        return
    try:
        _create_if_missing(SETUPS_TABLE)
        _SETUPS_ENSURED = True
    except Exception:
        logger.exception("Failed to ensure %s table", SETUPS_TABLE)


def ensure_tags_table() -> None:
    global _TAGS_ENSURED
    if _TAGS_ENSURED:
        return
    try:
        _create_if_missing(TAGS_TABLE)
        _TAGS_ENSURED = True
    except Exception:
        logger.exception("Failed to ensure %s table", TAGS_TABLE)


def _setups():
    ensure_setups_table()
    return _resource().Table(SETUPS_TABLE)


def _tags():
    ensure_tags_table()
    return _resource().Table(TAGS_TABLE)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _query_prefix(table, sort_key: str, user_id: str, prefix: str | None = None) -> list[dict]:
    from boto3.dynamodb.conditions import Key
    condition = Key("user_id").eq(user_id)
    if prefix is not None:
        condition = condition & Key(sort_key).begins_with(prefix)
    items: list[dict] = []
    params = {"KeyConditionExpression": condition, "ConsistentRead": True}
    while True:
        page = table.query(**params)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


# ── Keys and validation ──────────────────────────────────────────────────────

def _name(value: str, label: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        raise ValueError(f"{label} must not be empty")
    if len(cleaned) > MAX_NAME_LENGTH:
        raise ValueError(f"{label} must be at most {MAX_NAME_LENGTH} characters")
    if "::" in cleaned or "#" in cleaned:
        # "::" joins category and strategy; "#" separates the rest of a sort key.
        raise ValueError(f"{label} must not contain '::' or '#'")
    return cleaned


def dive_key(category: str, strategy: str) -> str:
    return f"{_name(category, 'Category')}::{_name(strategy, 'Strategy')}"


def _side(side: str) -> str:
    if side not in SIDES:
        raise ValueError("Side must be 'buy' or 'sell'")
    return side


def _trading_date(value: str) -> str:
    from app.utils import is_trading_day
    try:
        day = calendar_date.fromisoformat(value)
    except (TypeError, ValueError):
        raise ValueError("Date must be YYYY-MM-DD") from None
    if not is_trading_day(day):
        raise ValueError("The selected date is not a trading day")
    # Same rule as the calendar: only completed days (before today in India), so a day's candles are all there.
    if day >= datetime.now(ZoneInfo("Asia/Kolkata")).date():
        raise ValueError("A deep dive day must be before today")
    return day.isoformat()


def _symbol(value: str) -> str:
    from app.config import SUPPORTED_SYMBOLS
    if value not in SUPPORTED_SYMBOLS:
        raise ValueError("Unsupported symbol")
    return value


def _setup_key(key: str, date: str, symbol: str, side: str) -> str:
    return f"{key}#{date}#{symbol}#{side}"


def _int_or_none(value) -> Optional[int]:
    return None if value is None else int(value)


def _clean_tag_name(name: str) -> str:
    cleaned = " ".join((name or "").split())
    if not cleaned:
        raise ValueError("Tag name must not be empty")
    if len(cleaned) > MAX_TAG_LENGTH:
        raise ValueError(f"Tag name must be at most {MAX_TAG_LENGTH} characters")
    return cleaned


def _register_names(user_id: str, category: str, strategy: str) -> None:
    """Put the category and strategy in the shared name registry. A convenience: never fails a write."""
    try:
        from app.services import pattern_logger_service as patterns
        patterns.add_name(user_id, "category", category)
        patterns.add_name(user_id, "strategy", strategy)
    except Exception:
        logger.exception("Could not register deep dive names for %s", user_id)


def _resolve_owner(user_id: str, owner_id: Optional[str]) -> str:
    """Whose data a read is about: the caller's, or an owner who shared patterns with the caller."""
    if not owner_id or owner_id == user_id:
        return user_id
    from app.services import pattern_logger_service as patterns
    if owner_id not in patterns.get_accessible_owner_ids(user_id):
        raise LookupError("Deep dive not found")
    return owner_id


# ── Tags ────────────────────────────────────────────────────────────────

def _serialize_tag(row: dict) -> dict:
    return {
        "tag_id": row["tag_id"],
        "name": row["name"],
        "status": row.get("status", "active"),
        "sort_order": int(row.get("sort_order", 0)),
        "created_at": row.get("created_at", ""),
        "archived_at": row.get("archived_at") or None,
    }


def _tag_rows(owner_id: str, key: str) -> list[dict]:
    rows = _query_prefix(_tags(), "tag_key", owner_id, f"{key}#")
    return sorted((_serialize_tag(r) for r in rows), key=lambda r: (r["sort_order"], r["created_at"]))


def list_tags(user_id: str, category: str, strategy: str, owner_id: Optional[str] = None,
              include_archived: bool = True) -> list[dict]:
    rows = _tag_rows(_resolve_owner(user_id, owner_id), dive_key(category, strategy))
    return rows if include_archived else [r for r in rows if r["status"] == "active"]


def _get_tag(user_id: str, key: str, tag_id: str) -> dict:
    row = _tags().get_item(Key={"user_id": user_id, "tag_key": f"{key}#{tag_id}"}, ConsistentRead=True).get("Item")
    if not row:
        raise LookupError("Tag not found")
    return _serialize_tag(row)


def _duplicate_active(rows: list[dict], name: str, exclude_id: Optional[str] = None) -> bool:
    folded = name.casefold()
    return any(r["status"] == "active" and r["tag_id"] != exclude_id and r["name"].casefold() == folded
               for r in rows)


def add_tag(user_id: str, category: str, strategy: str, name: str) -> dict:
    key = dive_key(category, strategy)
    cleaned = _clean_tag_name(name)
    rows = _tag_rows(user_id, key)
    if len([r for r in rows if r["status"] == "active"]) >= MAX_ACTIVE_TAGS:
        raise ValueError(f"At most {MAX_ACTIVE_TAGS} active tags are allowed; archive one first")
    if _duplicate_active(rows, cleaned):
        raise ValueError("An active tag with this name already exists")
    tag_id = uuid.uuid4().hex
    item = {
        "user_id": user_id,
        "tag_key": f"{key}#{tag_id}",
        "tag_id": tag_id,
        "category": category.strip(),
        "strategy": strategy.strip(),
        "name": cleaned,
        "status": "active",
        "sort_order": max([r["sort_order"] for r in rows], default=-1) + 1,
        "created_at": _now(),
    }
    _tags().put_item(Item=item)
    _changed()
    _register_names(user_id, item["category"], item["strategy"])
    return _serialize_tag(item)


def update_tag(user_id: str, category: str, strategy: str, tag_id: str, name: str) -> dict:
    key = dive_key(category, strategy)
    current = _get_tag(user_id, key, tag_id)
    cleaned = _clean_tag_name(name)
    if current["status"] == "active" and _duplicate_active(_tag_rows(user_id, key), cleaned, tag_id):
        raise ValueError("An active tag with this name already exists")
    _tags().update_item(
        Key={"user_id": user_id, "tag_key": f"{key}#{tag_id}"},
        UpdateExpression="SET #t = :t",
        ExpressionAttributeNames={"#t": "name"},
        ExpressionAttributeValues={":t": cleaned},
    )
    _changed()
    return {**current, "name": cleaned}


def archive_tag(user_id: str, category: str, strategy: str, tag_id: str) -> dict:
    key = dive_key(category, strategy)
    current = _get_tag(user_id, key, tag_id)
    if current["status"] == "archived":
        return current
    archived_at = _now()
    _tags().update_item(
        Key={"user_id": user_id, "tag_key": f"{key}#{tag_id}"},
        UpdateExpression="SET #s = :s, archived_at = :a",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "archived", ":a": archived_at},
    )
    _changed()
    return {**current, "status": "archived", "archived_at": archived_at}


def restore_tag(user_id: str, category: str, strategy: str, tag_id: str) -> dict:
    key = dive_key(category, strategy)
    current = _get_tag(user_id, key, tag_id)
    if current["status"] == "active":
        return current
    rows = _tag_rows(user_id, key)
    if len([r for r in rows if r["status"] == "active"]) >= MAX_ACTIVE_TAGS:
        raise ValueError(f"At most {MAX_ACTIVE_TAGS} active tags are allowed; archive one first")
    if _duplicate_active(rows, current["name"], tag_id):
        raise ValueError("An active tag with this name already exists")
    _tags().update_item(
        Key={"user_id": user_id, "tag_key": f"{key}#{tag_id}"},
        UpdateExpression="SET #s = :s REMOVE archived_at",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "active"},
    )
    _changed()
    return {**current, "status": "active", "archived_at": None}


# ── Setups ───────────────────────────────────────────────────────────────────

def _serialize_setup(row: dict) -> dict:
    raw = row.get("annotations", "[]")
    return {
        "category": row["category"],
        "strategy": row["strategy"],
        "symbol": row["symbol"],
        "date": row["date"],
        "side": row["side"],
        "strike_ce": _int_or_none(row.get("strike_ce")),
        "strike_pe": _int_or_none(row.get("strike_pe")),
        "strike_mode": row.get("strike_mode") or None,
        "interval_minutes": int(row.get("interval_minutes", 3)),
        "annotations": json.loads(raw) if isinstance(raw, str) else (raw or []),
        "outcome": row.get("outcome") or None,
        "tag_values": {qid: bool(value) for qid, value in (row.get("tag_values") or {}).items()},
        "notes": row.get("notes", ""),
        "created_at": row.get("created_at", ""),
        "updated_at": row.get("updated_at", ""),
    }


def _order(setups: list[dict]) -> list[dict]:
    return sorted(setups, key=lambda s: (s["date"], SIDES.index(s["side"]), s["symbol"]))


def _get_setup_row(user_id: str, key: str, date: str, symbol: str, side: str) -> dict:
    row = _setups().get_item(Key={"user_id": user_id, "setup_key": _setup_key(key, date, symbol, side)},
                             ConsistentRead=True).get("Item")
    if not row:
        raise LookupError("This day is not marked in the deep dive")
    return row


def _clean_annotations(annotations: list[dict], category: str, strategy: str) -> list[dict]:
    if len(annotations) > MAX_ANNOTATIONS:
        raise ValueError(f"At most {MAX_ANNOTATIONS} marks are allowed on one day")
    # A deep dive is about one strategy: every mark carries it, whatever the client sent.
    return [{**a, "category": category, "strategy_name": strategy} for a in annotations]


def upsert_setup(user_id: str, category: str, strategy: str, symbol: str, date: str, side: str, fields: dict) -> dict:
    """Create the marked day or change the given fields of it. ``fields`` holds only what the caller sent."""
    key = dive_key(category, strategy)
    category, strategy = category.strip(), strategy.strip()
    date, symbol, side = _trading_date(date), _symbol(symbol), _side(side)
    sets = {"category": category, "strategy": strategy, "symbol": symbol, "date": date, "side": side}
    removes: list[str] = []

    for field in ("strike_ce", "strike_pe"):
        if field in fields:
            value = fields[field]
            if value is None:
                removes.append(field)
            elif int(value) <= 0:
                raise ValueError("A strike must be positive")
            else:
                sets[field] = int(value)
    if "strike_mode" in fields:
        mode = fields["strike_mode"]
        if mode is None:
            removes.append("strike_mode")
        elif mode in STRIKE_MODES:
            sets["strike_mode"] = mode
        else:
            raise ValueError("Unknown strike mode")
    if fields.get("interval_minutes") is not None:
        interval = int(fields["interval_minutes"])
        if not 1 <= interval <= 60:
            raise ValueError("Interval must be between 1 and 60 minutes")
        sets["interval_minutes"] = interval
    if "outcome" in fields:
        outcome = fields["outcome"]
        if outcome is None:
            removes.append("outcome")
        elif outcome in OUTCOMES:
            sets["outcome"] = outcome
        else:
            raise ValueError("Outcome must be 'success' or 'failed'")
    if "notes" in fields:
        notes = fields["notes"] or ""
        if len(notes) > MAX_NOTES_LENGTH:
            raise ValueError(f"Notes must be at most {MAX_NOTES_LENGTH} characters")
        sets["notes"] = notes
    if fields.get("annotations") is not None:
        sets["annotations"] = json.dumps(_clean_annotations(fields["annotations"], category, strategy))

    names, values, set_parts = {}, {":now": _now(), ":empty": {}}, []
    for index, (attribute, value) in enumerate(sets.items()):
        names[f"#a{index}"] = attribute
        values[f":v{index}"] = value
        set_parts.append(f"#a{index} = :v{index}")
    names.update({"#upd": "updated_at", "#cre": "created_at", "#ans": "tag_values"})
    set_parts += ["#upd = :now", "#cre = if_not_exists(#cre, :now)", "#ans = if_not_exists(#ans, :empty)"]
    if "interval_minutes" not in sets:  # a new day starts at 3 minutes; an existing one keeps its interval
        names["#int"] = "interval_minutes"
        values[":three"] = 3
        set_parts.append("#int = if_not_exists(#int, :three)")
    remove_parts = []
    for index, attribute in enumerate(removes):
        names[f"#r{index}"] = attribute
        remove_parts.append(f"#r{index}")
    expression = "SET " + ", ".join(set_parts) + (" REMOVE " + ", ".join(remove_parts) if remove_parts else "")
    row = _setups().update_item(
        Key={"user_id": user_id, "setup_key": _setup_key(key, date, symbol, side)},
        UpdateExpression=expression, ExpressionAttributeNames=names, ExpressionAttributeValues=values,
        ReturnValues="ALL_NEW",
    )["Attributes"]
    _changed()
    _register_names(user_id, category, strategy)
    return _serialize_setup(row)


def delete_setup(user_id: str, category: str, strategy: str, symbol: str, date: str, side: str) -> bool:
    """Un-mark one side of one day (its tag marks and chart marks go with it). False when it was not marked."""
    key = dive_key(category, strategy)
    result = _setups().delete_item(
        Key={"user_id": user_id, "setup_key": _setup_key(key, date, symbol, _side(side))}, ReturnValues="ALL_OLD")
    _changed()
    return bool(result.get("Attributes"))


def set_tag_values(user_id: str, category: str, strategy: str, symbol: str, date: str, side: str,
                   tag_values: dict[str, Optional[bool]]) -> dict:
    """Mark tags on one marked day: True valid, False not valid, None back to unmarked. Idempotent.

    Only active tags can be newly marked; an archived tag's mark can still be cleared or kept.
    """
    key = dive_key(category, strategy)
    side = _side(side)
    row = _get_setup_row(user_id, key, date, symbol, side)
    by_id = {q["tag_id"]: q for q in _tag_rows(user_id, key)}
    existing = row.get("tag_values") or {}
    for tag_id, mark in tag_values.items():
        if tag_id not in by_id:
            raise ValueError("Unknown deep dive tag")
        if mark is not None and tag_id not in existing and by_id[tag_id]["status"] != "active":
            raise ValueError("Archived tags cannot be newly marked")
    if not tag_values:
        return _serialize_setup(row)
    names = {"#upd": "updated_at", "#ans": "tag_values"}
    values = {":now": _now()}
    set_parts, remove_parts = ["#upd = :now"], []
    for index, (tag_id, mark) in enumerate(tag_values.items()):
        names[f"#t{index}"] = tag_id
        if mark is None:
            remove_parts.append(f"#ans.#t{index}")
        else:
            values[f":v{index}"] = bool(mark)
            set_parts.append(f"#ans.#t{index} = :v{index}")
    expression = "SET " + ", ".join(set_parts) + (" REMOVE " + ", ".join(remove_parts) if remove_parts else "")
    updated = _setups().update_item(
        Key={"user_id": user_id, "setup_key": row["setup_key"]},
        UpdateExpression=expression, ExpressionAttributeNames=names, ExpressionAttributeValues=values,
        ConditionExpression="attribute_exists(user_id)", ReturnValues="ALL_NEW",
    )["Attributes"]
    _changed()
    return _serialize_setup(updated)


def _setup_rows(owner_id: str, key: str) -> list[dict]:
    rows = _query_prefix(_setups(), "setup_key", owner_id, f"{key}#")
    return _order([_serialize_setup(r) for r in rows])


# ── Gaps and stats (pure) ────────────────────────────────────────────────────

def unmarked_tags(setup: dict, tags: list[dict]) -> list[str]:
    """Active tag ids this day has not marked (neither valid nor not valid), in tag order."""
    return [t["tag_id"] for t in tags if t["status"] == "active" and t["tag_id"] not in setup["tag_values"]]


def annotate_gaps(setups: list[dict], tags: list[dict]) -> list[dict]:
    result = []
    for setup in setups:
        missing = unmarked_tags(setup, tags)
        result.append({**setup, "missing": missing, "complete": not missing})
    return result


def compute_stats(setups: list[dict], tags: list[dict], side: Optional[str] = None) -> dict:
    """Frequency percentages for one dive, optionally one side.

    A tag's percentage is valid / days where THAT tag was marked (``marked`` is shown as n; unmarked days do not
    count). Success rate is over days with an outcome. Anything under FEW_DAYS is flagged ``few_days``.
    """
    days = [s for s in setups if side is None or s["side"] == side]
    rows = []
    for tag in tags:
        if tag["status"] != "active":
            continue
        marks = [s["tag_values"][tag["tag_id"]] for s in days if tag["tag_id"] in s["tag_values"]]
        valid = sum(1 for m in marks if m)
        rows.append({
            "tag_id": tag["tag_id"], "name": tag["name"],
            "valid": valid, "not_valid": len(marks) - valid, "marked": len(marks),
            "pct": round(100 * valid / len(marks), 1) if marks else None,
            "few_days": len(marks) < FEW_DAYS,
        })
    with_outcome = [s for s in days if s["outcome"]]
    success = sum(1 for s in with_outcome if s["outcome"] == "success")
    return {
        "days": len(days),
        "buy_days": sum(1 for s in days if s["side"] == "buy"),
        "sell_days": sum(1 for s in days if s["side"] == "sell"),
        "tags": rows,
        "success": success, "failed": len(with_outcome) - success, "with_outcome": len(with_outcome),
        "success_pct": round(100 * success / len(with_outcome), 1) if with_outcome else None,
        "outcome_few_days": len(with_outcome) < FEW_DAYS,
    }


# ── Reads ────────────────────────────────────────────────────────────────────

def get_dive(user_id: str, category: str, strategy: str, owner_id: Optional[str] = None) -> dict:
    owner = _resolve_owner(user_id, owner_id)
    key = dive_key(category, strategy)
    tags = _tag_rows(owner, key)
    setups = annotate_gaps(_setup_rows(owner, key), tags)
    return {
        "owner_id": owner, "can_edit": owner == user_id,
        "category": category.strip(), "strategy": strategy.strip(),
        "setups": setups, "tags": tags,
        "incomplete_days": sum(1 for s in setups if not s["complete"]),
        "unmarked_total": sum(len(s["missing"]) for s in setups),
    }


def _owner_dives(owner_id: str) -> dict[str, dict]:
    """Every dive of one owner keyed by ``category::strategy``: its setups and tags."""
    dives: dict[str, dict] = {}
    for row in _query_prefix(_setups(), "setup_key", owner_id):
        setup = _serialize_setup(row)
        entry = dives.setdefault(f"{setup['category']}::{setup['strategy']}", {"setups": [], "tags": []})
        entry["setups"].append(setup)
    for row in _query_prefix(_tags(), "tag_key", owner_id):
        entry = dives.setdefault(f"{row['category']}::{row['strategy']}", {"setups": [], "tags": []})
        entry["tags"].append(_serialize_tag(row))
    for entry in dives.values():
        entry["setups"] = _order(entry["setups"])
        entry["tags"].sort(key=lambda t: (t["sort_order"], t["created_at"]))
    return dives


def _accessible_owners(user_id: str) -> list[str]:
    from app.services import pattern_logger_service as patterns
    return patterns.get_accessible_owner_ids(user_id)  # the caller first


def list_dives(user_id: str) -> list[dict]:
    result = []
    for owner in _accessible_owners(user_id):
        for key, entry in _owner_dives(owner).items():
            category, strategy = key.split("::", 1)
            setups = annotate_gaps(entry["setups"], entry["tags"])
            result.append({
                "owner_id": owner, "can_edit": owner == user_id, "category": category, "strategy": strategy,
                "days": len(setups),
                "buy_days": sum(1 for s in setups if s["side"] == "buy"),
                "sell_days": sum(1 for s in setups if s["side"] == "sell"),
                "tags": sum(1 for t in entry["tags"] if t["status"] == "active"),
                "incomplete_days": sum(1 for s in setups if not s["complete"]),
            })
    return sorted(result, key=lambda d: (not d["can_edit"], d["category"].casefold(), d["strategy"].casefold()))


def stats(user_id: str, category: str, strategy: str, side: Optional[str] = None,
          owner_id: Optional[str] = None) -> dict:
    if side is not None:
        _side(side)
    owner = _resolve_owner(user_id, owner_id)
    key = dive_key(category, strategy)
    return {"owner_id": owner, "can_edit": owner == user_id, "category": category.strip(),
            "strategy": strategy.strip(), "side": side,
            **compute_stats(_setup_rows(owner, key), _tag_rows(owner, key), side)}


def stats_all(user_id: str) -> list[dict]:
    """Stats of every strategy that has marked days, for the label forms.

    One entry per category + strategy: the caller's own dive wins; otherwise the first owner who shared with
    them. Each entry carries ``all``, ``buy`` and ``sell`` blocks so the form can switch side without a request.
    """
    cached = _stats_cache.get(user_id)
    if cached and cached[0] > time.monotonic():
        return copy.deepcopy(cached[1])
    result = _stats_all_uncached(user_id)
    _stats_cache[user_id] = (time.monotonic() + STATS_ALL_TTL_SECONDS, result)
    return copy.deepcopy(result)


def _stats_all_uncached(user_id: str) -> list[dict]:
    chosen: dict[str, dict] = {}
    for owner in _accessible_owners(user_id):
        for key, entry in _owner_dives(owner).items():
            if key in chosen or not entry["setups"]:
                continue
            category, strategy = key.split("::", 1)
            chosen[key] = {
                "owner_id": owner, "shared": owner != user_id, "category": category, "strategy": strategy,
                "all": compute_stats(entry["setups"], entry["tags"]),
                "buy": compute_stats(entry["setups"], entry["tags"], "buy"),
                "sell": compute_stats(entry["setups"], entry["tags"], "sell"),
            }
    return sorted(chosen.values(), key=lambda d: (d["category"].casefold(), d["strategy"].casefold()))


# ── Save to the Pattern Library ──────────────────────────────────────────────

def save_to_patterns(user_id: str, category: str, strategy: str, symbol: str, date: str, side: str) -> dict:
    """Copy a day's marks into the normal pattern chart for that symbol and day (the spec's Extension).

    An own chart for the day gets the marks it does not have yet (merged by mark id); a chart that uses other
    strikes is refused rather than drawn on the wrong contract.
    """
    from app.services import pattern_logger_service as patterns
    key = dive_key(category, strategy)
    setup = _serialize_setup(_get_setup_row(user_id, key, date, symbol, _side(side)))
    marks = setup["annotations"]
    if not marks:
        raise ValueError("Mark the setup on the charts first")
    return patterns.save_marks_to_chart(
        user_id, setup["symbol"], setup["date"], marks, strike_ce=setup["strike_ce"], strike_pe=setup["strike_pe"],
        interval_minutes=setup["interval_minutes"], notes=setup["notes"])
