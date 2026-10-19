"""Admin opt-in for Real book restrictions. Hot paths read memory, never DynamoDB."""
import asyncio
import logging
import time
import threading

from pydantic import BaseModel, StrictBool

logger = logging.getLogger(__name__)
KEY = {"user_id": "__real_broker_admin__", "ledger_id": "session-restrictions"}
_enabled = False
_loaded = False
_lock = threading.RLock()


class Policy(BaseModel):
    enabled: StrictBool = False


def enabled():
    return _enabled


def enforce(session):
    return enabled() and getattr(session, "real_broker_restrictions_enabled", True)


def refresh():
    global _enabled, _loaded
    with _lock:
        from app.services.swing_funding_store import _table
        row = _table().get_item(Key=KEY, ConsistentRead=True).get("Item", {})
        _enabled = row.get("enabled") is True
        _loaded = True
        return Policy(enabled=_enabled)


async def ensure_loaded():
    if not _loaded:
        await asyncio.to_thread(refresh)


def save(value):
    global _enabled, _loaded
    with _lock:
        from app.services.swing_funding_store import _table
        _table().put_item(Item={**KEY, "enabled": value.enabled, "updated_at": int(time.time())})
        _enabled, _loaded = value.enabled, True
        return value
