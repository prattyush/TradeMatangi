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
SHARE_TABLE = "PatternShares"


def _table():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(TABLE)


def _share_table():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(SHARE_TABLE)


def _ensure_share_table() -> None:
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        existing = set(get_dynamodb_resource().meta.client.list_tables()["TableNames"])
        if SHARE_TABLE in existing:
            return
        client = get_dynamodb_client()
        client.create_table(
            TableName=SHARE_TABLE,
            KeySchema=[
                {"AttributeName": "owner_user_id", "KeyType": "HASH"},
                {"AttributeName": "shared_user_id", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "owner_user_id", "AttributeType": "S"},
                {"AttributeName": "shared_user_id", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[
                {
                    "IndexName": "SharedUserIdIndex",
                    "KeySchema": [{"AttributeName": "shared_user_id", "KeyType": "HASH"}],
                    "Projection": {"ProjectionType": "ALL"},
                    "ProvisionedThroughput": {"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
                }
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        logger.info("Created PatternShares table")
    except Exception:
        logger.exception("Failed to ensure PatternShares table")


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _normalize_emails(emails_csv: str) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for raw in emails_csv.split(","):
        email = _normalize_email(raw)
        if not email:
            continue
        if email not in seen:
            seen.add(email)
            result.append(email)
    return result


def _resolve_email_targets(emails_csv: str) -> list[dict]:
    from app.services.user_service import get_user_by_email

    emails = _normalize_emails(emails_csv)
    missing: list[str] = []
    targets: list[dict] = []
    for email in emails:
        user = get_user_by_email(email)
        if not user:
            missing.append(email)
            continue
        targets.append({
            "user_id": user["user_id"],
            "email": user.get("email", email),
        })
    if missing:
        raise ValueError(f"Unknown share email(s): {', '.join(missing)}")
    return targets


def _get_shared_owner_ids(shared_user_id: str) -> list[str]:
    _ensure_share_table()
    from boto3.dynamodb.conditions import Key
    try:
        resp = _share_table().query(
            IndexName="SharedUserIdIndex",
            KeyConditionExpression=Key("shared_user_id").eq(shared_user_id),
        )
        owners = {shared_user_id}
        for item in resp.get("Items", []):
            owners.add(item.get("owner_user_id"))
        return [owner for owner in owners if owner]
    except Exception:
        logger.exception("Failed to load pattern share owners for %s", shared_user_id)
        return [shared_user_id]


def get_accessible_owner_ids(user_id: str) -> list[str]:
    """Return user_id plus any owners that shared charts to this user."""
    owners = _get_shared_owner_ids(user_id)
    # Keep the current user's own charts first so create-mode lookups prefer them.
    return [user_id] + sorted(o for o in owners if o != user_id)


def sync_pattern_shares(owner_user_id: str, share_emails_csv: str) -> list[dict]:
    """
    Replace all outbound pattern shares for owner_user_id.
    Returns normalized share targets as {user_id, email}.
    """
    _ensure_share_table()
    from app.services.user_service import get_user_info

    owner = get_user_info(owner_user_id) or {"email": ""}
    owner_email = owner.get("email", "")
    targets = _resolve_email_targets(share_emails_csv)
    now = _now_iso()

    try:
        from boto3.dynamodb.conditions import Key
        existing = _share_table().query(
            KeyConditionExpression=Key("owner_user_id").eq(owner_user_id)
        ).get("Items", [])
        for item in existing:
            _share_table().delete_item(
                Key={
                    "owner_user_id": item["owner_user_id"],
                    "shared_user_id": item["shared_user_id"],
                }
            )

        for target in targets:
            _share_table().put_item(Item={
                "owner_user_id": owner_user_id,
                "shared_user_id": target["user_id"],
                "owner_email": owner_email,
                "shared_email": target["email"],
                "created_at": now,
                "updated_at": now,
            })
    except Exception:
        logger.exception("Failed to sync pattern shares for owner %s", owner_user_id)
        raise

    return targets


def _load_shared_owner_ids(user_id: str) -> list[str]:
    return get_accessible_owner_ids(user_id)


def _chart_to_meta(item: dict, user_id: str) -> dict:
    return _chart_to_meta_filtered(item, user_id, None, None)


def _chart_to_meta_filtered(
    item: dict,
    user_id: str,
    strategy: Optional[str],
    category: Optional[str],
) -> dict:
    raw = json.loads(item.get("annotations", "[]"))
    strategy_names = list({a.get("strategy_name", "") for a in raw if a.get("strategy_name")})
    categories = list({a.get("category", "") for a in raw if a.get("category")})
    entry_count = sum(
        1 for a in raw
        if a.get("type") == "entry"
        and (not strategy or a.get("strategy_name") == strategy)
        and (not category or a.get("category") == category)
    )
    exit_count = sum(
        1 for a in raw
        if a.get("type") == "exit"
        and (not strategy or a.get("strategy_name") == strategy)
        and (not category or a.get("category") == category)
    )
    tp_raw = item.get("top_patterns", "{}")
    top_patterns = json.loads(tp_raw) if isinstance(tp_raw, str) else (tp_raw or {})
    return {
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
        "categories": categories,
        "can_delete": item.get("user_id") == user_id,
        "top_patterns": top_patterns,
        "has_top_patterns": bool(top_patterns),
    }


def _query_charts_for_owner(owner_id: str) -> list[dict]:
    from boto3.dynamodb.conditions import Key
    try:
        resp = _table().query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(owner_id),
        )
        return resp.get("Items", [])
    except Exception:
        logger.exception("Failed to query pattern charts for owner %s", owner_id)
        return []


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
    top_patterns: Optional[dict] = None,
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
    if top_patterns:
        item["top_patterns"] = json.dumps(top_patterns)
    _table().put_item(Item=item)
    result = {**item, "annotations": annotations}
    if top_patterns:
        result["top_patterns"] = top_patterns
    return result


def _parse_top_patterns(item: dict) -> dict:
    tp = item.get("top_patterns", {})
    if isinstance(tp, str):
        return json.loads(tp) if tp else {}
    return tp or {}


def update_chart(chart_id: str, annotations: list[dict], notes: str, top_patterns: Optional[dict] = None) -> Optional[dict]:
    now = _now_iso()
    try:
        if top_patterns is not None:
            resp = _table().update_item(
                Key={"chart_id": chart_id},
                UpdateExpression="SET annotations = :a, notes = :n, top_patterns = :tp, updated_at = :u",
                ExpressionAttributeValues={
                    ":a": json.dumps(annotations),
                    ":n": notes,
                    ":tp": json.dumps(top_patterns),
                    ":u": now,
                },
                ReturnValues="ALL_NEW",
            )
        else:
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
        item["top_patterns"] = _parse_top_patterns(item)
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
    tp_raw = item.get("top_patterns", "{}")
    item["top_patterns"] = json.loads(tp_raw) if isinstance(tp_raw, str) else (tp_raw or {})
    return item


def get_chart_for_user(user_id: str, chart_id: str) -> Optional[dict]:
    chart = get_chart(chart_id)
    if not chart:
        return None
    if chart.get("user_id") == user_id:
        chart["can_delete"] = True
        return chart
    if chart.get("user_id") in get_accessible_owner_ids(user_id):
        chart["can_delete"] = False
        return chart
    return None


def list_charts_for_user(
    user_id: str,
    strategy: Optional[str] = None,
    category: Optional[str] = None,
    top_only: bool = False,
) -> list[dict]:
    """
    Return metadata (no annotation payload) for all charts belonging to user_id.
    Optionally filter to charts that contain at least one annotation with the
    given strategy_name and/or category, or only charts with top_patterns set.
    """
    result = []
    seen_chart_ids: set[str] = set()
    for owner_id in _load_shared_owner_ids(user_id):
        for item in _query_charts_for_owner(owner_id):
            if item.get("chart_id") in seen_chart_ids:
                continue
            seen_chart_ids.add(item.get("chart_id"))
            raw = json.loads(item.get("annotations", "[]"))
            if strategy and not any(a.get("strategy_name") == strategy for a in raw):
                continue
            if category and not any(a.get("category") == category for a in raw):
                continue
            if top_only:
                tp_raw = item.get("top_patterns", "{}")
                tp = json.loads(tp_raw) if isinstance(tp_raw, str) else (tp_raw or {})
                if not tp:
                    continue
            meta = _chart_to_meta_filtered(item, user_id, strategy, category)
            result.append(meta)

    result.sort(key=lambda x: x.get("date", ""), reverse=True)
    return result


def find_chart_by_date(
    user_id: str,
    symbol: str,
    date: str,
    instrument_type: str,
    right: Optional[str] = None,
) -> Optional[dict]:
    """Find the user's own chart record for a specific symbol/date/instrument/right."""
    for item in _query_charts_for_owner(user_id):
        if item.get("symbol") != symbol:
            continue
        if item.get("date") != date:
            continue
        if item.get("instrument_type") != instrument_type:
            continue
        if right and item.get("right") != right:
            continue
        chart = get_chart(item["chart_id"])
        if chart:
            chart["can_delete"] = chart.get("user_id") == user_id
        return chart
    return None


def list_strategy_names(user_id: str) -> list[str]:
    """Return all unique strategy names across all charts for a user."""
    names: set[str] = set()
    for owner_id in _load_shared_owner_ids(user_id):
        for item in _query_charts_for_owner(owner_id):
            for ann in json.loads(item.get("annotations", "[]")):
                s = ann.get("strategy_name", "")
                if s:
                    names.add(s)
    return sorted(names)


def list_category_names(user_id: str) -> list[str]:
    """Return all unique category names across all charts for a user."""
    names: set[str] = set()
    for owner_id in _load_shared_owner_ids(user_id):
        for item in _query_charts_for_owner(owner_id):
            for ann in json.loads(item.get("annotations", "[]")):
                c = ann.get("category", "")
                if c:
                    names.add(c)
    return sorted(names)
