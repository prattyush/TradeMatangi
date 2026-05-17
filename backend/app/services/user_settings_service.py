"""
User settings service — persists per-user preferences to DynamoDB.
Currently stores: historical_days (how many prior trading days to show in charts).
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

DEFAULT_SETTINGS: dict = {"historical_days": 2}


def _ensure_table() -> None:
    """Create UserSettings table if it doesn't exist (DynamoDB Local only)."""
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        existing = set(get_dynamodb_resource().meta.client.list_tables()["TableNames"])
        if "UserSettings" in existing:
            return
        client = get_dynamodb_client()
        client.create_table(
            TableName="UserSettings",
            KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        logger.info("Created UserSettings table")
    except Exception:
        logger.exception("Failed to ensure UserSettings table")


def get_settings(user_id: str) -> dict:
    """Return user settings, falling back to defaults if not found."""
    _ensure_table()
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("UserSettings")
        resp = table.get_item(Key={"user_id": user_id})
        item = resp.get("Item")
        if not item:
            return dict(DEFAULT_SETTINGS)
        return {
            "historical_days": int(item.get("historical_days", DEFAULT_SETTINGS["historical_days"])),
        }
    except Exception:
        logger.exception("Failed to get settings for user %s", user_id)
        return dict(DEFAULT_SETTINGS)


def update_settings(user_id: str, settings: dict) -> dict:
    """Merge settings into the user's record and return the updated settings."""
    _ensure_table()
    current = get_settings(user_id)
    current.update({k: v for k, v in settings.items() if v is not None})
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("UserSettings")
        table.put_item(Item={"user_id": user_id, **current})
    except Exception:
        logger.exception("Failed to update settings for user %s", user_id)
    return current
