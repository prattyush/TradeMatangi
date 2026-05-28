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
