"""
Tests for user_settings_service and GET/PUT /api/users/settings endpoints.
"""
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.services import user_settings_service as svc

client = TestClient(app)

FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"


def _mock_db(item: dict | None = None):
    """Return a mock dynamodb resource whose Table().get_item returns item."""
    mock_resource = MagicMock()
    mock_table = MagicMock()
    mock_resource.Table.return_value = mock_table
    if item is None:
        mock_table.get_item.return_value = {}
    else:
        mock_table.get_item.return_value = {"Item": item}
    # list_tables needed by _ensure_table
    mock_resource.meta.client.list_tables.return_value = {"TableNames": ["UserSettings"]}
    return mock_resource, mock_table


# ── user_settings_service unit tests ─────────────────────────────────────────

class TestGetSettings:
    def test_returns_defaults_when_not_found(self):
        mock_resource, _ = _mock_db(None)
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = svc.get_settings("user-123")
        assert result["historical_days"] == 2

    def test_returns_stored_value(self):
        mock_resource, _ = _mock_db({"user_id": "user-123", "historical_days": 4})
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = svc.get_settings("user-123")
        assert result["historical_days"] == 4

    def test_missing_field_uses_default(self):
        mock_resource, _ = _mock_db({"user_id": "user-123"})  # no historical_days
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = svc.get_settings("user-123")
        assert result["historical_days"] == 2

    def test_db_error_returns_defaults(self):
        mock_resource = MagicMock()
        mock_resource.Table.side_effect = RuntimeError("DB unreachable")
        mock_resource.meta.client.list_tables.return_value = {"TableNames": ["UserSettings"]}
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = svc.get_settings("user-123")
        assert result["historical_days"] == 2


class TestUpdateSettings:
    def test_stores_and_returns_updated(self):
        mock_resource, mock_table = _mock_db({"user_id": "user-123", "historical_days": 2})
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = svc.update_settings("user-123", {"historical_days": 5})
        assert result["historical_days"] == 5
        mock_table.put_item.assert_called_once()

    def test_creates_when_not_found(self):
        mock_resource, mock_table = _mock_db(None)
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = svc.update_settings("user-123", {"historical_days": 3})
        assert result["historical_days"] == 3
        mock_table.put_item.assert_called_once()

    def test_merges_with_existing(self):
        existing = {"user_id": "user-123", "historical_days": 2}
        mock_resource, mock_table = _mock_db(existing)
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = svc.update_settings("user-123", {"historical_days": 4})
        assert result["historical_days"] == 4

    def test_default_settings_constant(self):
        assert svc.DEFAULT_SETTINGS["historical_days"] == 2


# ── API endpoint tests ────────────────────────────────────────────────────────

class TestUserSettingsEndpoints:
    def test_get_settings_returns_defaults(self):
        with patch("app.services.user_settings_service.get_settings", return_value={"historical_days": 2}):
            resp = client.get("/api/users/settings")
        assert resp.status_code == 200
        assert resp.json()["historical_days"] == 2

    def test_get_settings_returns_stored(self):
        with patch("app.services.user_settings_service.get_settings", return_value={"historical_days": 4}):
            resp = client.get("/api/users/settings")
        assert resp.status_code == 200
        assert resp.json()["historical_days"] == 4

    def test_put_settings_valid(self):
        with patch("app.services.user_settings_service.update_settings", return_value={"historical_days": 3}) as mock_fn:
            resp = client.put("/api/users/settings", json={"historical_days": 3})
        assert resp.status_code == 200
        assert resp.json()["historical_days"] == 3
        mock_fn.assert_called_once_with(FIXED_USER_ID, {"historical_days": 3})

    def test_put_settings_out_of_range_low(self):
        resp = client.put("/api/users/settings", json={"historical_days": 0})
        assert resp.status_code == 422

    def test_put_settings_out_of_range_high(self):
        resp = client.put("/api/users/settings", json={"historical_days": 6})
        assert resp.status_code == 422

    def test_put_settings_boundary_1(self):
        with patch("app.services.user_settings_service.update_settings", return_value={"historical_days": 1}):
            resp = client.put("/api/users/settings", json={"historical_days": 1})
        assert resp.status_code == 200
        assert resp.json()["historical_days"] == 1

    def test_put_settings_boundary_5(self):
        with patch("app.services.user_settings_service.update_settings", return_value={"historical_days": 5}):
            resp = client.put("/api/users/settings", json={"historical_days": 5})
        assert resp.status_code == 200
        assert resp.json()["historical_days"] == 5

    def test_get_route_exists(self):
        with patch("app.services.user_settings_service.get_settings", return_value={"historical_days": 2}):
            resp = client.get("/api/users/settings")
        assert resp.status_code != 404

    def test_put_route_exists(self):
        with patch("app.services.user_settings_service.update_settings", return_value={"historical_days": 2}):
            resp = client.put("/api/users/settings", json={"historical_days": 2})
        assert resp.status_code != 404
