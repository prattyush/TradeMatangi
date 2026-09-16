"""JWT access and hashed refresh-token lifecycle for desktop clients."""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

import jwt

from app.config import DESKTOP_ACCESS_TOKEN_MINUTES, DESKTOP_JWT_SECRET, DESKTOP_REFRESH_TOKEN_DAYS

logger = logging.getLogger(__name__)
_TABLE = "DesktopRefreshTokens"
_ISSUER = "tradematangi-desktop"


def _ensure_table() -> None:
    from app.services.db import get_dynamodb_client, get_dynamodb_resource
    if _TABLE in get_dynamodb_resource().meta.client.list_tables()["TableNames"]:
        return
    get_dynamodb_client().create_table(
        TableName=_TABLE, KeySchema=[{"AttributeName": "refresh_hash", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "refresh_hash", "AttributeType": "S"}], BillingMode="PAY_PER_REQUEST",
    )


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _access_token(user_id: str) -> tuple[str, int]:
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=DESKTOP_ACCESS_TOKEN_MINUTES)
    payload = {"sub": user_id, "iss": _ISSUER, "iat": now, "exp": expires, "jti": secrets.token_hex(16), "scope": "desktop:charts"}
    return jwt.encode(payload, DESKTOP_JWT_SECRET, algorithm="HS256"), int((expires - now).total_seconds())


def issue_token_bundle(user_id: str, device_name: str | None = None) -> dict:
    refresh_token = secrets.token_urlsafe(48)
    refresh_hash = _digest(refresh_token)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=DESKTOP_REFRESH_TOKEN_DAYS)
    _ensure_table()
    from app.services.db import get_dynamodb_resource
    get_dynamodb_resource().Table(_TABLE).put_item(Item={
        "refresh_hash": refresh_hash, "user_id": user_id, "device_name": device_name or "Trade Matangi Desktop",
        "created_at": now.isoformat(), "expires_at": expires.isoformat(), "revoked": False,
    })
    access_token, expires_in = _access_token(user_id)
    return {"access_token": access_token, "refresh_token": refresh_token, "token_type": "Bearer", "expires_in": expires_in}


def verify_access_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, DESKTOP_JWT_SECRET, algorithms=["HS256"], issuer=_ISSUER)
        return payload.get("sub") if payload.get("scope") == "desktop:charts" else None
    except jwt.PyJWTError:
        return None


def refresh_token_bundle(refresh_token: str) -> dict | None:
    _ensure_table()
    from app.services.db import get_dynamodb_resource
    table = get_dynamodb_resource().Table(_TABLE)
    item = table.get_item(Key={"refresh_hash": _digest(refresh_token)}).get("Item")
    if not item or item.get("revoked") or datetime.fromisoformat(item["expires_at"]) <= datetime.now(timezone.utc):
        return None
    table.update_item(Key={"refresh_hash": item["refresh_hash"]}, UpdateExpression="SET revoked = :revoked", ExpressionAttributeValues={":revoked": True})
    return issue_token_bundle(item["user_id"], item.get("device_name"))


def revoke_refresh_token(refresh_token: str) -> None:
    _ensure_table()
    from app.services.db import get_dynamodb_resource
    get_dynamodb_resource().Table(_TABLE).update_item(
        Key={"refresh_hash": _digest(refresh_token)}, UpdateExpression="SET revoked = :revoked", ExpressionAttributeValues={":revoked": True},
    )
