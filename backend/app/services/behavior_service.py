"""
Behavior service — Manual Behavioral Analysis (Phase 23).

Users write yes/no "behavior questions" (kind ``entry`` or ``exit``) and mark, per
round trip, whether a trade showed that behavior.

Tables
  BehaviorQuestions  PK user_id, SK question_id          one row per question; never deleted,
                                                          only archived / restored
  BehaviorMarks      PK session_id, SK mark_key           one row per "yes" mark
                     GSI UserIdDateIndex (user_id, date)  mark_key = "<round_trip_index:05d>#<question_id>"

Marks live in their own table (not on TradeLabels) because label writes are full
overwrites and real sessions re-project labels from broker snapshots; neither may
clobber a behavior mark.
"""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

QUESTIONS_TABLE = "BehaviorQuestions"
MARKS_TABLE = "BehaviorMarks"
KINDS = ("entry", "exit")
MAX_TEXT_LENGTH = 140
MAX_ACTIVE_QUESTIONS = 40
MAX_DRILLDOWN_ROWS = 500

_QUESTIONS_ENSURED = False
_MARKS_ENSURED = False


# ── Tables ───────────────────────────────────────────────────────────────────

def _resource():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource()


def _create_if_missing(name: str, **definition) -> None:
    from app.services.db import get_dynamodb_client
    existing = set(_resource().meta.client.list_tables()["TableNames"])
    if name in existing:
        return
    client = get_dynamodb_client()
    client.create_table(TableName=name, BillingMode="PAY_PER_REQUEST", **definition)
    client.get_waiter("table_exists").wait(TableName=name)
    logger.info("Created %s table", name)


def ensure_questions_table() -> None:
    global _QUESTIONS_ENSURED
    if _QUESTIONS_ENSURED:
        return
    try:
        _create_if_missing(
            QUESTIONS_TABLE,
            KeySchema=[
                {"AttributeName": "user_id", "KeyType": "HASH"},
                {"AttributeName": "question_id", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "user_id", "AttributeType": "S"},
                {"AttributeName": "question_id", "AttributeType": "S"},
            ],
        )
        _QUESTIONS_ENSURED = True
    except Exception:
        logger.exception("Failed to ensure %s table", QUESTIONS_TABLE)


def ensure_marks_table() -> None:
    global _MARKS_ENSURED
    if _MARKS_ENSURED:
        return
    try:
        _create_if_missing(
            MARKS_TABLE,
            KeySchema=[
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "mark_key", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "mark_key", "AttributeType": "S"},
                {"AttributeName": "user_id", "AttributeType": "S"},
                {"AttributeName": "date", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[{
                "IndexName": "UserIdDateIndex",
                "KeySchema": [
                    {"AttributeName": "user_id", "KeyType": "HASH"},
                    {"AttributeName": "date", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }],
        )
        _MARKS_ENSURED = True
    except Exception:
        logger.exception("Failed to ensure %s table", MARKS_TABLE)


def _questions():
    ensure_questions_table()
    return _resource().Table(QUESTIONS_TABLE)


def _marks():
    ensure_marks_table()
    return _resource().Table(MARKS_TABLE)


def _query_all(table, **params) -> list[dict]:
    items: list[dict] = []
    while True:
        page = table.query(**params)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            return items
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Questions ────────────────────────────────────────────────────────────────

def _serialize_question(row: dict) -> dict:
    return {
        "question_id": row["question_id"],
        "kind": row["kind"],
        "text": row["text"],
        "status": row.get("status", "active"),
        "sort_order": int(row.get("sort_order", 0)),
        "created_at": row.get("created_at", ""),
        "archived_at": row.get("archived_at") or None,
    }


def _clean_text(text: str) -> str:
    cleaned = " ".join((text or "").split())
    if not cleaned:
        raise ValueError("Question text must not be empty")
    if len(cleaned) > MAX_TEXT_LENGTH:
        raise ValueError(f"Question text must be at most {MAX_TEXT_LENGTH} characters")
    return cleaned


def _all_questions(user_id: str) -> list[dict]:
    from boto3.dynamodb.conditions import Key
    rows = _query_all(_questions(), KeyConditionExpression=Key("user_id").eq(user_id), ConsistentRead=True)
    return [_serialize_question(r) for r in rows]


def list_questions(user_id: str, include_archived: bool = False) -> list[dict]:
    rows = _all_questions(user_id)
    if not include_archived:
        rows = [r for r in rows if r["status"] == "active"]
    return sorted(rows, key=lambda r: (r["status"] != "active", r["kind"], r["sort_order"], r["created_at"]))


def _get_question(user_id: str, question_id: str) -> dict:
    row = _questions().get_item(Key={"user_id": user_id, "question_id": question_id}, ConsistentRead=True).get("Item")
    if not row:
        raise LookupError("Question not found")
    return _serialize_question(row)


def _duplicate_active(rows: list[dict], text: str, kind: str, exclude_id: str | None = None) -> bool:
    key = text.casefold()
    return any(
        r["status"] == "active" and r["kind"] == kind and r["question_id"] != exclude_id and r["text"].casefold() == key
        for r in rows
    )


def add_question(user_id: str, text: str, kind: str) -> dict:
    if kind not in KINDS:
        raise ValueError("Question type must be 'entry' or 'exit'")
    cleaned = _clean_text(text)
    rows = _all_questions(user_id)
    active = [r for r in rows if r["status"] == "active"]
    if len(active) >= MAX_ACTIVE_QUESTIONS:
        raise ValueError(f"At most {MAX_ACTIVE_QUESTIONS} active questions are allowed; archive one first")
    if _duplicate_active(rows, cleaned, kind):
        raise ValueError("An active question with this text already exists")
    item = {
        "user_id": user_id,
        "question_id": uuid.uuid4().hex,
        "kind": kind,
        "text": cleaned,
        "status": "active",
        "sort_order": max([r["sort_order"] for r in rows], default=-1) + 1,
        "created_at": _now(),
    }
    _questions().put_item(Item=item)
    return _serialize_question(item)


def update_question(user_id: str, question_id: str, text: str) -> dict:
    """Edit text only. The type is fixed for the life of a question: archive it and add a new one to change it."""
    current = _get_question(user_id, question_id)
    cleaned = _clean_text(text)
    if current["status"] == "active" and _duplicate_active(_all_questions(user_id), cleaned, current["kind"], question_id):
        raise ValueError("An active question with this text already exists")
    _questions().update_item(
        Key={"user_id": user_id, "question_id": question_id},
        UpdateExpression="SET #t = :t",
        ExpressionAttributeNames={"#t": "text"},
        ExpressionAttributeValues={":t": cleaned},
    )
    return {**current, "text": cleaned}


def archive_question(user_id: str, question_id: str) -> dict:
    current = _get_question(user_id, question_id)
    if current["status"] == "archived":
        return current
    archived_at = _now()
    _questions().update_item(
        Key={"user_id": user_id, "question_id": question_id},
        UpdateExpression="SET #s = :s, archived_at = :a",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "archived", ":a": archived_at},
    )
    return {**current, "status": "archived", "archived_at": archived_at}


def restore_question(user_id: str, question_id: str) -> dict:
    current = _get_question(user_id, question_id)
    if current["status"] == "active":
        return current
    rows = _all_questions(user_id)
    if len([r for r in rows if r["status"] == "active"]) >= MAX_ACTIVE_QUESTIONS:
        raise ValueError(f"At most {MAX_ACTIVE_QUESTIONS} active questions are allowed; archive one first")
    if _duplicate_active(rows, current["text"], current["kind"], question_id):
        raise ValueError("An active question with this text already exists")
    _questions().update_item(
        Key={"user_id": user_id, "question_id": question_id},
        UpdateExpression="SET #s = :s REMOVE archived_at",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":s": "active"},
    )
    return {**current, "status": "active", "archived_at": None}


# ── Marks ────────────────────────────────────────────────────────────────────

def _mark_key(round_trip_index: int, question_id: str) -> str:
    return f"{int(round_trip_index):05d}#{question_id}"


def _serialize_mark(row: dict) -> dict:
    return {
        "round_trip_index": int(row["round_trip_index"]),
        "question_id": row["question_id"],
        "kind": row.get("kind", ""),
    }


def get_marks(session_id: str) -> list[dict]:
    from boto3.dynamodb.conditions import Key
    rows = _query_all(_marks(), KeyConditionExpression=Key("session_id").eq(session_id), ConsistentRead=True)
    return sorted((_serialize_mark(r) for r in rows), key=lambda r: (r["round_trip_index"], r["question_id"]))


def set_marks(user_id: str, session: dict, round_trip_index: int, answers: dict[str, bool]) -> list[dict]:
    """Set (True) or clear (False) marks for one round trip. Idempotent.

    Only active questions can be newly marked; an archived question can be cleared,
    and re-sending an existing mark for it is a no-op.
    """
    if round_trip_index < 0:
        raise ValueError("round_trip_index must not be negative")
    session_id = session["session_id"]
    by_id = {q["question_id"]: q for q in _all_questions(user_id)}
    unknown = [qid for qid in answers if qid not in by_id]
    if unknown:
        raise ValueError("Unknown behavior question")
    table = _marks()
    existing = {m["question_id"] for m in get_marks(session_id) if m["round_trip_index"] == round_trip_index}
    for question_id, answer in answers.items():
        question = by_id[question_id]
        if answer and question_id not in existing and question["status"] != "active":
            raise ValueError("Archived questions cannot be newly marked")
    for question_id, answer in answers.items():
        question = by_id[question_id]
        key = {"session_id": session_id, "mark_key": _mark_key(round_trip_index, question_id)}
        if not answer:
            table.delete_item(Key=key)
        elif question_id not in existing:
            table.put_item(Item={
                **key,
                "user_id": user_id,
                "date": session.get("date", ""),
                "symbol": session.get("symbol", ""),
                "session_type": session.get("session_type", ""),
                "instrument_type": session.get("instrument_type", ""),
                "round_trip_index": int(round_trip_index),
                "question_id": question_id,
                "kind": question["kind"],
                "marked_at": _now(),
            })
    return [m for m in get_marks(session_id) if m["round_trip_index"] == round_trip_index]


def delete_session_marks(session_id: str) -> int:
    from boto3.dynamodb.conditions import Key
    table = _marks()
    rows = _query_all(table, KeyConditionExpression=Key("session_id").eq(session_id), ConsistentRead=True)
    with table.batch_writer() as batch:
        for row in rows:
            batch.delete_item(Key={"session_id": session_id, "mark_key": row["mark_key"]})
    return len(rows)


# ── Stats ────────────────────────────────────────────────────────────────────

def _user_marks(user_id: str, start_date: str | None, end_date: str | None) -> list[dict]:
    from boto3.dynamodb.conditions import Key
    condition = Key("user_id").eq(user_id)
    if start_date and end_date:
        condition = condition & Key("date").between(start_date, end_date)
    elif start_date:
        condition = condition & Key("date").gte(start_date)
    elif end_date:
        condition = condition & Key("date").lte(end_date)
    return _query_all(_marks(), IndexName="UserIdDateIndex", KeyConditionExpression=condition)


def _matches(row: dict, symbol: str | None, session_type: str | None, instrument_type: str | None) -> bool:
    return (
        (not symbol or row.get("symbol") == symbol)
        and (not session_type or row.get("session_type") == session_type)
        and (not instrument_type or row.get("instrument_type") == instrument_type)
    )


def get_stats(
    user_id: str,
    start_date: str | None = None,
    end_date: str | None = None,
    symbol: str | None = None,
    session_type: str | None = None,
    instrument_type: str | None = None,
) -> dict:
    """Per-day count of trades showing each behavior. Only days with at least one mark are returned."""
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in _user_marks(user_id, start_date, end_date):
        if _matches(row, symbol, session_type, instrument_type):
            counts[row["date"]][row["question_id"]] += 1
    return {
        "questions": list_questions(user_id, include_archived=True),
        "days": [{"date": day, "counts": dict(counts[day])} for day in sorted(counts)],
    }


def marks_by_question(
    user_id: str,
    question_id: str,
    start_date: str | None = None,
    end_date: str | None = None,
    symbol: str | None = None,
    session_type: str | None = None,
    instrument_type: str | None = None,
) -> list[dict]:
    """Trades flagged with one behavior (newest first), joined with the labelled P&L when available."""
    rows = [
        r for r in _user_marks(user_id, start_date, end_date)
        if r["question_id"] == question_id and _matches(r, symbol, session_type, instrument_type)
    ]
    rows.sort(key=lambda r: (r["date"], r["session_id"], int(r["round_trip_index"])), reverse=True)
    rows = rows[:MAX_DRILLDOWN_ROWS]
    labels = _resource().Table("TradeLabels")
    result = []
    for row in rows:
        pnl = None
        try:
            label = labels.get_item(Key={"session_id": row["session_id"], "round_trip_index": int(row["round_trip_index"])}).get("Item")
            if label and label.get("round_trip_pnl") is not None:
                pnl = float(label["round_trip_pnl"])
        except Exception:
            logger.exception("Could not read label P&L for %s#%s", row["session_id"], row["round_trip_index"])
        result.append({
            "session_id": row["session_id"],
            "date": row["date"],
            "symbol": row.get("symbol", ""),
            "session_type": row.get("session_type", ""),
            "round_trip_index": int(row["round_trip_index"]),
            "pnl": pnl,
        })
    return result
