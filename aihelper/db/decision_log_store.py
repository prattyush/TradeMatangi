"""
AIDecisionLog table — LLM action decisions (shown in chat).

Schema:
  PK: session_id (S)
  SK: ts_command_id (S)  — "{ISO_timestamp}#{command_id}" (sortable)
TTL: 7 days via ttl_epoch attribute (DynamoDB TTL must be enabled on the table).
"""
import logging
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

from db.dynamo import get_dynamodb_resource

logger = logging.getLogger("aihelper.db.decision_log_store")

TABLE_NAME = "AIDecisionLog"
TTL_DAYS = 7


def _table():
    return get_dynamodb_resource().Table(TABLE_NAME)


def _ttl_epoch() -> int:
    return int((datetime.now(timezone.utc) + timedelta(days=TTL_DAYS)).timestamp())


def _floats_to_decimal(obj: Any) -> Any:
    """Recursively convert float values to Decimal for DynamoDB compatibility."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _floats_to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_floats_to_decimal(v) for v in obj]
    return obj


def write_decision(item: dict[str, Any]) -> None:
    """Write a decision log entry. Caller supplies session_id, ts_command_id, etc."""
    item.setdefault("ttl_epoch", _ttl_epoch())
    _table().put_item(Item=_floats_to_decimal(item))


def get_decisions_since(session_id: str, since_ts: str | None = None) -> list[dict]:
    """
    Query all decisions for a session, optionally filtered by timestamp > since_ts.
    since_ts is an ISO timestamp string; SK format "{ISO}#{command_id}" enables range filter.
    """
    kwargs: dict[str, Any] = {
        "KeyConditionExpression": "session_id = :sid",
        "ExpressionAttributeValues": {":sid": session_id},
        "ScanIndexForward": True,  # oldest first
    }

    if since_ts:
        kwargs["KeyConditionExpression"] += " AND ts_command_id > :since"
        kwargs["ExpressionAttributeValues"][":since"] = since_ts

    resp = _table().query(**kwargs)
    return resp.get("Items", [])
