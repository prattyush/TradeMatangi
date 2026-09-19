"""
Tests for /api/auth/login and /api/auth/register endpoints.
Patches user_service internal functions rather than mocking DynamoDB.
"""
import bcrypt
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _hashed(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


# ── Register ──────────────────────────────────────────────────────────────────

class TestRegister:
    def test_success(self):
        with patch("app.services.user_service._find_by_email", return_value=None), \
             patch("app.services.user_service.register_user", wraps=None) as mock_reg:
            mock_reg.return_value = {"user_id": "new-uuid-001", "email": "new@example.com"}
            resp = client.post("/api/auth/register", json={"email": "new@example.com", "password": "pass123"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "new@example.com"
        assert "user_id" in data

    def test_duplicate_email_returns_409(self):
        from app.services import user_service
        # Simulate the full flow: _find_by_email returns existing → ValueError → 409
        with patch("app.services.user_service._find_by_email",
                   return_value={"user_id": "x", "email": "dup@example.com"}):
            resp = client.post("/api/auth/register",
                               json={"email": "dup@example.com", "password": "pass123"})
        assert resp.status_code == 409

    def test_short_password_returns_400(self):
        resp = client.post("/api/auth/register", json={"email": "x@example.com", "password": "abc"})
        assert resp.status_code == 400


# ── Login ─────────────────────────────────────────────────────────────────────

class TestLogin:
    def test_success(self):
        user = {"user_id": "abc-123", "email": "user@example.com",
                "password_hash": _hashed("mypass1")}
        with patch("app.services.user_service._find_by_email", return_value=user):
            resp = client.post("/api/auth/login",
                               json={"email": "user@example.com", "password": "mypass1"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "user@example.com"
        assert data["user_id"] == "abc-123"

    def test_wrong_password_returns_401(self):
        user = {"user_id": "abc-123", "email": "a@example.com",
                "password_hash": _hashed("correct")}
        with patch("app.services.user_service._find_by_email", return_value=user):
            resp = client.post("/api/auth/login",
                               json={"email": "a@example.com", "password": "wrong"})
        assert resp.status_code == 401

    def test_unknown_email_returns_401(self):
        with patch("app.services.user_service._find_by_email", return_value=None):
            resp = client.post("/api/auth/login",
                               json={"email": "nobody@example.com", "password": "pass"})
        assert resp.status_code == 401


class TestDesktopGoogleToken:
    def test_success_issues_desktop_token_bundle(self):
        bundle = {
            "access_token": "desktop-access",
            "refresh_token": "desktop-refresh",
            "token_type": "Bearer",
            "expires_in": 900,
        }
        with patch("app.routers.auth.google_auth", return_value={"user_id": "google-user", "email": "g@example.com"}), \
             patch("app.routers.auth.issue_token_bundle", return_value=bundle) as issue:
            resp = client.post("/api/auth/desktop/google-token", json={"id_token": "id-token", "device_name": "desktop"})
        assert resp.status_code == 200
        assert resp.json() == bundle
        issue.assert_called_once_with("google-user", "desktop")

    def test_invalid_google_token_returns_401(self):
        with patch("app.routers.auth.google_auth", return_value=None):
            resp = client.post("/api/auth/desktop/google-token", json={"id_token": "bad-token"})
        assert resp.status_code == 401

    def test_desktop_google_config_returns_public_client_id(self):
        with patch("app.routers.auth.get_google_client_id", return_value="desktop-client-id"), \
             patch("app.routers.auth.get_google_desktop_client_secret", return_value=""):
            resp = client.get("/api/auth/desktop/google-config")
        assert resp.status_code == 200
        assert resp.json() == {"client_id": "desktop-client-id"}

    def test_desktop_google_config_returns_optional_client_secret(self):
        with patch("app.routers.auth.get_google_client_id", return_value="desktop-client-id"), \
             patch("app.routers.auth.get_google_desktop_client_secret", return_value="desktop-secret"):
            resp = client.get("/api/auth/desktop/google-config")
        assert resp.status_code == 200
        assert resp.json() == {
            "client_id": "desktop-client-id",
            "client_secret": "desktop-secret",
        }

    def test_desktop_google_config_requires_configuration(self):
        with patch("app.routers.auth.get_google_client_id", return_value=""):
            resp = client.get("/api/auth/desktop/google-config")
        assert resp.status_code == 503
        assert "desktop_client_id" in resp.json()["detail"]

    def test_desktop_client_id_does_not_fall_back_to_web_client(self):
        from app.services.user_service import get_google_client_id

        config = MagicMock()
        config.get.side_effect = lambda _section, option, fallback="": {
            "client_id": "web-client-id",
            "desktop_client_secret": "desktop-secret",
        }.get(option, fallback)
        with patch("configparser.ConfigParser", return_value=config):
            assert get_google_client_id(desktop=True) == ""
            assert get_google_client_id() == "web-client-id"

    def test_desktop_client_secret_reads_dedicated_config_key(self):
        from app.services.user_service import get_google_desktop_client_secret

        config = MagicMock()
        config.get.side_effect = lambda _section, option, fallback="": {
            "desktop_client_secret": "desktop-secret",
        }.get(option, fallback)
        with patch("configparser.ConfigParser", return_value=config):
            assert get_google_desktop_client_secret() == "desktop-secret"


# ── Change Password ───────────────────────────────────────────────────────────

_CHANGE_URL = "/api/auth/change-password"
_USER_ID = "test-user-001"
_HEADERS = {"X-User-Id": _USER_ID}


class TestChangePassword:
    def test_success(self):
        user = {"user_id": _USER_ID, "email": "u@example.com", "password_hash": _hashed("oldpass1")}
        mock_table = MagicMock()
        with patch("app.services.user_service.get_user_info", return_value=user), \
             patch("app.services.db.get_dynamodb_resource") as mock_db:
            mock_db.return_value.Table.return_value = mock_table
            resp = client.post(_CHANGE_URL,
                               json={"old_password": "oldpass1", "new_password": "newpass1"},
                               headers=_HEADERS)
        assert resp.status_code == 204
        mock_table.update_item.assert_called_once()

    def test_wrong_old_password_returns_401(self):
        user = {"user_id": _USER_ID, "email": "u@example.com", "password_hash": _hashed("correct")}
        with patch("app.services.user_service.get_user_info", return_value=user):
            resp = client.post(_CHANGE_URL,
                               json={"old_password": "wrong", "new_password": "newpass1"},
                               headers=_HEADERS)
        assert resp.status_code == 401

    def test_short_new_password_returns_400(self):
        resp = client.post(_CHANGE_URL,
                           json={"old_password": "oldpass1", "new_password": "abc"},
                           headers=_HEADERS)
        assert resp.status_code == 400

    def test_unauthenticated_returns_error(self):
        resp = client.post(_CHANGE_URL,
                           json={"old_password": "old", "new_password": "newpass1"})
        assert resp.status_code in (401, 422)
