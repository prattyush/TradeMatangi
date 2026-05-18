"""
Tests for Sprint 2 admin token management:
- token_service (CRUD + masking)
- GET/PUT /api/admin/tokens (admin-only)
- GET /api/auth/me
- seed_user backfill of is_admin
- broker_service + kite_service DDB token fallback
"""
import pytest
from unittest.mock import patch, MagicMock, call
from fastapi.testclient import TestClient

from app.main import app
from app.config import FIXED_USER_ID

client = TestClient(app)

ADMIN_HEADERS = {"X-User-Id": FIXED_USER_ID}
NON_ADMIN_ID = "00000000-0000-0000-0000-000000000099"
NON_ADMIN_HEADERS = {"X-User-Id": NON_ADMIN_ID}


# ── token_service unit tests ───────────────────────────────────────────────────

class TestTokenService:
    def _mock_resource(self, item=None):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {"Item": item} if item else {}
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table
        mock_resource.meta.client.list_tables.return_value = {"TableNames": ["BrokerTokens"]}
        return mock_resource, mock_table

    def test_get_token_returns_value(self):
        from app.services import token_service
        mock_resource, mock_table = self._mock_resource(
            item={"pk": "config", "sk": "icici_session", "value": "tok123"}
        )
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = token_service.get_token("icici_session")
        assert result == "tok123"

    def test_get_token_returns_none_when_missing(self):
        from app.services import token_service
        mock_resource, mock_table = self._mock_resource(item=None)
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = token_service.get_token("icici_session")
        assert result is None

    def test_set_token_calls_put_item(self):
        from app.services import token_service
        mock_resource, mock_table = self._mock_resource()
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            token_service.set_token("icici_session", "newtoken")
        mock_table.put_item.assert_called_once()
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["pk"] == "config"
        assert item["sk"] == "icici_session"
        assert item["value"] == "newtoken"
        assert "updated_at" in item

    def test_get_tokens_masked_shows_last_4(self):
        from app.services import token_service
        mock_table = MagicMock()
        mock_resource = MagicMock()
        mock_resource.meta.client.list_tables.return_value = {"TableNames": ["BrokerTokens"]}
        mock_resource.Table.return_value = mock_table

        def _get_item(Key):
            sk = Key["sk"]
            if sk == "icici_session":
                return {"Item": {"value": "abcdefgh"}}
            return {}  # kite_access not set

        mock_table.get_item.side_effect = _get_item
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            masked = token_service.get_tokens_masked()
        assert masked["icici_session"] == "****efgh"
        assert masked["kite_access"] is None

    def test_get_tokens_masked_short_value(self):
        from app.services import token_service
        mock_table = MagicMock()
        mock_resource = MagicMock()
        mock_resource.meta.client.list_tables.return_value = {"TableNames": ["BrokerTokens"]}
        mock_resource.Table.return_value = mock_table
        mock_table.get_item.return_value = {"Item": {"value": "AB"}}
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            masked = token_service.get_tokens_masked()
        # 2-char value: 0 stars + last 2 chars
        assert masked["icici_session"] == "AB"

    def test_ensure_table_creates_when_absent(self):
        from app.services import token_service
        mock_client = MagicMock()
        mock_resource = MagicMock()
        mock_resource.meta.client.list_tables.return_value = {"TableNames": []}
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource), \
             patch("app.services.db.get_dynamodb_client", return_value=mock_client):
            token_service._ensure_table()
        mock_client.create_table.assert_called_once()
        args = mock_client.create_table.call_args[1]
        assert args["TableName"] == "BrokerTokens"

    def test_ensure_table_skips_when_exists(self):
        from app.services import token_service
        mock_client = MagicMock()
        mock_resource = MagicMock()
        mock_resource.meta.client.list_tables.return_value = {"TableNames": ["BrokerTokens"]}
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource), \
             patch("app.services.db.get_dynamodb_client", return_value=mock_client):
            token_service._ensure_table()
        mock_client.create_table.assert_not_called()


# ── GET /api/admin/tokens ─────────────────────────────────────────────────────
# Patch at the importing module (admin.py) because the function is bound by value
# when imported with "from ... import".

class TestGetAdminTokens:
    def test_admin_gets_masked_tokens(self):
        with patch("app.routers.admin.get_user_info",
                   return_value={"user_id": FIXED_USER_ID, "email": "admin@x.com", "is_admin": True}), \
             patch("app.routers.admin.token_service.get_tokens_masked",
                   return_value={"icici_session": "****1234", "kite_access": None}):
            resp = client.get("/api/admin/tokens", headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["icici_session"] == "****1234"
        assert data["kite_access"] is None

    def test_non_admin_gets_403(self):
        with patch("app.routers.admin.get_user_info",
                   return_value={"user_id": NON_ADMIN_ID, "email": "user@x.com", "is_admin": False}):
            resp = client.get("/api/admin/tokens", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 403

    def test_unknown_user_gets_403(self):
        with patch("app.routers.admin.get_user_info", return_value=None):
            resp = client.get("/api/admin/tokens", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 403


# ── PUT /api/admin/tokens ─────────────────────────────────────────────────────

class TestPutAdminTokens:
    def test_admin_can_set_icici_token(self):
        with patch("app.routers.admin.get_user_info",
                   return_value={"user_id": FIXED_USER_ID, "is_admin": True}), \
             patch("app.routers.admin.token_service.set_token") as mock_set, \
             patch("app.routers.admin.token_service.get_tokens_masked",
                   return_value={"icici_session": "****abcd", "kite_access": None}):
            resp = client.put("/api/admin/tokens",
                              json={"icici_session": "newtoken1234abcd"},
                              headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        mock_set.assert_called_once_with("icici_session", "newtoken1234abcd")
        assert resp.json()["icici_session"] == "****abcd"

    def test_admin_can_set_both_tokens(self):
        with patch("app.routers.admin.get_user_info",
                   return_value={"user_id": FIXED_USER_ID, "is_admin": True}), \
             patch("app.routers.admin.token_service.set_token") as mock_set, \
             patch("app.routers.admin.token_service.get_tokens_masked",
                   return_value={"icici_session": "****1111", "kite_access": "****2222"}):
            resp = client.put("/api/admin/tokens",
                              json={"icici_session": "icici_tok", "kite_access": "kite_tok"},
                              headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        assert mock_set.call_count == 2
        mock_set.assert_any_call("icici_session", "icici_tok")
        mock_set.assert_any_call("kite_access", "kite_tok")

    def test_null_fields_not_written(self):
        with patch("app.routers.admin.get_user_info",
                   return_value={"user_id": FIXED_USER_ID, "is_admin": True}), \
             patch("app.routers.admin.token_service.set_token") as mock_set, \
             patch("app.routers.admin.token_service.get_tokens_masked",
                   return_value={"icici_session": None, "kite_access": None}):
            resp = client.put("/api/admin/tokens",
                              json={"icici_session": None, "kite_access": None},
                              headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        mock_set.assert_not_called()

    def test_non_admin_gets_403(self):
        with patch("app.routers.admin.get_user_info",
                   return_value={"user_id": NON_ADMIN_ID, "is_admin": False}):
            resp = client.put("/api/admin/tokens",
                              json={"icici_session": "x"},
                              headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 403


# ── GET /api/auth/me ──────────────────────────────────────────────────────────

class TestGetMe:
    def test_admin_user_returns_is_admin_true(self):
        with patch("app.routers.auth.get_user_info",
                   return_value={"user_id": FIXED_USER_ID, "email": "admin@tradematangi.com", "is_admin": True}):
            resp = client.get("/api/auth/me", headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["is_admin"] is True
        assert data["email"] == "admin@tradematangi.com"

    def test_regular_user_returns_is_admin_false(self):
        with patch("app.routers.auth.get_user_info",
                   return_value={"user_id": NON_ADMIN_ID, "email": "user@x.com"}):
            resp = client.get("/api/auth/me", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["is_admin"] is False

    def test_unknown_user_returns_404(self):
        with patch("app.routers.auth.get_user_info", return_value=None):
            resp = client.get("/api/auth/me", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 404


# ── seed_user backfill ────────────────────────────────────────────────────────

class TestSeedUserIsAdmin:
    def test_new_user_seeded_with_is_admin(self):
        from app.services import user_service
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            user_service.seed_user()
        item = mock_table.put_item.call_args[1]["Item"]
        assert item["is_admin"] is True

    def test_existing_user_missing_is_admin_gets_backfilled(self):
        from app.services import user_service
        mock_table = MagicMock()
        mock_table.get_item.return_value = {"Item": {"user_id": FIXED_USER_ID, "email": "admin@tradematangi.com"}}
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            user_service.seed_user()
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args[1]
        assert call_kwargs["ExpressionAttributeValues"][":v"] is True

    def test_existing_user_with_is_admin_not_updated(self):
        from app.services import user_service
        mock_table = MagicMock()
        mock_table.get_item.return_value = {"Item": {
            "user_id": FIXED_USER_ID, "email": "admin@tradematangi.com", "is_admin": True
        }}
        mock_resource = MagicMock()
        mock_resource.Table.return_value = mock_table
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            user_service.seed_user()
        mock_table.update_item.assert_not_called()
        mock_table.put_item.assert_not_called()


# ── login returns is_admin ────────────────────────────────────────────────────

class TestLoginIsAdmin:
    def _hashed(self, password: str) -> str:
        import bcrypt
        return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

    def test_admin_login_returns_is_admin_true(self):
        import bcrypt
        user = {
            "user_id": FIXED_USER_ID,
            "email": "admin@tradematangi.com",
            "password_hash": self._hashed("admin123"),
            "is_admin": True,
        }
        with patch("app.services.user_service._find_by_email", return_value=user):
            resp = client.post("/api/auth/login",
                               json={"email": "admin@tradematangi.com", "password": "admin123"})
        assert resp.status_code == 200
        assert resp.json()["is_admin"] is True

    def test_regular_login_returns_is_admin_false(self):
        user = {
            "user_id": NON_ADMIN_ID,
            "email": "user@x.com",
            "password_hash": self._hashed("pass123"),
        }
        with patch("app.services.user_service._find_by_email", return_value=user):
            resp = client.post("/api/auth/login",
                               json={"email": "user@x.com", "password": "pass123"})
        assert resp.status_code == 200
        assert resp.json()["is_admin"] is False


# ── broker_service DDB token fallback ─────────────────────────────────────────

class TestBrokerServiceDDBFallback:
    def _ini_path(self, tmp_path, session_token="ini_session"):
        ini = tmp_path / "accesskeys.ini"
        ini.write_text(
            "[icicidirect]\n"
            "api_key = mykey\n"
            "api_secret = mysecret\n"
            f"session_token = {session_token}\n"
        )
        return ini

    def test_ddb_token_overrides_ini(self, tmp_path):
        from app.services import broker_service
        ini = self._ini_path(tmp_path, session_token="ini_tok")
        with patch.object(broker_service, "_CREDENTIALS_PATH", ini), \
             patch("app.services.token_service.get_token", return_value="ddb_tok"):
            creds = broker_service._read_breeze_credentials()
        assert creds["session_token"] == "ddb_tok"

    def test_falls_back_to_ini_when_ddb_empty(self, tmp_path):
        from app.services import broker_service
        ini = self._ini_path(tmp_path, session_token="ini_tok")
        with patch.object(broker_service, "_CREDENTIALS_PATH", ini), \
             patch("app.services.token_service.get_token", return_value=None):
            creds = broker_service._read_breeze_credentials()
        assert creds["session_token"] == "ini_tok"

    def test_raises_when_both_empty(self, tmp_path):
        from app.services import broker_service
        from app.services.broker_service import BreezeTokenError
        ini = tmp_path / "accesskeys.ini"
        ini.write_text("[icicidirect]\napi_key = k\napi_secret = s\nsession_token = \n")
        with patch.object(broker_service, "_CREDENTIALS_PATH", ini), \
             patch("app.services.token_service.get_token", return_value=None):
            with pytest.raises(BreezeTokenError):
                broker_service._read_breeze_credentials()


# ── kite_service DDB token fallback ──────────────────────────────────────────

class TestKiteServiceDDBFallback:
    def _write_ini(self, tmp_path, access_token="ini_kite"):
        ini = tmp_path / "accesskeys.ini"
        ini.write_text(
            "[kite]\n"
            "api_key = kite_key\n"
            f"access_token = {access_token}\n"
        )
        return ini

    def test_ddb_token_overrides_ini(self, tmp_path):
        from app.services import kite_service
        from app.services.kite_service import KiteTokenError
        ini = self._write_ini(tmp_path, access_token="ini_tok")

        mock_kite = MagicMock()
        mock_kite.profile.return_value = {}
        mock_kite_cls = MagicMock(return_value=mock_kite)

        with patch("app.config.DATA_DIR", tmp_path), \
             patch("app.services.token_service.get_token", return_value="ddb_tok"), \
             patch("kiteconnect.KiteConnect", mock_kite_cls):
            kite_service._get_kite()

        mock_kite.set_access_token.assert_called_once_with("ddb_tok")

    def test_falls_back_to_ini_when_ddb_empty(self, tmp_path):
        from app.services import kite_service
        ini = self._write_ini(tmp_path, access_token="ini_tok")

        mock_kite = MagicMock()
        mock_kite.profile.return_value = {}
        mock_kite_cls = MagicMock(return_value=mock_kite)

        with patch("app.config.DATA_DIR", tmp_path), \
             patch("app.services.token_service.get_token", return_value=None), \
             patch("kiteconnect.KiteConnect", mock_kite_cls):
            kite_service._get_kite()

        mock_kite.set_access_token.assert_called_once_with("ini_tok")
