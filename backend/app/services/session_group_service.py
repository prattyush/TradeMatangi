"""Durable ownership and validation for a user's active session group.

The in-memory cache is intentionally only an optimisation.  DynamoDB remains
the source of truth, which makes browser and backend restarts safe.
"""
from __future__ import annotations

import logging
import time
import uuid
from decimal import Decimal

logger = logging.getLogger(__name__)

TABLE = "SessionGroups"
MAX_MEMBERS = 4
_groups: dict[str, dict] = {}


def family_for(session_type: str) -> str:
    if session_type == "stepwise":
        return "stepwise"
    if session_type in ("paper", "real"):
        return "live"
    return "sim"


def _ensure_table() -> None:
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        if TABLE in set(get_dynamodb_resource().meta.client.list_tables()["TableNames"]):
            return
        get_dynamodb_client().create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "group_id", "KeyType": "HASH"}],
            AttributeDefinitions=[
                {"AttributeName": "group_id", "AttributeType": "S"},
                {"AttributeName": "user_id", "AttributeType": "S"},
            ],
            GlobalSecondaryIndexes=[{
                "IndexName": "UserIdIndex",
                "KeySchema": [{"AttributeName": "user_id", "KeyType": "HASH"}],
                "Projection": {"ProjectionType": "ALL"},
            }],
            BillingMode="PAY_PER_REQUEST",
        )
    except Exception:
        # Tests and local development can use the in-memory cache when Dynamo
        # isn't configured; do not make an unavailable DB start a trading loop.
        logger.exception("Could not ensure %s", TABLE)


def _save(group: dict) -> None:
    group["updated_at"] = int(time.time() * 1000)
    _groups[group["group_id"]] = group
    try:
        _ensure_table()
        item = dict(group)
        item["speed"] = Decimal(str(item["speed"]))
        from app.services.db import get_dynamodb_resource
        get_dynamodb_resource().Table(TABLE).put_item(Item=item)
    except Exception:
        logger.exception("Could not save session group %s", group["group_id"])


def _normalise(group: dict) -> dict:
    group = dict(group)
    group["speed"] = float(group.get("speed", 1.0))
    group.setdefault("member_session_ids", [])
    group.setdefault("members", [])
    return group


def get_group(group_id: str, user_id: str) -> dict | None:
    cached = _groups.get(group_id)
    if cached:
        return cached if cached.get("user_id") == user_id else None
    try:
        _ensure_table()
        from app.services.db import get_dynamodb_resource
        item = get_dynamodb_resource().Table(TABLE).get_item(Key={"group_id": group_id}).get("Item")
        if item and item.get("user_id") == user_id:
            group = _normalise(item)
            _groups[group_id] = group
            return group
    except Exception:
        logger.exception("Could not load session group %s", group_id)
    return None


def get_active_group(user_id: str) -> dict | None:
    cached = [g for g in _groups.values() if g.get("user_id") == user_id and g.get("state") != "ended"]
    if cached:
        return max(cached, key=lambda g: g.get("updated_at", 0))
    try:
        _ensure_table()
        from boto3.dynamodb.conditions import Key
        from app.services.db import get_dynamodb_resource
        items = get_dynamodb_resource().Table(TABLE).query(
            IndexName="UserIdIndex", KeyConditionExpression=Key("user_id").eq(user_id)
        ).get("Items", [])
        active = [_normalise(x) for x in items if x.get("state") != "ended"]
        for group in active:
            _groups[group["group_id"]] = group
        return max(active, key=lambda g: g.get("updated_at", 0), default=None)
    except Exception:
        logger.exception("Could not find active session group for user %s", user_id)
        return None


def create_group(user_id: str, date: str, session_type: str, speed: float, strategy_interval_secs: int) -> dict:
    family = family_for(session_type)
    group = {
        "group_id": str(uuid.uuid4()), "user_id": user_id, "date": date,
        "clock_family": family, "state": "running", "speed": speed if family == "sim" else 1.0,
        "current_time": None, "strategy_interval_secs": strategy_interval_secs if family == "stepwise" else None,
        "member_session_ids": [], "members": [], "created_at": int(time.time() * 1000),
    }
    _save(group)
    logger.info("Created %s group %s for user %s", family, group["group_id"], user_id)
    return group


def validate_add(group: dict, *, date: str, session_type: str, speed: float, strategy_interval_secs: int,
                 symbol: str, instrument_type: str) -> None:
    if group["state"] == "ended":
        raise ValueError("This session group has ended")
    if group["date"] != date:
        raise ValueError("Added sessions must use the group's trading date")
    if group["clock_family"] != family_for(session_type):
        raise ValueError("Session type is incompatible with the active group")
    if group["clock_family"] == "sim" and float(group["speed"]) != float(speed):
        raise ValueError("Replay speed must match the active group")
    if group["clock_family"] == "stepwise" and group.get("strategy_interval_secs") != strategy_interval_secs:
        raise ValueError("Stepwise strategy interval must match the active group")
    if len(group["member_session_ids"]) >= MAX_MEMBERS:
        raise ValueError("A session group can have at most four active members")
    if any(m.get("symbol") == symbol and m.get("session_type") == session_type and
           m.get("instrument_type") == instrument_type for m in group.get("members", [])):
        raise ValueError("An identical symbol, session type, and instrument type is already active")


def add_member(group: dict, member: dict) -> dict:
    group["member_session_ids"].append(member["session_id"])
    group["members"].append(member)
    _save(group)
    return group


def remove_member(group: dict, session_id: str) -> None:
    group["member_session_ids"] = [sid for sid in group["member_session_ids"] if sid != session_id]
    group["members"] = [m for m in group.get("members", []) if m.get("session_id") != session_id]
    if not group["member_session_ids"]:
        group["state"] = "ended"
    _save(group)


def rename_member(group: dict, session_id: str, alias: str | None) -> dict:
    alias = alias.strip() if alias else None
    for member in group.get("members", []):
        if member.get("session_id") == session_id:
            member["session_alias"] = alias or None
            _save(group)
            return member
    raise ValueError("Session is not a member of this group")


def update_clock(group: dict, current_time: str | None = None, state: str | None = None) -> None:
    if current_time is not None:
        group["current_time"] = str(current_time)
    if state is not None:
        group["state"] = state
    _save(group)
