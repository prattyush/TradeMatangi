"""
User service: single hardcoded user for Phase III.
Seeds the Users DynamoDB table on startup.
In Phase IV, replace get_user_id() with JWT token validation.
"""
from __future__ import annotations

import logging

from app.config import FIXED_USER_ID

logger = logging.getLogger(__name__)

HARDCODED_USERNAME = "abc123"
HARDCODED_PASSWORD = "abc123"


def seed_user() -> None:
    """Write the hardcoded user to DynamoDB if not already present. Swallows failures."""
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        # Idempotent: put_item overwrites but the data is the same
        table.put_item(Item={
            "user_id": FIXED_USER_ID,
            "username": HARDCODED_USERNAME,
            "password_hash": HARDCODED_PASSWORD,
        })
        logger.info("User seeded: %s (%s)", HARDCODED_USERNAME, FIXED_USER_ID)
    except Exception:
        logger.exception("Failed to seed user — DynamoDB may not be available yet")


def get_user_id() -> str:
    """Return the current user's UUID. Hardcoded for Phase III; JWT in Phase IV."""
    return FIXED_USER_ID
