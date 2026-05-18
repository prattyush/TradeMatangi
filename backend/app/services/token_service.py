"""
Admin token service — stores daily-rotating broker tokens in DynamoDB.

BrokerTokens table schema: pk="config" (HASH), sk="icici_session"|"kite_access" (RANGE).
broker_service and kite_service read from here first, falling back to accesskeys.ini.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_TABLE = "BrokerTokens"


def _ensure_table() -> None:
    try:
        from app.services.db import get_dynamodb_resource, get_dynamodb_client
        existing = set(get_dynamodb_resource().meta.client.list_tables()["TableNames"])
        if _TABLE in existing:
            return
        get_dynamodb_client().create_table(
            TableName=_TABLE,
            KeySchema=[
                {"AttributeName": "pk", "KeyType": "HASH"},
                {"AttributeName": "sk", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "pk", "AttributeType": "S"},
                {"AttributeName": "sk", "AttributeType": "S"},
            ],
            BillingMode="PAY_PER_REQUEST",
        )
        logger.info("Created %s table", _TABLE)
    except Exception:
        logger.exception("Failed to ensure %s table", _TABLE)


def get_token(sk: str) -> str | None:
    """Return the full token value for the given key, or None if not set."""
    _ensure_table()
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table(_TABLE)
        resp = table.get_item(Key={"pk": "config", "sk": sk})
        item = resp.get("Item")
        return item["value"] if item else None
    except Exception:
        logger.exception("Failed to get token %s", sk)
        return None


def set_token(sk: str, value: str) -> None:
    """Store a token in DynamoDB with an updated_at timestamp."""
    _ensure_table()
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table(_TABLE)
        table.put_item(Item={
            "pk": "config",
            "sk": sk,
            "value": value,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        })
    except Exception:
        logger.exception("Failed to set token %s", sk)


def get_tokens_masked() -> dict[str, str | None]:
    """Return token values masked to last 4 chars for safe display."""
    result: dict[str, str | None] = {}
    for sk in ("icici_session", "kite_access"):
        val = get_token(sk)
        if val:
            result[sk] = ("*" * max(0, len(val) - 4)) + val[-4:]
        else:
            result[sk] = None
    return result
