"""
User settings service — persists per-user preferences to DynamoDB.
"""
from __future__ import annotations

import logging
from decimal import Decimal

logger = logging.getLogger(__name__)

DEFAULT_SETTINGS: dict = {
    "real_execution_broker": "kotak",
    "brokerage_per_order": 1.0,
    "strategy_interval_secs": 180,
    "autostop_trigger_type": "bar",
    "autostop_deviation_pct": 1.0,
    "breakeven_mode": "shift_sl",
    "target_profit_buffer_ticks": 3,
    "aggr_sl_only_in_profit": False,
    "auto_start_event_snapshots": False,
    "trade_labeling_mode_by_type": {"stepwise": "popup", "sim": "button", "paper": "button", "real": "button"},
    "trading_roc_ratio_mode": "normalized",
    "historical_days": 2,
    "guardrail_block_bars": 3,
    "guardrail_cooldown_block_bars": 3,
    "guardrail_cooldown_losses": 3,
    "guardrail_ban_capital_pct": 10.0,
    "guardrail_ban_loss_trade_pct": 60.0,
    "guardrail_ban_min_trades": 5,
    "guardrail_ban_enabled": False,
    "guardrail_cooldown_enabled": False,
    "guardrail_maxsize_enabled": False,
    "guardrail_maxsize_mode": "percentage",
    "guardrail_maxsize_pct": 20.0,
    "guardrail_maxsize_value": 0.0,
    "funds_ratio_l_pct": 0.03,
    "funds_ratio_m_pct": 0.06,
    "funds_ratio_h_pct": 0.12,
    # Stored as percentage points: 1 means 1% of session capital.
    "risk_ratio_l_pct": 1.0,
    "risk_ratio_m_pct": 2.0,
    "risk_ratio_h_pct": 4.0,
    "default_sl_pct": 0.20,
    "context_menu_sl_mode": "longOnly",
    "analysis_price_source": "options",
    "experimental_patterns_enabled": False,
    "pattern_share_emails": "",
    "fine_structure_share_emails": "",
    "entry_auto_sl_enabled": True,
    "entry_auto_sl_delay_sec": 3,
    "kotak_automated_protection_enabled": True,
    "max_price_mode": "otm",
    "max_price_threshold_ce": 50.0,
    "max_price_threshold_pe": 50.0,
    "override_session_enabled": False,
    "desktop_hide_chart_labels": False,
    "desktop_order_size_mode": "quantity",
    "desktop_pnl_display_mode": "currency",
    "desktop_confirm_flatten": True,
    "target_deviation_pct": 0.01,
    "target_deviation_configured": False,
    "stoploss_limit_gap_pct": 0.015,
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


def _risk_percentage(value, default: float) -> float:
    """Return risk as percentage points, migrating legacy fractional values."""
    if value is None:
        return default
    parsed = float(value)
    # Treat values strictly below 1 as legacy fractions. A stored value of 1
    # is a valid new setting meaning exactly 1%.
    return parsed * 100 if 0 < parsed < 1 else parsed


def get_settings(user_id: str, *, strict: bool = False) -> dict:
    """Load preferences; UI callers use strict reads to distinguish errors from defaults."""
    from copy import deepcopy
    _ensure_table()
    try:
        from app.services.db import get_dynamodb_resource
        item = get_dynamodb_resource().Table("UserSettings").get_item(
            Key={"user_id": user_id}, ConsistentRead=True,
        ).get("Item", {})
        result = deepcopy(DEFAULT_SETTINGS)
        for key, default in DEFAULT_SETTINGS.items():
            if key == "entry_auto_sl_enabled":
                continue  # Retired switch: saved False values cannot disable entry protection.
            if key not in item:
                continue
            value = item[key]
            if isinstance(default, bool):
                result[key] = bool(value)
            elif isinstance(default, int):
                result[key] = int(value)
            elif isinstance(default, float):
                result[key] = float(value)
            elif isinstance(default, dict):
                result[key] = {**default, **value}
            else:
                result[key] = value
        for key in ("risk_ratio_l_pct", "risk_ratio_m_pct", "risk_ratio_h_pct"):
            result[key] = float(item.get(key, DEFAULT_SETTINGS[key])) if item.get("risk_ratio_percentage_points") else _risk_percentage(item.get(key), DEFAULT_SETTINGS[key])
        for key in ("pattern_share_emails", "fine_structure_share_emails"):
            result[key] = _normalize_share_emails_value(result[key])
        result["target_deviation_configured"] = bool(item.get("target_deviation_configured", "target_deviation_pct" in item))
        return result
    except Exception:
        logger.exception("Failed to get settings for user %s", user_id)
        if strict:
            raise
        return deepcopy(DEFAULT_SETTINGS)


def _dynamo_value(value):
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {key: _dynamo_value(item) for key, item in value.items()}
    return value


def _normalize_share_emails_value(value) -> str:
    if isinstance(value, list):
        raw = ",".join(str(v) for v in value)
    else:
        raw = str(value or "")
    emails: list[str] = []
    seen: set[str] = set()
    for part in raw.split(","):
        email = part.strip().lower()
        if not email or email in seen:
            continue
        seen.add(email)
        emails.append(email)
    return ", ".join(emails)


def update_settings(user_id: str, settings: dict) -> dict:
    """Merge settings into the user's record and return the updated settings."""
    import math
    settings = dict(settings)
    settings.pop("entry_auto_sl_enabled", None)  # Accept old clients without restoring the retired switch.
    for key in ("target_deviation_pct", "stoploss_limit_gap_pct"):
        if settings.get(key) is not None:
            value = float(settings[key])
            if not math.isfinite(value) or not 0 <= value <= 0.10:
                raise ValueError("Execution gaps must be between 0 and 10%")
            settings[key] = value
    _ensure_table()
    current = get_settings(user_id, strict=True)
    if settings.get("real_execution_broker") is not None:
        from app.dependencies import require_real_trading_access
        from app.services import execution_broker, real_sessions, simulation
        require_real_trading_access(user_id)
        selected = execution_broker.name(settings["real_execution_broker"])
        if selected != current['real_execution_broker'] and (real_sessions.active(user_id) or any(
                s.user_id == user_id and s.session_type == 'real' and s.state != simulation.SimulationState.ENDED
                for s in simulation._sessions.values())):
            from fastapi import HTTPException
            raise HTTPException(409, 'Close the current Real session before switching broker')
        settings['real_execution_broker'] = selected
    if settings.get("target_deviation_pct") is not None:
        current["target_deviation_configured"] = True
    updates = {k: v for k, v in settings.items() if v is not None and k != "target_deviation_configured"}
    if "trade_labeling_mode_by_type" in updates:
        updates["trade_labeling_mode_by_type"] = {**current["trade_labeling_mode_by_type"], **updates["trade_labeling_mode_by_type"]}
    current.update(updates)
    shares_updated = "pattern_share_emails" in settings
    fine_shares_updated = "fine_structure_share_emails" in settings
    if shares_updated:
        current["pattern_share_emails"] = _normalize_share_emails_value(current.get("pattern_share_emails", ""))
    if fine_shares_updated:
        current["fine_structure_share_emails"] = _normalize_share_emails_value(current.get("fine_structure_share_emails", ""))
    try:
        if shares_updated:
            from app.services import pattern_logger_service
            pattern_logger_service.sync_pattern_shares(user_id, current.get("pattern_share_emails", ""))
            try:
                from app.services import chart_structure_service
                chart_structure_service.sync_structure_shares(user_id, current.get("pattern_share_emails", ""))
            except Exception:
                logger.exception("Failed to sync chart structure shares, continuing")
        if fine_shares_updated:
            try:
                from app.services import fine_structure_service
                fine_structure_service.sync_fine_structure_shares(user_id, current.get("fine_structure_share_emails", ""))
            except Exception:
                logger.exception("Failed to sync fine structure shares, continuing")
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("UserSettings")
        changed = {key: current[key] for key, value in settings.items() if value is not None and key != "target_deviation_configured"}
        risk_keys = ("risk_ratio_l_pct", "risk_ratio_m_pct", "risk_ratio_h_pct")
        if any(key in changed for key in risk_keys):
            # Normalize legacy fractions once before recording new percentage-point values.
            changed.update({key: current[key] for key in risk_keys})
            changed["risk_ratio_percentage_points"] = True
        if "target_deviation_pct" in changed:
            changed["target_deviation_configured"] = True
        if changed:
            table.update_item(
                Key={"user_id": user_id},
                UpdateExpression="SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(changed))),
                ExpressionAttributeNames={f"#k{i}": key for i, key in enumerate(changed)},
                ExpressionAttributeValues={f":v{i}": _dynamo_value(value) for i, value in enumerate(changed.values())},
            )
    except ValueError:
        raise
    except Exception:
        logger.exception("Failed to update settings for user %s", user_id)
        raise
    if 'kotak_automated_protection_enabled' in updates:
        from app.services.kotak_automation_policy import apply
        apply(user_id, current['kotak_automated_protection_enabled'])
    return current


def migrate_target_gap(user_id: str, gap: float) -> dict:
    """Import a legacy browser value only if no target gap was explicitly saved."""
    from app.services.db import get_dynamodb_resource
    from botocore.exceptions import ClientError
    from app.models.schemas import UserSettingsUpdateRequest
    gap = UserSettingsUpdateRequest(target_deviation_pct=gap).target_deviation_pct
    _ensure_table()
    try:
        get_dynamodb_resource().Table("UserSettings").update_item(
            Key={"user_id": user_id},
            UpdateExpression="SET target_deviation_pct = :gap, target_deviation_configured = :yes",
            ConditionExpression="(attribute_not_exists(target_deviation_pct) AND attribute_not_exists(target_deviation_configured)) OR target_deviation_configured = :no",
            ExpressionAttributeValues={":gap": Decimal(str(gap)), ":yes": True, ":no": False},
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    return get_settings(user_id, strict=True)


LEGACY_BROWSER_FIELDS = frozenset({
    "brokerage_per_order", "strategy_interval_secs", "autostop_trigger_type",
    "autostop_deviation_pct", "breakeven_mode", "target_profit_buffer_ticks",
    "aggr_sl_only_in_profit", "auto_start_event_snapshots",
    "trade_labeling_mode_by_type", "trading_roc_ratio_mode",
})


def migrate_browser_settings(user_id: str, values: dict) -> dict:
    """Import each browser preference once; an explicit backend save always wins."""
    from botocore.exceptions import ClientError
    from app.services.db import get_dynamodb_resource
    from app.models.schemas import UserSettingsUpdateRequest
    values = UserSettingsUpdateRequest(**values).model_dump(exclude_none=True)
    _ensure_table()
    table = get_dynamodb_resource().Table("UserSettings")
    for key, value in values.items():
        if key not in LEGACY_BROWSER_FIELDS:
            continue
        try:
            table.update_item(
                Key={"user_id": user_id}, UpdateExpression="SET #field = :value",
                ConditionExpression="attribute_not_exists(#field)",
                ExpressionAttributeNames={"#field": key},
                ExpressionAttributeValues={":value": _dynamo_value(value)},
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    return get_settings(user_id, strict=True)
