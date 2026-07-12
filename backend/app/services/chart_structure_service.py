"""
Chart Structure service — CRUD over DynamoDB ChartStructures table.

One record per (symbol, date). Predefined classifications have
user_id="__SYSTEM__", is_predefined=True. User-custom classifications
have their actual user_id. Sharing follows the same pattern-logger
model via ChartStructureShares table.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from boto3.dynamodb.conditions import Key

logger = logging.getLogger(__name__)

TABLE = "ChartStructures"
SHARE_TABLE = "ChartStructureShares"

# ── Predefined types ─────────────────────────────────────────────────────────

OPENING_TYPES = [
    {"value": "within_yesterdays_range", "label": "Within Yesterday's Range"},
    {"value": "within_day_before_yesterdays_range", "label": "Within Day Before Yesterday's Range"},
    {"value": "gap_up", "label": "Gap Up"},
    {"value": "gap_down", "label": "Gap Down"},
    {"value": "big_gap_up", "label": "Big Gap Up"},
    {"value": "big_gap_down", "label": "Big Gap Down"},
    {"value": "undefined", "label": "Undefined"},
]

MIDDAY_TYPES = [
    {"value": "trading_range", "label": "Trading Range"},
    {"value": "breakout", "label": "Breakout"},
    {"value": "trend", "label": "Trend"},
    {"value": "undefined", "label": "Undefined"},
]

CLOSING_TYPES = [
    {"value": "trading_range", "label": "Trading Range"},
    {"value": "breakout", "label": "Breakout"},
    {"value": "reversal_breakout", "label": "Reversal Breakout"},
    {"value": "trend", "label": "Trend"},
    {"value": "trend_reversal", "label": "Trend Reversal"},
    {"value": "undefined", "label": "Undefined"},
]


# ── table helpers ────────────────────────────────────────────────────────────

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
        logger.info("Created %s table", SHARE_TABLE)
    except Exception:
        logger.exception("Failed to ensure %s table", SHARE_TABLE)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


# ── type definitions ─────────────────────────────────────────────────────────

def get_predefined_types() -> dict:
    return {
        "opening_types": OPENING_TYPES,
        "midday_types": MIDDAY_TYPES,
        "closing_types": CLOSING_TYPES,
    }


# ── sharing ──────────────────────────────────────────────────────────────────

def _load_shared_owner_ids(user_id: str) -> list[str]:
    _ensure_share_table()
    try:
        resp = _share_table().query(
            IndexName="SharedUserIdIndex",
            KeyConditionExpression=Key("shared_user_id").eq(user_id),
        )
        owners = {user_id}
        for item in resp.get("Items", []):
            owners.add(item.get("owner_user_id"))
        return [o for o in owners if o]
    except Exception:
        logger.exception("Failed to load structure share owners for %s", user_id)
        return [user_id]


def _resolve_email_targets(emails_csv: str) -> list[dict]:
    from app.services.user_service import get_user_by_email

    emails = []
    for raw in emails_csv.split(","):
        email = raw.strip().lower()
        if email and email not in emails:
            emails.append(email)

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


def load_shared_owner_ids(user_id: str) -> list[str]:
    return _load_shared_owner_ids(user_id)


def sync_structure_shares(owner_user_id: str, share_emails_csv: str) -> list[dict]:
    _ensure_share_table()
    from app.services.user_service import get_user_info

    owner = get_user_info(owner_user_id) or {"email": ""}
    owner_email = owner.get("email", "")
    targets = _resolve_email_targets(share_emails_csv)
    now = _now_iso()

    try:
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
        logger.exception("Failed to sync structure shares for owner %s", owner_user_id)
        raise

    return targets


# ── item serialization ───────────────────────────────────────────────────────

def _item_to_dict(item: dict, user_id: str) -> dict:
    return {
        "chart_structure_id": item["chart_structure_id"],
        "symbol": item.get("symbol", ""),
        "date": item.get("date", ""),
        "opening_type": item.get("opening_type", "undefined"),
        "midday_type": item.get("midday_type", "undefined"),
        "closing_type": item.get("closing_type", "undefined"),
        "is_predefined": item.get("is_predefined", False),
        "user_id": item.get("user_id", ""),
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
        "can_delete": item.get("user_id") == user_id,
    }


# ── query ────────────────────────────────────────────────────────────────────

def list_structures(
    user_id: str,
    opening_types: Optional[list[str]] = None,
    midday_types: Optional[list[str]] = None,
    closing_types: Optional[list[str]] = None,
    symbol: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> list[dict]:
    owner_ids = _load_shared_owner_ids(user_id)

    results: list[dict] = []
    seen: set[str] = set()

    for owner_id in owner_ids:
        try:
            resp = _table().query(
                IndexName="UserIdIndex",
                KeyConditionExpression=Key("user_id").eq(owner_id),
            )
            for item in resp.get("Items", []):
                sid = item.get("chart_structure_id")
                if sid in seen:
                    continue
                seen.add(sid)
                results.append(_item_to_dict(item, user_id))
        except Exception:
            logger.exception("Failed to query structures for owner %s", owner_id)

    # Also include predefined (system) structures
    try:
        resp = _table().query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq("__SYSTEM__"),
        )
        for item in resp.get("Items", []):
            sid = item.get("chart_structure_id")
            if sid in seen:
                continue
            seen.add(sid)
            results.append(_item_to_dict(item, user_id))
    except Exception:
        logger.exception("Failed to query predefined structures")

    # Apply filters
    if opening_types:
        results = [r for r in results if r.get("opening_type") in opening_types]
    if midday_types:
        results = [r for r in results if r.get("midday_type") in midday_types]
    if closing_types:
        results = [r for r in results if r.get("closing_type") in closing_types]
    if symbol:
        results = [r for r in results if r.get("symbol") == symbol.upper()]
    if start_date:
        results = [r for r in results if r.get("date", "") >= start_date]
    if end_date:
        results = [r for r in results if r.get("date", "") <= end_date]

    results.sort(key=lambda x: x.get("date", ""), reverse=True)
    return results


def get_structure_for_user(user_id: str, structure_id: str) -> Optional[dict]:
    resp = _table().get_item(Key={"chart_structure_id": structure_id})
    item = resp.get("Item")
    if not item:
        return None
    if item.get("user_id") == user_id or item.get("user_id") == "__SYSTEM__":
        return _item_to_dict(item, user_id)
    if item.get("user_id") in _load_shared_owner_ids(user_id):
        d = _item_to_dict(item, user_id)
        d["can_delete"] = False
        return d
    return None


# ── CRUD ─────────────────────────────────────────────────────────────────────

def create_structure(
    user_id: str,
    symbol: str,
    date: str,
    opening_type: str,
    midday_type: str,
    closing_type: str,
) -> dict:
    sid = str(uuid.uuid4())
    now = _now_iso()
    item = {
        "chart_structure_id": sid,
        "symbol": symbol.upper(),
        "date": date,
        "opening_type": opening_type,
        "midday_type": midday_type,
        "closing_type": closing_type,
        "is_predefined": False,
        "user_id": user_id,
        "created_at": now,
        "updated_at": now,
    }
    _table().put_item(Item=item)
    return _item_to_dict(item, user_id)


def update_structure(
    structure_id: str,
    opening_type: str,
    midday_type: str,
    closing_type: str,
) -> Optional[dict]:
    now = _now_iso()
    try:
        resp = _table().update_item(
            Key={"chart_structure_id": structure_id},
            UpdateExpression="SET opening_type = :o, midday_type = :m, closing_type = :c, updated_at = :u",
            ExpressionAttributeValues={":o": opening_type, ":m": midday_type, ":c": closing_type, ":u": now},
            ReturnValues="ALL_NEW",
        )
        item = resp.get("Attributes", {})
        return _item_to_dict(item, item.get("user_id", ""))
    except Exception:
        logger.exception("update_structure failed for %s", structure_id)
        return None


def delete_structure(structure_id: str) -> None:
    _table().delete_item(Key={"chart_structure_id": structure_id})
