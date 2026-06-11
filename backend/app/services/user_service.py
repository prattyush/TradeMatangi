"""
User service: email/password authentication with bcrypt hashing.
Phase V adds proper login/register; the FIXED_USER_ID seed remains for
backward-compat with existing sessions in DynamoDB Local.
"""
from __future__ import annotations

import logging
import uuid

logger = logging.getLogger(__name__)

from app.config import FIXED_USER_ID

_SEED_EMAIL = "admin@tradematangi.com"
_SEED_PASSWORD = "admin123"


def _hash_password(password: str) -> str:
    import bcrypt
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def _check_password(password: str, hashed: str) -> bool:
    import bcrypt
    return bcrypt.checkpw(password.encode(), hashed.encode())


def seed_user() -> None:
    """Write the default admin user to DynamoDB on startup (idempotent)."""
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        resp = table.get_item(Key={"user_id": FIXED_USER_ID})
        if "Item" not in resp:
            table.put_item(Item={
                "user_id": FIXED_USER_ID,
                "email": _SEED_EMAIL,
                "password_hash": _hash_password(_SEED_PASSWORD),
                "is_admin": True,
            })
            logger.info("Seeded default user: %s", _SEED_EMAIL)
        elif not resp["Item"].get("is_admin"):
            # One-time migration: backfill is_admin on existing admin record
            table.update_item(
                Key={"user_id": FIXED_USER_ID},
                UpdateExpression="SET is_admin = :v",
                ExpressionAttributeValues={":v": True},
            )
            logger.info("Backfilled is_admin=True on admin user")
    except Exception:
        logger.exception("Failed to seed user — DynamoDB may not be available yet")


def get_user_by_email(email: str) -> dict | None:
    """Lookup a user by email using the Users.EmailIndex GSI."""
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        table = get_dynamodb_resource().Table("Users")
        resp = table.query(
            IndexName="EmailIndex",
            KeyConditionExpression=Key("email").eq(email.strip().lower()),
        )
        items = resp.get("Items", [])
        return items[0] if items else None
    except Exception:
        logger.exception("DynamoDB email lookup failed")
        return None


def _find_by_email(email: str) -> dict | None:
    """Backward-compatible wrapper around the indexed email lookup."""
    return get_user_by_email(email)


def register_user(email: str, password: str) -> dict:
    """
    Create a new user. Raises ValueError if email already exists.
    Returns {user_id, email}.
    """
    email = email.strip().lower()
    existing = _find_by_email(email)
    if existing:
        raise ValueError("Email already registered")
    user_id = str(uuid.uuid4())
    hashed = _hash_password(password)
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        table.put_item(Item={
            "user_id": user_id,
            "email": email,
            "password_hash": hashed,
        })
    except Exception:
        logger.exception("DynamoDB write failed for new user %s", email)
        raise RuntimeError("Could not persist user")
    return {"user_id": user_id, "email": email}


def get_user_info(user_id: str) -> dict | None:
    """Return user record by user_id, or None if not found."""
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        resp = table.get_item(Key={"user_id": user_id})
        return resp.get("Item")
    except Exception:
        logger.exception("Failed to get user info for %s", user_id)
        return None


def login_user(email: str, password: str) -> dict | None:
    """
    Validate email/password. Returns {user_id, email, is_admin} on success, None on failure.
    """
    user = _find_by_email(email.strip().lower())
    if not user:
        return None
    if not _check_password(password, user.get("password_hash", "")):
        return None
    return {
        "user_id": user["user_id"],
        "email": user["email"],
        "is_admin": bool(user.get("is_admin", False)),
    }


def change_password(user_id: str, old_password: str, new_password: str) -> bool:
    """
    Update password after verifying old_password. Returns False if user not found
    or old_password is wrong.
    """
    user = get_user_info(user_id)
    if not user or not _check_password(old_password, user.get("password_hash", "")):
        return False
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET password_hash = :h",
            ExpressionAttributeValues={":h": _hash_password(new_password)},
        )
    except Exception:
        logger.exception("DynamoDB update failed when changing password for %s", user_id)
        raise RuntimeError("Could not update password")
    return True


def get_user_id() -> str:
    """Return the fixed user UUID. Kept for backward compat."""
    return FIXED_USER_ID
