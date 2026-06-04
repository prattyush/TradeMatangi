"""
AIStrategies table — saved hotword strategies per user (persistent across sessions).

Schema:
  PK: user_id (S)
  SK: hotword (S)  — unique per user, enforced at write time
"""
import logging
from typing import Any

from db.dynamo import get_dynamodb_resource

logger = logging.getLogger("aihelper.db.strategies_store")

TABLE_NAME = "AIStrategies"


def _table():
    return get_dynamodb_resource().Table(TABLE_NAME)


def get_strategy(user_id: str, hotword: str) -> dict | None:
    resp = _table().get_item(Key={"user_id": user_id, "hotword": hotword})
    return resp.get("Item")


def put_strategy(item: dict[str, Any]) -> None:
    """Write a new strategy. Caller must check for duplicates first."""
    _table().put_item(Item=item)


def put_strategy_if_not_exists(item: dict[str, Any]) -> bool:
    """
    Write strategy only if hotword does not already exist for this user.
    Returns True on success, False if hotword already in use.
    """
    from botocore.exceptions import ClientError

    try:
        _table().put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(user_id) AND attribute_not_exists(hotword)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def list_strategies(user_id: str) -> list[dict]:
    resp = _table().query(
        KeyConditionExpression="user_id = :uid",
        ExpressionAttributeValues={":uid": user_id},
    )
    return resp.get("Items", [])


def delete_strategy(user_id: str, hotword: str) -> bool:
    """Delete a strategy. Returns True if it existed."""
    existing = get_strategy(user_id, hotword)
    if not existing:
        return False
    _table().delete_item(Key={"user_id": user_id, "hotword": hotword})
    return True


def increment_use_count(user_id: str, hotword: str, used_at: str) -> None:
    _table().update_item(
        Key={"user_id": user_id, "hotword": hotword},
        UpdateExpression="SET last_used_at = :ts ADD use_count :one",
        ExpressionAttributeValues={":ts": used_at, ":one": 1},
    )


def list_templates(user_id: str) -> list[dict]:
    """Return only template items (is_template=True) for the user."""
    return [i for i in list_strategies(user_id) if i.get("is_template")]


def get_template_by_hotword(user_id: str, hotword: str) -> dict | None:
    """Return a saved template for the given hotword, or None if not found / not a template."""
    item = get_strategy(user_id, hotword)
    return item if (item and item.get("is_template")) else None
