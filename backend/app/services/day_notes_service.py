"""
Day notes and TODOs — the improvement notes of a trading day (Phase 27, S5).

Tables (created lazily, like BehaviorMarks and WhatIfScenarios; also in scripts/setup-dynamodb-tables.py)
  DayNotes  PK user_id, SK date          one note per market date
  DayTodos  PK user_id, SK todo_id       one item per TODO, with its status history

Both are keyed by the market date and the user, not by session: a day's note covers every session of that day (replay, paper and
real), and a TODO is carried from the day it was written until it is closed. So they are NOT removed when a session is deleted
(session_cleanup_service does not know them): they hold the trader's own words, not trade data.

A note has four free-text parts (what went well, what to improve, specific points, context). A TODO has a text, the date it was
created and a status: ``open``, ``working``, ``done`` or ``improved``. Every status change is kept with the market date it was made
for, so a day reviewed later shows the TODO as it stood on that day ("still working" then, "improved" on a later day).

Nothing here touches a trade, an order, a label or the broker.
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

NOTES_TABLE = "DayNotes"
TODOS_TABLE = "DayTodos"
NOTE_FIELDS = ("went_well", "to_improve", "specific_points", "context")
NOTE_MAX_CHARS = 4000
TODO_MAX_CHARS = 300
MAX_TODOS = 500
STATUSES = ("open", "working", "done", "improved")
OPEN_STATUSES = ("open", "working")
CLOSED_STATUSES = ("done", "improved")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_ENSURED: set[str] = set()


def _resource():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource()


def _ensure(table: str, sort_key: str) -> None:
    if table in _ENSURED:
        return
    try:
        from app.services.db import get_dynamodb_client
        if table not in set(_resource().meta.client.list_tables()["TableNames"]):
            client = get_dynamodb_client()
            client.create_table(
                TableName=table, BillingMode="PAY_PER_REQUEST",
                KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}, {"AttributeName": sort_key, "KeyType": "RANGE"}],
                AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"}, {"AttributeName": sort_key, "AttributeType": "S"}],
            )
            client.get_waiter("table_exists").wait(TableName=table)
            logger.info("Created %s table", table)
        _ENSURED.add(table)
    except Exception:
        logger.exception("Failed to ensure %s table", table)


def _notes():
    _ensure(NOTES_TABLE, "date")
    return _resource().Table(NOTES_TABLE)


def _todos():
    _ensure(TODOS_TABLE, "todo_id")
    return _resource().Table(TODOS_TABLE)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def clean_date(value) -> str:
    text = str(value or "").strip()
    if not _DATE.match(text):
        raise ValueError("The date must be YYYY-MM-DD")
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise ValueError("The date must be a real calendar date") from None
    return text


def _text(value, label: str, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        raise ValueError(f"{label} is too long (at most {limit} characters)")
    return text


def _query_all(table, user_id: str) -> list[dict]:
    from boto3.dynamodb.conditions import Key
    items: list[dict] = []
    params: dict = {"KeyConditionExpression": Key("user_id").eq(user_id)}
    while True:
        page = table.query(**params)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


# ── Notes ────────────────────────────────────────────────────────────────────

def _serialize_note(row: dict | None, date: str) -> dict:
    row = row or {}
    return {"date": date, **{field: row.get(field, "") for field in NOTE_FIELDS}, "updated_at": row.get("updated_at")}


def get_note(user_id: str, date: str) -> dict | None:
    """The note of a market date, or None when nothing was written."""
    row = _notes().get_item(Key={"user_id": user_id, "date": clean_date(date)}).get("Item")
    return _serialize_note(row, date) if row else None


def save_note(user_id: str, date: str, parts: dict) -> dict | None:
    """Writes (replaces) the day's note. A note with all four parts empty is removed and None is returned."""
    day = clean_date(date)
    values = {field: _text(parts.get(field), field.replace("_", " "), NOTE_MAX_CHARS) for field in NOTE_FIELDS}
    if not any(values.values()):
        _notes().delete_item(Key={"user_id": user_id, "date": day})
        return None
    row = {"user_id": user_id, "date": day, **values, "updated_at": _now()}
    _notes().put_item(Item=row)
    return _serialize_note(row, day)


# ── TODOs ────────────────────────────────────────────────────────────────────

def _history(row: dict) -> list[dict]:
    """The status changes, oldest first (by market date, then by the time they were made)."""
    entries = [{"date": h["date"], "status": h["status"], "at": h.get("at", "")} for h in row.get("history", [])]
    return sorted(entries, key=lambda h: (h["date"], h["at"]))


def status_on(row: dict, date: str) -> str | None:
    """The status of a TODO on a market date: the last change made for that date or earlier; None before it was created."""
    status = None
    for entry in _history(row):
        if entry["date"] <= date:
            status = entry["status"]
    return status


def _closed_on(row: dict, date: str) -> bool:
    """Whether a status change to done / improved was made for exactly this date (so the day it was closed still shows it)."""
    return any(entry["date"] == date and entry["status"] in CLOSED_STATUSES for entry in _history(row))


def serialize_todo(row: dict, date: str | None = None) -> dict:
    history = _history(row)
    out = {
        "todo_id": row["todo_id"], "text": row["text"], "created_date": row["created_date"],
        "status": status_on(row, date) if date else (history[-1]["status"] if history else "open"),
        "history": history,
    }
    if date:
        out["carried"] = row["created_date"] < date
    return out


def todos_for_day(user_id: str, date: str) -> list[dict]:
    """The TODOs that belong on a day's notes: written on or before it and still open or working that day, plus those closed that day.

    Carried ones (written on an earlier day) come first, then the day's own, each oldest first. A TODO closed on an earlier day is
    not shown again; reviewing an old day shows a TODO as it stood then.
    """
    day = clean_date(date)
    shown = []
    for row in _query_all(_todos(), user_id):
        if row["created_date"] > day:
            continue
        status = status_on(row, day)
        if status in OPEN_STATUSES or (status in CLOSED_STATUSES and _closed_on(row, day)):
            shown.append(serialize_todo(row, day))
    return sorted(shown, key=lambda t: (not t["carried"], t["created_date"], t["todo_id"]))


def list_todos(user_id: str) -> list[dict]:
    """Every TODO with its history, newest first: the review list."""
    rows = [serialize_todo(row) for row in _query_all(_todos(), user_id)]
    return sorted(rows, key=lambda t: (t["created_date"], t["todo_id"]), reverse=True)


def add_todo(user_id: str, date: str, text: str) -> dict:
    day = clean_date(date)
    clean = _text(text, "The TODO", TODO_MAX_CHARS)
    if not clean:
        raise ValueError("Write the TODO first")
    if len(_query_all(_todos(), user_id)) >= MAX_TODOS:
        raise ValueError(f"At most {MAX_TODOS} TODOs; delete some old ones first")
    row = {"user_id": user_id, "todo_id": uuid.uuid4().hex[:16], "text": clean, "created_date": day,
           "history": [{"date": day, "status": "open", "at": _now()}], "updated_at": _now()}
    _todos().put_item(Item=row)
    return serialize_todo(row, day)


def _get_todo(user_id: str, todo_id: str) -> dict:
    row = _todos().get_item(Key={"user_id": user_id, "todo_id": str(todo_id)}).get("Item")
    if not row:
        raise LookupError("TODO not found")
    return row


def set_status(user_id: str, todo_id: str, date: str, status: str) -> dict:
    """Records a status for the market date being reviewed. The same status again for that date changes nothing."""
    day = clean_date(date)
    if status not in STATUSES:
        raise ValueError("The status must be open, working, done or improved")
    row = _get_todo(user_id, todo_id)
    if day < row["created_date"]:
        raise ValueError("A TODO cannot change status before the day it was written")
    if status_on(row, day) == status and any(h["date"] == day for h in _history(row)):
        return serialize_todo(row, day)
    # The change for a day replaces an earlier change made for that same day, so the history has one entry per day.
    history = [h for h in _history(row) if h["date"] != day] + [{"date": day, "status": status, "at": _now()}]
    row = {**row, "history": history, "updated_at": _now()}
    _todos().put_item(Item=row)
    return serialize_todo(row, day)


def delete_todo(user_id: str, todo_id: str) -> None:
    _get_todo(user_id, todo_id)
    _todos().delete_item(Key={"user_id": user_id, "todo_id": str(todo_id)})


def day_view(user_id: str, date: str) -> dict:
    day = clean_date(date)
    return {"date": day, "note": get_note(user_id, day), "todos": todos_for_day(user_id, day)}
