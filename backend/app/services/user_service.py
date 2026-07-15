"""
User service: email/password authentication with bcrypt hashing.
Phase V adds proper login/register; the FIXED_USER_ID seed remains for
backward-compat with existing sessions in DynamoDB Local.
"""
from __future__ import annotations

import logging
import uuid
import httpx

logger = logging.getLogger(__name__)

from app.config import FIXED_USER_ID

_SEED_EMAIL = "admin@tradematangi.com"
_SEED_PASSWORD = "admin123"
_SEED_ACCOUNT_NAME = "Admin"


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
                "account_name": _SEED_ACCOUNT_NAME,
            })
            logger.info("Seeded default user: %s", _SEED_EMAIL)
        else:
            item = resp["Item"]
            updated = False
            update_expr_parts = []
            expr_vals = {}
            if not item.get("is_admin"):
                update_expr_parts.append("is_admin = :adm")
                expr_vals[":adm"] = True
                updated = True
            if not item.get("account_name"):
                update_expr_parts.append("account_name = :an")
                expr_vals[":an"] = _SEED_ACCOUNT_NAME
                updated = True
            if updated:
                table.update_item(
                    Key={"user_id": FIXED_USER_ID},
                    UpdateExpression="SET " + ", ".join(update_expr_parts),
                    ExpressionAttributeValues=expr_vals,
                )
                logger.info("Backfilled admin user fields")
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


def register_user(email: str, password: str, account_name: str | None = None) -> dict:
    """
    Create a new user. Raises ValueError if email already exists.
    Returns {user_id, email, account_name}.
    """
    email = email.strip().lower()
    existing = _find_by_email(email)
    if existing:
        raise ValueError("Email already registered")
    user_id = str(uuid.uuid4())
    hashed = _hash_password(password)
    item: dict = {
        "user_id": user_id,
        "email": email,
        "password_hash": hashed,
    }
    if account_name:
        item["account_name"] = account_name
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        table.put_item(Item=item)
    except Exception:
        logger.exception("DynamoDB write failed for new user %s", email)
        raise RuntimeError("Could not persist user")
    return {"user_id": user_id, "email": email, "account_name": account_name}


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
        "account_name": user.get("account_name"),
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


def _get_google_client_id() -> str:
    """Read Google Sign-In client_id from data/accesskeys.ini [googlesignin] section."""
    import configparser
    from pathlib import Path
    ini_path = Path(__file__).resolve().parent.parent.parent.parent / "data" / "accesskeys.ini"
    cfg = configparser.ConfigParser()
    cfg.read(str(ini_path))
    return cfg.get("googlesignin", "client_id", fallback="")


def google_auth(id_token: str, account_name: str | None = None) -> dict | None:
    """
    Verify Google ID token, then match or create user by email.
    
    If user with that email already exists → return login result.
    If new email:
      - Requires account_name (for new account creation)
      - Creates user record with google_sub, no password_hash
    Returns {user_id, email, is_admin, account_name} or None on invalid token.
    """
    client_id = _get_google_client_id()
    if not client_id:
        logger.error("Google Sign-In client_id not configured in accesskeys.ini")
        return None

    try:
        verify_url = f"https://oauth2.googleapis.com/tokeninfo?id_token={id_token}"
        resp = httpx.get(verify_url, timeout=10)
        if resp.status_code != 200:
            logger.warning("Google token verification failed: %s", resp.text[:200])
            return None
        payload = resp.json()
    except Exception:
        logger.exception("Google token verification request failed")
        return None

    if payload.get("aud") != client_id:
        logger.warning("Google token audience mismatch: %s", payload.get("aud"))
        return None

    email = (payload.get("email") or "").strip().lower()
    if not email:
        logger.warning("Google token missing email")
        return None

    google_sub = payload.get("sub")
    google_name = payload.get("name", "")

    existing = _find_by_email(email)
    if existing:
        # Existing user → login (optionally backfill google_sub and account_name)
        user_id = existing["user_id"]
        try:
            from app.services.db import get_dynamodb_resource
            table = get_dynamodb_resource().Table("Users")
            updates = []
            expr_vals = {}
            if google_sub and not existing.get("google_sub"):
                updates.append("google_sub = :gs")
                expr_vals[":gs"] = google_sub
            if not existing.get("account_name"):
                updates.append("account_name = :an")
                expr_vals[":an"] = google_name or email.split("@")[0]
            if updates:
                table.update_item(
                    Key={"user_id": user_id},
                    UpdateExpression="SET " + ", ".join(updates),
                    ExpressionAttributeValues=expr_vals,
                )
        except Exception:
            logger.exception("Failed to backfill Google fields for %s", user_id)

        return {
            "user_id": user_id,
            "email": existing["email"],
            "is_admin": bool(existing.get("is_admin", False)),
            "account_name": existing.get("account_name", google_name or email.split("@")[0]),
        }

    # New user — require account_name
    if not account_name:
        return None  # caller should prompt for account name then retry

    user_id = str(uuid.uuid4())
    item: dict = {
        "user_id": user_id,
        "email": email,
        "account_name": account_name,
    }
    if google_sub:
        item["google_sub"] = google_sub

    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        table.put_item(Item=item)
    except Exception:
        logger.exception("DynamoDB write failed for Google user %s", email)
        raise RuntimeError("Could not persist user")

    logger.info("Google signup: user_id=%s email=%s name=%s", user_id, email, account_name)
    return {
        "user_id": user_id,
        "email": email,
        "is_admin": False,
        "account_name": account_name,
    }


def set_account_name(user_id: str, account_name: str) -> dict | None:
    """Set the account_name for an existing user. Returns updated user info or None."""
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Users")
        table.update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET account_name = :an",
            ExpressionAttributeValues={":an": account_name},
        )
    except Exception:
        logger.exception("Failed to set account_name for %s", user_id)
        return None
    info = get_user_info(user_id)
    if not info:
        return None
    return {
        "user_id": info["user_id"],
        "email": info["email"],
        "is_admin": bool(info.get("is_admin", False)),
        "account_name": info.get("account_name"),
    }
