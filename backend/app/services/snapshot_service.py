"""
Event snapshot service: persists and retrieves trading session snapshots
captured on order events (placed, edited, converted).
"""
from __future__ import annotations

import logging
import json
from decimal import Decimal
from typing import Any

logger = logging.getLogger(__name__)

TABLE_NAME = "EventSnapshots"

_ENSURED = False


def _ensure_table() -> None:
    """Auto-create the EventSnapshots table if it doesn't exist."""
    global _ENSURED
    if _ENSURED:
        return
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        existing = set(get_dynamodb_resource().meta.client.list_tables()["TableNames"])
        if TABLE_NAME in existing:
            _ENSURED = True
            return
        get_dynamodb_client().create_table(
            TableName=TABLE_NAME,
            KeySchema=[
                {"AttributeName": "session_id", "KeyType": "HASH"},
                {"AttributeName": "event_id", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "session_id", "AttributeType": "S"},
                {"AttributeName": "event_id", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        _ENSURED = True
        logger.info("Created %s table", TABLE_NAME)
    except Exception:
        logger.exception("Failed to ensure %s table", TABLE_NAME)


class _DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def _table():
    _ensure_table()
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(TABLE_NAME)


def _decimalize(obj: Any) -> Any:
    """Recursively convert float values to Decimal for DDB compatibility."""
    if isinstance(obj, dict):
        return {k: _decimalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_decimalize(v) for v in obj]
    if isinstance(obj, float):
        return Decimal(str(obj))
    if obj is None:
        return None
    return obj


def save_snapshot(session_id: str, data: dict) -> str:
    """Persist a snapshot event. Returns the event_id."""
    event_id = data.get("event_id", "")
    try:
        item = {
            "session_id": session_id,
            "event_id": event_id,
        }
        for field in ("user_id", "symbol", "date", "instrument_type", "session_type"):
            if field in data and data[field] is not None:
                item[field] = str(data[field])

        if "timestamp" in data and data["timestamp"] is not None:
            item["timestamp"] = int(data["timestamp"])

        if "event" in data and data["event"] is not None:
            item["event_json"] = json.dumps(data["event"])
        if "snapshot" in data and data["snapshot"] is not None:
            item["snapshot_json"] = json.dumps(data["snapshot"], cls=_DecimalEncoder)

        _table().put_item(Item=item)
        logger.info("Saved snapshot %s for session %s (%s)", event_id, session_id,
                     data.get("event", {}).get("description", ""))
    except Exception:
        logger.exception("Failed to save snapshot %s for session %s", event_id, session_id)
    return event_id


def get_snapshots(session_id: str) -> list[dict]:
    """Return all snapshots for a session, sorted by event_id (chronological)."""
    try:
        resp = _table().query(
            KeyConditionExpression="session_id = :sid",
            ExpressionAttributeValues={":sid": session_id},
            ScanIndexForward=True,
        )
    except Exception:
        logger.exception("Failed to query snapshots for session %s", session_id)
        return []

    snapshots = []
    for item in resp.get("Items", []):
        snapshots.append(_deserialize(item))
    return snapshots


def get_snapshot(session_id: str, event_id: str) -> dict | None:
    """Return a single snapshot by session_id + event_id."""
    try:
        resp = _table().get_item(Key={"session_id": session_id, "event_id": event_id})
    except Exception:
        logger.exception("Failed to get snapshot %s/%s", session_id, event_id)
        return None

    item = resp.get("Item")
    if not item:
        return None
    return _deserialize(item)


def delete_snapshots(session_id: str) -> int:
    """Delete all snapshots for a session. Returns count deleted."""
    try:
        resp = _table().query(
            KeyConditionExpression="session_id = :sid",
            ExpressionAttributeValues={":sid": session_id},
            ProjectionExpression="session_id, event_id",
        )
    except Exception:
        logger.exception("Failed to query snapshots for deletion, session %s", session_id)
        return 0

    items = resp.get("Items", [])
    if not items:
        return 0

    from app.services.db import get_dynamodb_resource
    ddb = get_dynamodb_resource()

    with ddb.meta.client as client:
        # DDB batch_write_item can only handle 25 at a time
        batch = client.batch_write_item
        for i in range(0, len(items), 25):
            chunk = items[i:i + 25]
            delete_requests = [
                {"DeleteRequest": {"Key": {"session_id": sid, "event_id": eid}}}
                for sid, eid in ((it["session_id"], it["event_id"]) for it in chunk)
            ]
            try:
                client.batch_write_item(
                    RequestItems={TABLE_NAME: delete_requests}
                )
            except Exception:
                logger.exception("Failed to batch-delete snapshots for session %s", session_id)

    logger.debug("Deleted %d snapshots for session %s", len(items), session_id)
    return len(items)


def _deserialize(item: dict) -> dict:
    """Convert a DDB item back to the EventSnapshot dict shape."""
    result: dict = {
        "event_id": item.get("event_id", ""),
        "session_id": item.get("session_id", ""),
        "user_id": item.get("user_id", ""),
        "symbol": item.get("symbol", ""),
        "date": item.get("date", ""),
        "instrument_type": item.get("instrument_type", "equity"),
        "session_type": item.get("session_type", "sim"),
        "timestamp": int(item.get("timestamp", 0)),
    }
    if "event_json" in item:
        try:
            result["event"] = json.loads(item["event_json"])
        except json.JSONDecodeError:
            result["event"] = {}
    if "snapshot_json" in item:
        try:
            snap = json.loads(item["snapshot_json"])
            # Convert Decimal back to float for frontend consumption
            result["snapshot"] = _un_decimalize(snap)
        except json.JSONDecodeError:
            result["snapshot"] = {}
    return result


def _un_decimalize(obj: Any) -> Any:
    """Recursively convert Decimal values back to float for JSON serialization."""
    from decimal import Decimal as D
    if isinstance(obj, D):
        return float(obj)
    if isinstance(obj, dict):
        return {k: _un_decimalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_un_decimalize(v) for v in obj]
    return obj
