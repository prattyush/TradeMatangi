"""Cross-client persistence, legacy precedence and authenticated account actions."""
from copy import deepcopy
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient
from app.main import app
from app.services import user_settings_service as settings


@pytest.fixture
def store(monkeypatch):
    records = {}
    table = MagicMock()
    table.get_item.side_effect = lambda **kw: {"Item": deepcopy(records.get(kw["Key"]["user_id"], {}))}

    def update(**kw):
        item = records.setdefault(kw["Key"]["user_id"], {})
        names, values = kw["ExpressionAttributeNames"], kw["ExpressionAttributeValues"]
        if "ConditionExpression" in kw:
            key = names["#field"]
            if key in item:
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
            item[key] = deepcopy(values[":value"])
        else:
            for index, key in enumerate(names.values()):
                item[key] = deepcopy(values[f":v{index}"])
        return {}

    table.update_item.side_effect = update
    resource = MagicMock()
    resource.Table.return_value = table
    monkeypatch.setattr(settings, "_ensure_table", lambda: None)
    monkeypatch.setattr("app.services.db.get_dynamodb_resource", lambda: resource)
    return records, table


def test_both_clients_share_saved_values_and_do_not_materialize_defaults(store):
    records, table = store
    # Avoid lifespan seeding external services for this API-only test.
    client = TestClient(app)
    desktop = {"X-User-Id": "shared-user"}
    result = client.put("/api/desktop/v1/trading/settings/current", headers=desktop, json={"settings": {
        "strategy_interval_secs": 300, "brokerage_per_order": 2.5,
        "auto_start_event_snapshots": True, "trade_labeling_mode_by_type": {"stepwise": "off", "paper": "popup"},
    }})
    assert result.status_code == 200
    web = client.get("/api/users/settings", headers=desktop).json()
    assert web["strategy_interval_secs"] == 300 and web["brokerage_per_order"] == 2.5
    assert web["trade_labeling_mode_by_type"]["stepwise"] == "off"
    assert "autostop_trigger_type" not in records["shared-user"]
    assert records["shared-user"]["brokerage_per_order"] == Decimal("2.5")
    assert client.put("/api/users/settings", headers=desktop, json={"autostop_trigger_type": "deviation", "autostop_deviation_pct": 2.4}).status_code == 200
    other = client.get("/api/desktop/v1/trading/settings/current", headers=desktop).json()
    assert other["autostop_deviation_pct"] == 2.4 and other["strategy_interval_secs"] == 300
    assert client.get("/api/users/settings", headers={"X-User-Id": "another-user"}).json()["strategy_interval_secs"] == 180
    table.put_item.assert_not_called()


def test_import_preserves_desktop_first_values_and_imports_each_field_once(store):
    settings.update_settings("user", {"strategy_interval_secs": 300})
    first = settings.migrate_browser_settings("user", {"strategy_interval_secs": 120, "brokerage_per_order": 3})
    assert first["strategy_interval_secs"] == 300 and first["brokerage_per_order"] == 3
    settings.update_settings("user", {"brokerage_per_order": 5})
    second = settings.migrate_browser_settings("user", {"brokerage_per_order": 3})
    assert second["brokerage_per_order"] == 5


def test_unrelated_save_does_not_block_browser_import(store):
    settings.update_settings("user", {"historical_days": 4})
    result = settings.migrate_browser_settings("user", {"brokerage_per_order": 3, "auto_start_event_snapshots": True, "desktop_pnl_display_mode": "percent"})
    assert result["brokerage_per_order"] == 3 and result["auto_start_event_snapshots"] is True
    assert result["desktop_pnl_display_mode"] == "currency" and result["historical_days"] == 4


def test_settings_response_includes_previously_omitted_fields(store):
    settings.update_settings("user", {"default_sl_pct": .15})
    store[0]["user"]["fine_structure_share_emails"] = "A@example.com"
    result = TestClient(app).get("/api/users/settings", headers={"X-User-Id": "user"})
    assert result.json()["default_sl_pct"] == .15
    assert result.json()["fine_structure_share_emails"] == "a@example.com"


@pytest.mark.parametrize("field,value", [("strategy_interval_secs", 60), ("brokerage_per_order", -1), ("autostop_deviation_pct", 21), ("target_profit_buffer_ticks", 0), ("breakeven_mode", "invalid"), ("trade_labeling_mode_by_type", {"invalid": "off"}), ("default_sl_pct", .9)])
def test_web_and_desktop_use_same_validation(field, value):
    client = TestClient(app)
    assert client.put("/api/users/settings", json={field: value}).status_code == 422
    assert client.put("/api/desktop/v1/trading/settings/current", headers={"X-User-Id": "user"}, json={"settings": {field: value}}).status_code == 422


def test_strict_reads_and_failed_writes_do_not_appear_successful(store):
    _, table = store
    table.get_item.side_effect = RuntimeError("unavailable")
    with pytest.raises(RuntimeError):
        settings.get_settings("user", strict=True)
    assert settings.get_settings("user")["brokerage_per_order"] == 1
    with pytest.raises(RuntimeError):
        settings.update_settings("user", {"brokerage_per_order": 3})
    table.update_item.assert_not_called()
    table.get_item.side_effect = None
    table.get_item.return_value = {}
    table.update_item.side_effect = RuntimeError("unavailable")
    with pytest.raises(RuntimeError):
        settings.migrate_browser_settings("user", {"brokerage_per_order": 3})


def test_desktop_account_actions_require_identity():
    client = TestClient(app)
    for path in ("profile", "admin/tokens", "kotak/status"):
        assert client.get(f"/api/desktop/v1/settings/{path}").status_code == 401
    assert client.get("/api/desktop/v1/settings/profile", headers={"Authorization": "Bearer invalid"}).status_code == 401


def test_non_admin_cannot_use_admin_actions():
    client = TestClient(app)
    with patch("app.routers.admin.get_user_info", return_value={"is_admin": False}):
        headers = {"X-User-Id": "user"}
        assert client.get("/api/desktop/v1/settings/admin/tokens", headers=headers).status_code == 403
        assert client.put("/api/desktop/v1/settings/admin/stream-source", headers=headers, json={"source": "kite"}).status_code == 403
        assert client.delete("/api/desktop/v1/settings/admin/real-trading/whitelist/a@example.com", headers=headers).status_code == 403


def test_admin_tokens_masked_and_omitted_tokens_unchanged():
    client = TestClient(app)
    with patch("app.routers.admin.get_user_info", return_value={"is_admin": True}), patch("app.routers.admin.token_service.get_tokens_masked", return_value={"kite_access": "****1234"}), patch("app.routers.admin.token_service.set_token") as save:
        result = client.put("/api/desktop/v1/settings/admin/tokens", headers={"X-User-Id": "admin"}, json={"kite_access": "secret1234"})
    assert result.status_code == 200 and result.json()["kite_access"] == "****1234"
    save.assert_called_once_with("kite_access", "secret1234")


def test_broker_permission_checked_before_login():
    with patch("app.services.user_service.get_user_info", return_value={"is_admin": False}), patch("app.services.real_trading_service.is_whitelisted_user", return_value=False), patch("app.routers.kotak.kotak_login") as login:
        result = TestClient(app).post("/api/desktop/v1/settings/kotak/login", headers={"X-User-Id": "user"}, json={"totp": "123456"})
    assert result.status_code == 403
    login.assert_not_called()


def test_password_change_returns_empty_response_and_uses_desktop_identity():
    with patch("app.routers.auth.change_password", return_value=True) as save:
        result = TestClient(app).post("/api/desktop/v1/settings/change-password", headers={"X-User-Id": "desktop-user"}, json={"old_password": "old", "new_password": "newpassword"})
    assert result.status_code == 204 and not result.content
    save.assert_called_once_with("desktop-user", "old", "newpassword")


def test_sub_one_percent_risk_preserves_units_after_legacy_normalization(store):
    records, _ = store
    records["user"] = {"risk_ratio_l_pct": Decimal(".01"), "risk_ratio_m_pct": Decimal(".02"), "risk_ratio_h_pct": Decimal(".04")}
    assert settings.get_settings("user")["risk_ratio_m_pct"] == 2
    settings.update_settings("user", {"risk_ratio_l_pct": .25})
    result = settings.get_settings("user")
    assert result["risk_ratio_l_pct"] == .25 and result["risk_ratio_m_pct"] == 2
    assert records["user"]["risk_ratio_percentage_points"] is True


def test_labeling_updates_preserve_other_session_types(store):
    settings.update_settings("user", {"trade_labeling_mode_by_type": {"stepwise": "off"}})
    settings.update_settings("user", {"trade_labeling_mode_by_type": {"paper": "popup"}})
    result = settings.get_settings("user")["trade_labeling_mode_by_type"]
    assert result == {"stepwise": "off", "sim": "button", "paper": "popup", "real": "button"}
