"""DynamoDB persistence for desktop screens and user/instrument drawings."""
from __future__ import annotations

import json
import logging
import uuid
from decimal import Decimal
from datetime import datetime, timezone

from boto3.dynamodb.conditions import Key

_SCREENS_TABLE = "DesktopScreens"
_DRAWINGS_TABLE = "DesktopDrawings"
_SETTINGS_TABLE = "DesktopChartSettings"
logger = logging.getLogger(__name__)


def _ensure_tables() -> None:
    from app.services.db import get_dynamodb_client, get_dynamodb_resource
    existing = set(get_dynamodb_resource().meta.client.list_tables()["TableNames"])
    client = get_dynamodb_client()
    for table in (_SCREENS_TABLE, _DRAWINGS_TABLE, _SETTINGS_TABLE):
        if table not in existing:
            client.create_table(
                TableName=table,
                KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}, {"AttributeName": "record_id", "KeyType": "RANGE"}],
                AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"}, {"AttributeName": "record_id", "AttributeType": "S"}],
                BillingMode="PAY_PER_REQUEST",
            )


def _table(name: str):
    _ensure_tables()
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table(name)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dynamodb_safe(value):
    """DynamoDB rejects Python float values decoded from desktop JSON."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _dynamodb_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_dynamodb_safe(item) for item in value]
    return value


def canonical_instrument_id(instrument: dict) -> str:
    """A stable cross-screen identity; interval and viewport never participate."""
    if instrument.get("kind") == "option":
        required = ("underlying", "expiry", "strike", "right", "exchange")
    else:
        required = ("kind", "symbol", "exchange")
    if any(instrument.get(field) in (None, "") for field in required):
        raise ValueError("Incomplete canonical instrument identity")
    return json.dumps(instrument, sort_keys=True, separators=(",", ":"))


def validate_drawing(drawing: dict) -> None:
    """Reject renderer/pixel-only drawings before they reach persistence."""
    if not isinstance(drawing.get("tool"), str) or not drawing["tool"]:
        raise ValueError("Drawing tool is required")
    points = drawing.get("points")
    if not isinstance(points, list) or not points:
        raise ValueError("Drawing must contain canonical timestamp-price points")
    for point in points:
        if not isinstance(point, dict) or not isinstance(point.get("timestamp"), int) or not isinstance(point.get("price"), (int, float)):
            raise ValueError("Every drawing point requires integer timestamp and numeric price")


def list_screens(user_id: str) -> list[dict]:
    records = _table(_SCREENS_TABLE).query(KeyConditionExpression=Key("user_id").eq(user_id)).get("Items", [])
    return sorted(records, key=lambda item: (item.get("order", 0), item["screen_id"]))


def create_screen(user_id: str, name: str, state: dict, mutation_id: str | None, order: int = 0, active: bool = False) -> dict:
    screen_id = str(uuid.uuid4())
    item = {"user_id": user_id, "record_id": screen_id, "screen_id": screen_id, "name": name, "state": state, "order": order, "active": active, "revision": 1, "mutation_id": mutation_id or str(uuid.uuid4()), "updated_at": _now()}
    _table(_SCREENS_TABLE).put_item(Item=item)
    return item


def update_screen(user_id: str, screen_id: str, name: str, state: dict, revision: int, mutation_id: str, order: int = 0, active: bool = False) -> dict | None:
    table = _table(_SCREENS_TABLE)
    existing = table.get_item(Key={"user_id": user_id, "record_id": screen_id}).get("Item")
    if not existing:
        return None
    if existing["revision"] != revision:
        raise ValueError("revision_conflict")
    item = {**existing, "name": name, "state": state, "order": order, "active": active, "revision": revision + 1, "mutation_id": mutation_id, "updated_at": _now()}
    table.put_item(Item=item, ConditionExpression="revision = :revision", ExpressionAttributeValues={":revision": revision})
    return item


def delete_screen(user_id: str, screen_id: str) -> bool:
    table = _table(_SCREENS_TABLE)
    existing = table.get_item(Key={"user_id": user_id, "record_id": screen_id}).get("Item")
    if not existing:
        return False
    table.delete_item(Key={"user_id": user_id, "record_id": screen_id})
    return True


def get_chart_settings(user_id: str) -> dict:
    """Per-user desktop display settings; no credentials are stored here."""
    item = _table(_SETTINGS_TABLE).get_item(Key={"user_id": user_id, "record_id": "chart"}).get("Item")
    logger.info("desktop chart settings loaded user_id=%s table=%s found=%s", user_id, _SETTINGS_TABLE, bool(item))
    return item or {"version": 1, "settings": {}, "revision": 0}


def save_chart_settings(user_id: str, settings: dict) -> dict:
    item = {"user_id": user_id, "record_id": "chart", "version": 1, "settings": _dynamodb_safe(settings), "updated_at": _now()}
    _table(_SETTINGS_TABLE).put_item(Item=item)
    logger.info("desktop chart settings saved user_id=%s table=%s record_id=chart keys=%s", user_id, _SETTINGS_TABLE, sorted(settings.keys()))
    return item


def list_drawings(user_id: str, instrument: dict, include_deleted: bool = False) -> list[dict]:
    instrument_id = canonical_instrument_id(instrument)
    records = _table(_DRAWINGS_TABLE).query(KeyConditionExpression=Key("user_id").eq(user_id)).get("Items", [])
    return [record for record in records if record["instrument_id"] == instrument_id and (include_deleted or not record.get("deleted", False))]


def create_drawing(user_id: str, instrument: dict, drawing: dict, mutation_id: str | None) -> dict:
    validate_drawing(drawing)
    drawing_id = str(uuid.uuid4())
    item = {"user_id": user_id, "record_id": drawing_id, "drawing_id": drawing_id, "instrument": instrument, "instrument_id": canonical_instrument_id(instrument), "drawing": drawing, "revision": 1, "mutation_id": mutation_id or str(uuid.uuid4()), "deleted": False, "updated_at": _now()}
    _table(_DRAWINGS_TABLE).put_item(Item=item)
    return item


def update_drawing(user_id: str, drawing_id: str, drawing: dict, revision: int, mutation_id: str, deleted: bool = False) -> dict | None:
    validate_drawing(drawing)
    table = _table(_DRAWINGS_TABLE)
    existing = table.get_item(Key={"user_id": user_id, "record_id": drawing_id}).get("Item")
    if not existing:
        return None
    if existing["revision"] != revision:
        raise ValueError("revision_conflict")
    item = {**existing, "drawing": drawing, "revision": revision + 1, "mutation_id": mutation_id, "deleted": deleted, "updated_at": _now()}
    table.put_item(Item=item, ConditionExpression="revision = :revision", ExpressionAttributeValues={":revision": revision})
    return item
