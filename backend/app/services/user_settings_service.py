"""
User settings service — persists per-user preferences to DynamoDB.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

DEFAULT_SETTINGS: dict = {
    "historical_days": 2,
    "guardrail_block_bars": 3,
    "guardrail_cooldown_block_bars": 3,
    "guardrail_cooldown_losses": 3,
    "guardrail_ban_capital_pct": 10.0,
    "guardrail_ban_loss_trade_pct": 60.0,
    "guardrail_ban_min_trades": 5,
    "guardrail_ban_enabled": False,
    "guardrail_cooldown_enabled": False,
    "funds_ratio_l_pct": 0.03,
    "funds_ratio_m_pct": 0.06,
    "funds_ratio_h_pct": 0.12,
    "analysis_price_source": "options",
    "experimental_patterns_enabled": False,
}


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
            "guardrail_block_bars": int(item.get("guardrail_block_bars", DEFAULT_SETTINGS["guardrail_block_bars"])),
            "guardrail_cooldown_block_bars": int(item.get("guardrail_cooldown_block_bars", DEFAULT_SETTINGS["guardrail_cooldown_block_bars"])),
            "guardrail_cooldown_losses": int(item.get("guardrail_cooldown_losses", DEFAULT_SETTINGS["guardrail_cooldown_losses"])),
            "guardrail_ban_capital_pct": float(item.get("guardrail_ban_capital_pct", DEFAULT_SETTINGS["guardrail_ban_capital_pct"])),
            "guardrail_ban_loss_trade_pct": float(item.get("guardrail_ban_loss_trade_pct", DEFAULT_SETTINGS["guardrail_ban_loss_trade_pct"])),
            "guardrail_ban_min_trades": int(item.get("guardrail_ban_min_trades", DEFAULT_SETTINGS["guardrail_ban_min_trades"])),
            "guardrail_ban_enabled": bool(item.get("guardrail_ban_enabled", DEFAULT_SETTINGS["guardrail_ban_enabled"])),
            "guardrail_cooldown_enabled": bool(item.get("guardrail_cooldown_enabled", DEFAULT_SETTINGS["guardrail_cooldown_enabled"])),
            "funds_ratio_l_pct": float(item.get("funds_ratio_l_pct", DEFAULT_SETTINGS["funds_ratio_l_pct"])),
            "funds_ratio_m_pct": float(item.get("funds_ratio_m_pct", DEFAULT_SETTINGS["funds_ratio_m_pct"])),
            "funds_ratio_h_pct": float(item.get("funds_ratio_h_pct", DEFAULT_SETTINGS["funds_ratio_h_pct"])),
            "analysis_price_source": str(item.get("analysis_price_source", DEFAULT_SETTINGS["analysis_price_source"])),
            "experimental_patterns_enabled": bool(item.get("experimental_patterns_enabled", DEFAULT_SETTINGS["experimental_patterns_enabled"])),
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
