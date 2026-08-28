"""
Fine Chart Structure service — CRUD over DynamoDB FineStructureDefinitions
and FineStructureFlows tables.

Definitions store structure names and their sub-types. Flows store per-day
ordered sequences of structures with transition bar timestamps.

Predefined definitions have user_id="__SYSTEM__", is_predefined=True.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from boto3.dynamodb.conditions import Key

logger = logging.getLogger(__name__)

DEFS_TABLE = "FineStructureDefinitions"
FLOWS_TABLE = "FineStructureFlows"
SHARE_TABLE = "FineStructureShares"

SYSTEM_USER = "__SYSTEM__"
_UUID_NS = uuid.UUID("a3f5c8e2-7b1d-4e9a-a6f0-123456789abc")

# ── Predefined definitions ───────────────────────────────────────────────────

PREDEFINED_DEFINITIONS: list[dict] = [
    {"name": "Trading Range",    "sub_types": ["broad", "narrow", "with_traps"]},
    {"name": "Channel",          "sub_types": ["tight", "broad"]},
    {"name": "Breakout",         "sub_types": ["breakout", "breakout_2nd_leg"]},
    {"name": "Reversal",         "sub_types": ["50_pct", "double_top", "head_and_shoulders"]},
    {"name": "Trend Resumption", "sub_types": ["strong", "weak"]},
    {"name": "Gap",              "sub_types": ["gap_up", "gap_down", "big_gap_up", "big_gap_down"]},
    {"name": "Opening",          "sub_types": ["within_range", "gap_up", "gap_down"]},
    {"name": "End",              "sub_types": []},
]

_seeded = False


# ── Table helpers ────────────────────────────────────────────────────────────

def _defs_table():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(DEFS_TABLE)


def _flows_table():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(FLOWS_TABLE)


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _deterministic_uuid(name: str) -> str:
    return str(uuid.uuid5(_UUID_NS, name))


# ── Sharing ──────────────────────────────────────────────────────────────────

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
        logger.exception("Failed to load fine structure share owners for %s", user_id)
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
        targets.append({"user_id": user["user_id"], "email": user.get("email", email)})
    if missing:
        raise ValueError(f"Unknown share email(s): {', '.join(missing)}")
    return targets


def sync_fine_structure_shares(owner_user_id: str, share_emails_csv: str) -> list[dict]:
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
                Key={"owner_user_id": item["owner_user_id"], "shared_user_id": item["shared_user_id"]}
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
        logger.exception("Failed to sync fine structure shares for owner %s", owner_user_id)
        raise
    return targets


# ── Seeding ──────────────────────────────────────────────────────────────────

def seed_predefined_definitions() -> None:
    global _seeded
    if _seeded:
        return
    try:
        resp = _defs_table().query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(SYSTEM_USER),
            Limit=1,
        )
        if resp.get("Items"):
            _seeded = True
            return
    except Exception:
        logger.exception("Failed to check predefined definitions")
        return

    now = _now_iso()
    for defn in PREDEFINED_DEFINITIONS:
        item = {
            "definition_id": _deterministic_uuid(defn["name"]),
            "user_id": SYSTEM_USER,
            "name": defn["name"],
            "sub_types": defn["sub_types"],
            "is_predefined": True,
            "created_at": now,
            "updated_at": now,
        }
        try:
            _defs_table().put_item(Item=item)
        except Exception:
            logger.exception("Failed to seed predefined definition: %s", defn["name"])
    _seeded = True
    logger.info("Seeded %d predefined fine structure definitions", len(PREDEFINED_DEFINITIONS))


# ── Definitions CRUD ─────────────────────────────────────────────────────────

def _item_to_def(item: dict, user_id: str) -> dict:
    return {
        "definition_id": item["definition_id"],
        "name": item["name"],
        "sub_types": item.get("sub_types", []),
        "is_predefined": item.get("is_predefined", False),
        "user_id": item["user_id"],
        "can_delete": item["user_id"] == user_id and not item.get("is_predefined", False),
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
    }


def _seed_user_definitions(user_id: str) -> None:
    """Copy predefined definitions to a user's own set on first access."""
    try:
        resp = _defs_table().query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
            Limit=1,
        )
        if resp.get("Items"):
            return  # user already has definitions
    except Exception:
        logger.exception("Failed to check user definitions for %s", user_id)
        return

    now = _now_iso()
    for defn in PREDEFINED_DEFINITIONS:
        item = {
            "definition_id": str(uuid.uuid4()),
            "user_id": user_id,
            "name": defn["name"],
            "sub_types": defn["sub_types"],
            "is_predefined": False,
            "created_at": now,
            "updated_at": now,
        }
        try:
            _defs_table().put_item(Item=item)
        except Exception:
            logger.exception("Failed to copy predefined definition for %s: %s", user_id, defn["name"])
    logger.info("Copied %d predefined definitions to user %s", len(PREDEFINED_DEFINITIONS), user_id)


# ── Definitions CRUD ─────────────────────────────────────────────────────────

def _item_to_def(item: dict, user_id: str) -> dict:
    return {
        "definition_id": item["definition_id"],
        "name": item["name"],
        "sub_types": item.get("sub_types", []),
        "is_predefined": item.get("is_predefined", False),
        "user_id": item["user_id"],
        "can_delete": item["user_id"] == user_id,
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
    }


def list_definitions(user_id: str) -> list[dict]:
    seed_predefined_definitions()
    _seed_user_definitions(user_id)
    owner_ids = _load_shared_owner_ids(user_id)
    items: list[dict] = []
    for uid in owner_ids:
        try:
            resp = _defs_table().query(
                IndexName="UserIdIndex",
                KeyConditionExpression=Key("user_id").eq(uid),
            )
            items.extend(resp.get("Items", []))
        except Exception:
            logger.exception("Failed to query definitions for %s", uid)

    seen: set[str] = set()
    result: list[dict] = []
    for item in items:
        did = item["definition_id"]
        if did in seen:
            continue
        seen.add(did)
        result.append(_item_to_def(item, user_id))
    result.sort(key=lambda d: (d["user_id"] != user_id, d["name"]))
    return result


def get_definition(user_id: str, definition_id: str) -> Optional[dict]:
    try:
        resp = _defs_table().get_item(Key={"definition_id": definition_id})
        item = resp.get("Item")
        if not item:
            return None
        return _item_to_def(item, user_id)
    except Exception:
        logger.exception("Failed to get definition %s", definition_id)
        return None


def create_definition(user_id: str, name: str, sub_types: list[str]) -> dict:
    now = _now_iso()
    item = {
        "definition_id": str(uuid.uuid4()),
        "user_id": user_id,
        "name": name,
        "sub_types": sub_types,
        "is_predefined": False,
        "created_at": now,
        "updated_at": now,
    }
    _defs_table().put_item(Item=item)
    return _item_to_def(item, user_id)


def update_definition(user_id: str, definition_id: str, name: str, sub_types: list[str]) -> Optional[dict]:
    existing = get_definition(user_id, definition_id)
    if not existing or existing["user_id"] != user_id:
        return None
    now = _now_iso()
    try:
        resp = _defs_table().update_item(
            Key={"definition_id": definition_id},
            UpdateExpression="SET #n = :name, sub_types = :st, updated_at = :ua",
            ExpressionAttributeNames={"#n": "name"},
            ExpressionAttributeValues={":name": name, ":st": sub_types, ":ua": now},
            ReturnValues="ALL_NEW",
        )
        return _item_to_def(resp["Attributes"], user_id)
    except Exception:
        logger.exception("Failed to update definition %s", definition_id)
        return None


def delete_definition(user_id: str, definition_id: str) -> bool:
    existing = get_definition(user_id, definition_id)
    if not existing or existing["user_id"] != user_id:
        return False
    try:
        _defs_table().delete_item(Key={"definition_id": definition_id})
        return True
    except Exception:
        logger.exception("Failed to delete definition %s", definition_id)
        return False


# ── Flows CRUD ───────────────────────────────────────────────────────────────

def _item_to_flow(item: dict, user_id: str) -> dict:
    return {
        "flow_id": item["flow_id"],
        "symbol": item["symbol"],
        "date": item["date"],
        "steps": item.get("steps", []),
        "user_id": item["user_id"],
        "can_delete": item["user_id"] == user_id,
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
    }


def list_flows(
    user_id: str,
    symbol: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> list[dict]:
    owner_ids = _load_shared_owner_ids(user_id)
    items: list[dict] = []
    for uid in owner_ids:
        try:
            resp = _flows_table().query(
                IndexName="UserIdIndex",
                KeyConditionExpression=Key("user_id").eq(uid),
            )
            items.extend(resp.get("Items", []))
        except Exception:
            logger.exception("Failed to list flows for %s", uid)

    result: list[dict] = []
    for item in items:
        if symbol and item.get("symbol") != symbol:
            continue
        d = item.get("date", "")
        if start_date and d < start_date:
            continue
        if end_date and d > end_date:
            continue
        result.append(_item_to_flow(item, user_id))
    result.sort(key=lambda f: f["date"], reverse=True)
    return result


def get_flow(user_id: str, flow_id: str) -> Optional[dict]:
    try:
        resp = _flows_table().get_item(Key={"flow_id": flow_id})
        item = resp.get("Item")
        if not item:
            return None
        return _item_to_flow(item, user_id)
    except Exception:
        logger.exception("Failed to get flow %s", flow_id)
        return None


def create_flow(user_id: str, symbol: str, date: str, steps: list[dict]) -> dict:
    now = _now_iso()
    item = {
        "flow_id": str(uuid.uuid4()),
        "user_id": user_id,
        "symbol": symbol,
        "date": date,
        "steps": steps,
        "created_at": now,
        "updated_at": now,
    }
    _flows_table().put_item(Item=item)
    return _item_to_flow(item, user_id)


def update_flow(user_id: str, flow_id: str, steps: list[dict]) -> Optional[dict]:
    existing = get_flow(user_id, flow_id)
    if not existing or existing["user_id"] != user_id:
        return None
    now = _now_iso()
    try:
        resp = _flows_table().update_item(
            Key={"flow_id": flow_id},
            UpdateExpression="SET steps = :steps, updated_at = :ua",
            ExpressionAttributeValues={":steps": steps, ":ua": now},
            ReturnValues="ALL_NEW",
        )
        return _item_to_flow(resp["Attributes"], user_id)
    except Exception:
        logger.exception("Failed to update flow %s", flow_id)
        return None


def delete_flow(user_id: str, flow_id: str) -> bool:
    existing = get_flow(user_id, flow_id)
    if not existing or existing["user_id"] != user_id:
        return False
    try:
        _flows_table().delete_item(Key={"flow_id": flow_id})
        return True
    except Exception:
        logger.exception("Failed to delete flow %s", flow_id)
        return False


# ── Search ───────────────────────────────────────────────────────────────────

def _step_matches(fstep: dict, qstep: dict) -> bool:
    if fstep.get("name") != qstep.get("name"):
        return False
    if qstep.get("type") and fstep.get("type") != qstep["type"]:
        return False
    if qstep.get("direction") and fstep.get("direction") != qstep["direction"]:
        return False
    return True


def _match_recursive(flow: list[dict], fi: int, query: list[dict], qi: int) -> bool:
    """Recursively match query[qi:] against flow[fi:]. Wildcard '*' matches 1+ steps."""
    if qi == len(query):
        return True
    if fi == len(flow):
        return False

    qstep = query[qi]
    if qstep.get("name") == "*":
        for match_len in range(1, len(flow) - fi + 1):
            if _match_recursive(flow, fi + match_len, query, qi + 1):
                return True
        return False

    if not _step_matches(flow[fi], qstep):
        return False
    return _match_recursive(flow, fi + 1, query, qi + 1)


def _matches_subsequence(flow_steps: list[dict], query_steps: list[dict]) -> Optional[int]:
    if not query_steps or not flow_steps:
        return None

    has_wildcard = any(q.get("name") == "*" for q in query_steps)

    if has_wildcard:
        for i in range(len(flow_steps)):
            if _match_recursive(flow_steps, i, query_steps, 0):
                return i
        return None

    qlen = len(query_steps)
    for i in range(len(flow_steps) - qlen + 1):
        if all(_step_matches(flow_steps[i + j], query_steps[j]) for j in range(qlen)):
            return i
    return None


def search_flows(
    user_id: str,
    query_steps: list[dict],
    symbol: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> list[dict]:
    all_flows = list_flows(user_id, symbol, start_date, end_date)
    results: list[dict] = []
    for flow in all_flows:
        idx = _matches_subsequence(flow["steps"], query_steps)
        if idx is not None:
            results.append({"flow": flow, "match_start_index": idx})
    return results
