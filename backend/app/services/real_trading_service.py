"""
Real trading whitelist service.

Manages access control for real (Kotak Neo) trading sessions.
Only users whose email or user_id appears in RealTradingWhitelist can start
a real session.

DynamoDB table: RealTradingWhitelist
  PK: email (string)
  Attributes: user_id (optional), added_at (ISO timestamp)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_TABLE = "RealTradingWhitelist"


def _ensure_table() -> None:
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        existing = set(get_dynamodb_resource().meta.client.list_tables()["TableNames"])
        if _TABLE in existing:
            return
        get_dynamodb_client().create_table(
            TableName=_TABLE,
            KeySchema=[{"AttributeName": "email", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "email", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        logger.info("Created %s table", _TABLE)
    except Exception:
        logger.exception("Failed to ensure %s table", _TABLE)


def get_whitelist() -> list[dict]:
    """Return all entries in the whitelist."""
    _ensure_table()
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table(_TABLE)
        resp = table.scan()
        return resp.get("Items", [])
    except Exception:
        logger.exception("Failed to scan %s", _TABLE)
        return []


def add_to_whitelist(email: str, user_id: str | None = None) -> dict:
    """Add an email to the whitelist. Idempotent."""
    _ensure_table()
    email = email.strip().lower()
    item: dict = {
        "email": email,
        "added_at": datetime.now(timezone.utc).isoformat(),
    }
    if user_id:
        item["user_id"] = user_id
    try:
        from app.services.db import get_dynamodb_resource
        get_dynamodb_resource().Table(_TABLE).put_item(Item=item)
    except Exception:
        logger.exception("Failed to add %s to whitelist", email)
        raise
    return item


def remove_from_whitelist(email: str) -> None:
    """Remove an email from the whitelist."""
    _ensure_table()
    email = email.strip().lower()
    try:
        from app.services.db import get_dynamodb_resource
        get_dynamodb_resource().Table(_TABLE).delete_item(Key={"email": email})
    except Exception:
        logger.exception("Failed to remove %s from whitelist", email)
        raise


def is_whitelisted_email(email: str) -> bool:
    """Return True if the given email is in the whitelist."""
    _ensure_table()
    email = email.strip().lower()
    try:
        from app.services.db import get_dynamodb_resource
        resp = get_dynamodb_resource().Table(_TABLE).get_item(Key={"email": email})
        return "Item" in resp
    except Exception:
        logger.exception("Failed to check whitelist for email %s", email)
        return False


def is_whitelisted_user(user_id: str) -> bool:
    """Return True if the given user_id belongs to a whitelisted email."""
    try:
        from app.services.user_service import get_user_info
        info = get_user_info(user_id)
        if not info:
            return False
        email = info.get("email", "")
        return is_whitelisted_email(email) if email else False
    except Exception:
        logger.exception("Failed to check whitelist for user_id %s", user_id)
        return False
