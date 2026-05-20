"""
Tests for Phase IX — Real Trading (Kotak Neo).

Covers:
- real_trading_service whitelist CRUD
- require_real_trading_access dependency
- GET /api/kotak/check-access
- GET /api/kotak/status
- POST /api/kotak/login
- Admin whitelist endpoints
- check_orders skips Kotak-managed orders
- Real session startup guards (whitelist + Kotak auth)
"""
import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient

from app.main import app
from app.config import FIXED_USER_ID

client = TestClient(app)

ADMIN_HEADERS = {"X-User-Id": FIXED_USER_ID}
NON_ADMIN_ID = "00000000-0000-0000-0000-000000000099"
NON_ADMIN_HEADERS = {"X-User-Id": NON_ADMIN_ID}


# ── real_trading_service unit tests ───────────────────────────────────────────

class TestRealTradingService:
    def _mock_resource(self, items=None, get_item_response=None):
        mock_table = MagicMock()
        mock_resource = MagicMock()
        mock_resource.meta.client.list_tables.return_value = {"TableNames": ["RealTradingWhitelist"]}
        mock_resource.Table.return_value = mock_table
        if items is not None:
            mock_table.scan.return_value = {"Items": items}
        if get_item_response is not None:
            mock_table.get_item.return_value = get_item_response
        return mock_resource, mock_table

    def test_is_whitelisted_email_true(self):
        from app.services import real_trading_service
        mock_resource, _ = self._mock_resource(
            get_item_response={"Item": {"email": "test@example.com"}}
        )
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = real_trading_service.is_whitelisted_email("test@example.com")
        assert result is True

    def test_is_whitelisted_email_false(self):
        from app.services import real_trading_service
        mock_resource, _ = self._mock_resource(get_item_response={})
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = real_trading_service.is_whitelisted_email("nobody@example.com")
        assert result is False

    def test_is_whitelisted_email_normalizes_case(self):
        from app.services import real_trading_service
        mock_resource, mock_table = self._mock_resource(
            get_item_response={"Item": {"email": "user@example.com"}}
        )
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            real_trading_service.is_whitelisted_email("  USER@EXAMPLE.COM  ")
        mock_table.get_item.assert_called_once_with(Key={"email": "user@example.com"})

    def test_get_whitelist_returns_items(self):
        from app.services import real_trading_service
        items = [{"email": "a@b.com", "added_at": "2026-01-01"}]
        mock_resource, _ = self._mock_resource(items=items)
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            result = real_trading_service.get_whitelist()
        assert result == items

    def test_add_to_whitelist_puts_item(self):
        from app.services import real_trading_service
        mock_resource, mock_table = self._mock_resource()
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            item = real_trading_service.add_to_whitelist("  NEW@EXAMPLE.COM  ")
        assert item["email"] == "new@example.com"
        assert "added_at" in item
        mock_table.put_item.assert_called_once()

    def test_remove_from_whitelist_calls_delete(self):
        from app.services import real_trading_service
        mock_resource, mock_table = self._mock_resource()
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource):
            real_trading_service.remove_from_whitelist("test@example.com")
        mock_table.delete_item.assert_called_once_with(Key={"email": "test@example.com"})

    def test_is_whitelisted_user_checks_email(self):
        from app.services import real_trading_service
        # is_whitelisted_user lazily imports get_user_info from user_service
        with patch("app.services.user_service.get_user_info",
                   return_value={"email": "user@example.com"}), \
             patch("app.services.real_trading_service.is_whitelisted_email", return_value=True) as mock_check:
            result = real_trading_service.is_whitelisted_user("some-user-id")
        assert result is True
        mock_check.assert_called_once_with("user@example.com")

    def test_is_whitelisted_user_no_user_info(self):
        from app.services import real_trading_service
        with patch("app.services.user_service.get_user_info", return_value=None):
            result = real_trading_service.is_whitelisted_user("unknown-id")
        assert result is False

    def test_ensure_table_creates_when_absent(self):
        from app.services import real_trading_service
        mock_client = MagicMock()
        mock_resource = MagicMock()
        mock_resource.meta.client.list_tables.return_value = {"TableNames": []}
        with patch("app.services.db.get_dynamodb_resource", return_value=mock_resource), \
             patch("app.services.db.get_dynamodb_client", return_value=mock_client):
            real_trading_service._ensure_table()
        mock_client.create_table.assert_called_once()
        args = mock_client.create_table.call_args[1]
        assert args["TableName"] == "RealTradingWhitelist"


# ── Admin whitelist endpoints ─────────────────────────────────────────────────

class TestAdminWhitelistEndpoints:
    def _admin_user_patch(self):
        # admin.py imports get_user_info at module level
        return patch("app.routers.admin.get_user_info",
                     return_value={"user_id": FIXED_USER_ID, "is_admin": True})

    def _non_admin_patch(self):
        return patch("app.routers.admin.get_user_info",
                     return_value={"user_id": NON_ADMIN_ID, "is_admin": False})

    def test_get_whitelist_returns_list(self):
        items = [{"email": "a@b.com", "added_at": "2026-01-01"}]
        with self._admin_user_patch(), \
             patch("app.services.real_trading_service.get_whitelist", return_value=items):
            resp = client.get("/api/admin/real-trading/whitelist", headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["email"] == "a@b.com"

    def test_get_whitelist_non_admin_403(self):
        with self._non_admin_patch():
            resp = client.get("/api/admin/real-trading/whitelist", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 403

    def test_post_whitelist_adds_email(self):
        new_item = {"email": "new@example.com", "added_at": "2026-01-01"}
        with self._admin_user_patch(), \
             patch("app.services.real_trading_service.add_to_whitelist", return_value=new_item):
            resp = client.post("/api/admin/real-trading/whitelist",
                               json={"email": "new@example.com"},
                               headers=ADMIN_HEADERS)
        assert resp.status_code == 201
        assert resp.json()["email"] == "new@example.com"

    def test_post_whitelist_invalid_email_400(self):
        with self._admin_user_patch():
            resp = client.post("/api/admin/real-trading/whitelist",
                               json={"email": "not-an-email"},
                               headers=ADMIN_HEADERS)
        assert resp.status_code == 400

    def test_post_whitelist_empty_email_400(self):
        with self._admin_user_patch():
            resp = client.post("/api/admin/real-trading/whitelist",
                               json={"email": ""},
                               headers=ADMIN_HEADERS)
        assert resp.status_code == 400

    def test_delete_whitelist_removes_email(self):
        with self._admin_user_patch(), \
             patch("app.services.real_trading_service.remove_from_whitelist") as mock_remove:
            resp = client.delete("/api/admin/real-trading/whitelist/test@example.com",
                                 headers=ADMIN_HEADERS)
        assert resp.status_code == 204
        mock_remove.assert_called_once_with("test@example.com")

    def test_delete_whitelist_non_admin_403(self):
        with self._non_admin_patch():
            resp = client.delete("/api/admin/real-trading/whitelist/test@example.com",
                                 headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 403


# ── /api/kotak/check-access ───────────────────────────────────────────────────

class TestKotakCheckAccess:
    # check-access doesn't use require_real_trading_access — it calls get_user_info
    # and real_trading_service.is_whitelisted_user lazily inside the endpoint
    def test_admin_has_access(self):
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": True}), \
             patch("app.services.real_trading_service.is_whitelisted_user", return_value=False):
            resp = client.get("/api/kotak/check-access", headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["has_access"] is True

    def test_whitelisted_user_has_access(self):
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": False}), \
             patch("app.services.real_trading_service.is_whitelisted_user", return_value=True):
            resp = client.get("/api/kotak/check-access", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["has_access"] is True

    def test_non_whitelisted_no_access(self):
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": False}), \
             patch("app.services.real_trading_service.is_whitelisted_user", return_value=False):
            resp = client.get("/api/kotak/check-access", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["has_access"] is False


# ── /api/kotak/status ─────────────────────────────────────────────────────────

class TestKotakStatus:
    # status uses require_real_trading_access which lazily imports get_user_info
    def test_status_authenticated(self):
        mock_service = MagicMock()
        mock_service.is_authenticated.return_value = True
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": True}), \
             patch("app.routers.kotak.get_service", return_value=mock_service):
            resp = client.get("/api/kotak/status", headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is True
        assert resp.json()["broker"] == "KotakNeo"

    def test_status_not_authenticated(self):
        mock_service = MagicMock()
        mock_service.is_authenticated.return_value = False
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": True}), \
             patch("app.routers.kotak.get_service", return_value=mock_service):
            resp = client.get("/api/kotak/status", headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["authenticated"] is False

    def test_status_requires_access(self):
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": False}), \
             patch("app.services.real_trading_service.is_whitelisted_user", return_value=False):
            resp = client.get("/api/kotak/status", headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 403


# ── /api/kotak/login ──────────────────────────────────────────────────────────

class TestKotakLogin:
    def test_login_success(self):
        mock_service = MagicMock()
        mock_service.login_with_totp.return_value = None
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": True}), \
             patch("app.routers.kotak.get_service", return_value=mock_service):
            resp = client.post("/api/kotak/login", json={"totp": "123456"},
                               headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"
        mock_service.login_with_totp.assert_called_once_with("123456")

    def test_login_kotak_error_returns_502(self):
        from app.services.kotak_service import KotakError
        mock_service = MagicMock()
        mock_service.login_with_totp.side_effect = KotakError("Invalid TOTP")
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": True}), \
             patch("app.routers.kotak.get_service", return_value=mock_service):
            resp = client.post("/api/kotak/login", json={"totp": "000000"},
                               headers=ADMIN_HEADERS)
        assert resp.status_code == 502
        assert "Invalid TOTP" in resp.json()["detail"]


# ── check_orders skips Kotak-managed orders ───────────────────────────────────

class TestCheckOrdersSkipsKotak:
    def test_kotak_order_not_triggered_locally(self):
        from app.services import order_service
        from app.models.schemas import OrderType, TradeSide, OrderStatus

        session_id = "kotak_test_sess"
        order_service._ensure_session(session_id)

        order = order_service.place_order(
            session_id=session_id,
            symbol="NIFTY",
            side=TradeSide.SELL,
            order_type=OrderType.STOPLOSS,
            quantity=1,
            created_at=0,
            trading_date="2026-01-01",
            trigger_price=24000.0,
        )
        order.kotak_order_id = "kotak-abc-123"

        with patch("app.services.order_service._write_order_to_db"):
            filled = order_service.check_orders(
                session_id, 23900.0, 1000, "2026-01-01"
            )
        assert len(filled) == 0
        assert order.status == OrderStatus.PENDING

        order_service.clear_session(session_id)

    def test_regular_stoploss_still_triggered(self):
        from app.services import order_service
        from app.models.schemas import OrderType, TradeSide, OrderStatus

        session_id = "kotak_test_sess2"
        order_service._ensure_session(session_id)

        order = order_service.place_order(
            session_id=session_id,
            symbol="NIFTY",
            side=TradeSide.SELL,
            order_type=OrderType.STOPLOSS,
            quantity=1,
            created_at=0,
            trading_date="2026-01-01",
            trigger_price=24000.0,
        )

        with patch("app.services.order_service._write_order_to_db"), \
             patch("app.services.wallet_service.credit"):
            filled = order_service.check_orders(
                session_id, 23900.0, 1000, "2026-01-01"
            )
        assert len(filled) == 1
        assert order.status == OrderStatus.FILLED

        order_service.clear_session(session_id)


# ── Real session startup guards ───────────────────────────────────────────────

class TestRealSessionStartup:
    def test_non_whitelisted_user_gets_403(self):
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": False}), \
             patch("app.services.real_trading_service.is_whitelisted_user", return_value=False):
            resp = client.post("/api/simulation/start", json={
                "symbol": "TATMOT",
                "date": "2026-05-19",
                "start_time": "09:15:00",
                "speed": 1.0,
                "instrument_type": "equity",
                "session_type": "real",
            }, headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 403

    def test_unauthenticated_kotak_gets_401(self):
        mock_kotak = MagicMock()
        mock_kotak.is_authenticated.return_value = False
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": False}), \
             patch("app.services.real_trading_service.is_whitelisted_user", return_value=True), \
             patch("app.services.kotak_service.get_service", return_value=mock_kotak):
            resp = client.post("/api/simulation/start", json={
                "symbol": "TATMOT",
                "date": "2026-05-19",
                "start_time": "09:15:00",
                "speed": 1.0,
                "instrument_type": "equity",
                "session_type": "real",
            }, headers=NON_ADMIN_HEADERS)
        assert resp.status_code == 401
        assert "Kotak" in resp.json()["detail"]

    def test_admin_bypasses_whitelist_check(self):
        """Admin should bypass whitelist and fail at Kotak auth check."""
        mock_kotak = MagicMock()
        mock_kotak.is_authenticated.return_value = False
        with patch("app.services.user_service.get_user_info",
                   return_value={"is_admin": True}), \
             patch("app.services.kotak_service.get_service", return_value=mock_kotak):
            resp = client.post("/api/simulation/start", json={
                "symbol": "TATMOT",
                "date": "2026-05-19",
                "start_time": "09:15:00",
                "speed": 1.0,
                "instrument_type": "equity",
                "session_type": "real",
            }, headers=ADMIN_HEADERS)
        assert resp.status_code == 401
