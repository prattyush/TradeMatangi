"""
Pattern Logger service — CRUD over DynamoDB PatternAnnotations table.

One record per (user, symbol, date, instrument_type[, right]).
Multiple strategies co-exist on the same chart: each annotation carries
its own strategy_name field.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

TABLE = "PatternAnnotations"


def _table():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(TABLE)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


# ── Write ─────────────────────────────────────────────────────────────────────

def create_chart(
    user_id: str,
    symbol: str,
    date: str,
    instrument_type: str,
    annotations: list[dict],
    notes: str = "",
    right: Optional[str] = None,
    strike: Optional[int] = None,
) -> dict:
    chart_id = str(uuid.uuid4())
    now = _now_iso()
    item = {
        "chart_id": chart_id,
        "user_id": user_id,
        "symbol": symbol,
        "date": date,
        "instrument_type": instrument_type,
        "annotations": json.dumps(annotations),
        "notes": notes,
        "created_at": now,
        "updated_at": now,
    }
    if right:
        item["right"] = right
    if strike is not None:
        item["strike"] = strike
    _table().put_item(Item=item)
    return {**item, "annotations": annotations}


def update_chart(chart_id: str, annotations: list[dict], notes: str) -> Optional[dict]:
    now = _now_iso()
    try:
        resp = _table().update_item(
            Key={"chart_id": chart_id},
            UpdateExpression="SET annotations = :a, notes = :n, updated_at = :u",
            ExpressionAttributeValues={
                ":a": json.dumps(annotations),
                ":n": notes,
                ":u": now,
            },
            ReturnValues="ALL_NEW",
        )
        item = resp.get("Attributes", {})
        item["annotations"] = json.loads(item.get("annotations", "[]"))
        return item
    except Exception as exc:
        logger.error("update_chart failed for %s: %s", chart_id, exc)
        return None


def delete_chart(chart_id: str) -> None:
    _table().delete_item(Key={"chart_id": chart_id})


# ── Read ──────────────────────────────────────────────────────────────────────

def get_chart(chart_id: str) -> Optional[dict]:
    resp = _table().get_item(Key={"chart_id": chart_id})
    item = resp.get("Item")
    if not item:
        return None
    item["annotations"] = json.loads(item.get("annotations", "[]"))
    return item


def list_charts_for_user(user_id: str, strategy: Optional[str] = None) -> list[dict]:
    """
    Return metadata (no annotation payload) for all charts belonging to user_id.
    Optionally filter to charts that contain at least one annotation with the
    given strategy_name.
    """
    from boto3.dynamodb.conditions import Attr
    fe = Attr("user_id").eq(user_id)
    resp = _table().scan(FilterExpression=fe)
    items = resp.get("Items", [])

    result = []
    for item in items:
        raw = json.loads(item.get("annotations", "[]"))
        if strategy:
            if not any(a.get("strategy_name") == strategy for a in raw):
                continue
        # Build metadata summary (entry/exit counts for this strategy)
        entry_count = sum(1 for a in raw if a.get("type") == "entry" and (not strategy or a.get("strategy_name") == strategy))
        exit_count = sum(1 for a in raw if a.get("type") == "exit" and (not strategy or a.get("strategy_name") == strategy))
        strategy_names = list({a.get("strategy_name", "") for a in raw if a.get("strategy_name")})
        result.append({
            "chart_id": item["chart_id"],
            "user_id": item["user_id"],
            "symbol": item.get("symbol"),
            "date": item.get("date"),
            "instrument_type": item.get("instrument_type"),
            "right": item.get("right"),
            "strike": item.get("strike"),
            "notes": item.get("notes", ""),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
            "entry_count": entry_count,
            "exit_count": exit_count,
            "strategy_names": strategy_names,
        })

    result.sort(key=lambda x: x.get("date", ""), reverse=True)
    return result


def find_chart_by_date(
    user_id: str,
    symbol: str,
    date: str,
    instrument_type: str,
    right: Optional[str] = None,
) -> Optional[dict]:
    """Find existing chart record for a specific (user, symbol, date, instrument, right)."""
    from boto3.dynamodb.conditions import Attr
    fe = (
        Attr("user_id").eq(user_id)
        & Attr("symbol").eq(symbol)
        & Attr("date").eq(date)
        & Attr("instrument_type").eq(instrument_type)
    )
    if right:
        fe = fe & Attr("right").eq(right)
    resp = _table().scan(FilterExpression=fe)
    items = resp.get("Items", [])
    if not items:
        return None
    item = items[0]
    item["annotations"] = json.loads(item.get("annotations", "[]"))
    return item


def list_strategy_names(user_id: str) -> list[str]:
    """Return all unique strategy names across all charts for a user."""
    from boto3.dynamodb.conditions import Attr
    resp = _table().scan(FilterExpression=Attr("user_id").eq(user_id))
    names: set[str] = set()
    for item in resp.get("Items", []):
        for ann in json.loads(item.get("annotations", "[]")):
            s = ann.get("strategy_name", "")
            if s:
                names.add(s)
    return sorted(names)
