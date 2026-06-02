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


# ── Options trading symbol construction ──────────────────────────────────────

class TestOptionsSymbolConstruction:
    """Tests for _build_options_trading_symbol and _is_monthly_expiry in kotak_service."""

    def _sym(self, base, expiry, strike, right, symbol="NIFTY"):
        from app.services.kotak_service import _build_options_trading_symbol
        return _build_options_trading_symbol(base, expiry, strike, right, symbol)

    def test_monthly_nifty_pe(self):
        # May 26, 2026 is last Tuesday of May 2026 → monthly → NIFTY26MAY23500PE
        assert self._sym("NIFTY", "2026-05-26", 23500, "PE") == "NIFTY26MAY23500PE"

    def test_weekly_nifty_june_2(self):
        # June 2, 2026 is a Tuesday but NOT last Tuesday of June → weekly → NIFTY2660223500PE
        assert self._sym("NIFTY", "2026-06-02", 23500, "PE") == "NIFTY2660223500PE"

    def test_monthly_sensex_ce(self):
        # May 28, 2026 is last Thursday of May 2026 (SENSEX → always Thursday) → SENSEX26MAY76000CE
        assert self._sym("SENSEX", "2026-05-28", 76000, "CE", symbol="BSESEN") == "SENSEX26MAY76000CE"

    def test_weekly_sensex_june_4(self):
        # June 4, 2026 is Thursday but NOT last Thursday of June → SENSEX2660476000CE
        assert self._sym("SENSEX", "2026-06-04", 76000, "CE", symbol="BSESEN") == "SENSEX2660476000CE"

    def test_october_weekly_two_digit_month(self):
        # October 1, 2026 is a weekly; month=10 (two digits) → NIFTY261001XXXX
        result = self._sym("NIFTY", "2026-10-01", 24000, "CE")
        assert result == "NIFTY261001" + "24000CE"

    def test_december_weekly_two_digit_month(self):
        # Dec 3, 2026 → month=12, day=03 → NIFTY261203XXXXX
        result = self._sym("NIFTY", "2026-12-03", 23000, "PE")
        assert result == "NIFTY261203" + "23000PE"

    def test_resolve_options_symbol_nifty(self):
        """KotakNeoService._resolve_options_symbol returns correct symbol and exchange."""
        from app.services.kotak_service import get_service
        svc = get_service()
        sym, exchange = svc._resolve_options_symbol("NIFTY", "CE", 24700, "2026-05-26")
        assert sym == "NIFTY26MAY24700CE"
        assert exchange == "nse_fo"

    def test_resolve_options_symbol_sensex(self):
        from app.services.kotak_service import get_service
        svc = get_service()
        sym, exchange = svc._resolve_options_symbol("BSESEN", "CE", 80000, "2026-06-04")
        assert sym == "SENSEX2660480000CE"
        assert exchange == "bse_fo"

    def test_resolve_options_symbol_unsupported_raises(self):
        from app.services.kotak_service import get_service, KotakError
        svc = get_service()
        with pytest.raises(KotakError, match="does not support options trading"):
            svc._resolve_options_symbol("RELIND", "CE", 1000, "2026-05-26")


# ── Options order routing in real sessions ────────────────────────────────────

class TestOptionsOrderRouting:
    """Verify that place_options_sl_order and place_options_limit_order use the right symbol."""

    def test_place_options_limit_order_calls_correct_symbol(self):
        from app.services.kotak_service import get_service, KotakError

        svc = get_service()
        mock_client = MagicMock()
        mock_client.place_order.return_value = {"nOrdNo": "ORD001"}
        svc._client = mock_client
        svc._authenticated = True

        svc.place_options_limit_order(
            symbol="NIFTY",
            right="CE",
            strike=24700,
            expiry="2026-06-02",   # weekly
            side="B",
            qty=65,
            price=150.0,
        )

        call_kwargs = mock_client.place_order.call_args.kwargs
        assert call_kwargs["trading_symbol"] == "NIFTY2660224700CE"
        assert call_kwargs["exchange_segment"] == "nse_fo"
        assert call_kwargs["order_type"] == "L"
        assert call_kwargs["quantity"] == "65"

    def test_place_options_sl_order_calls_correct_symbol(self):
        from app.services.kotak_service import get_service

        svc = get_service()
        mock_client = MagicMock()
        mock_client.place_order.return_value = {"nOrdNo": "ORD002"}
        svc._client = mock_client
        svc._authenticated = True

        svc.place_options_sl_order(
            symbol="NIFTY",
            right="PE",
            strike=24000,
            expiry="2026-05-26",   # monthly
            side="S",
            qty=65,
            trigger_price=140.0,
            limit_price=139.0,
        )

        call_kwargs = mock_client.place_order.call_args.kwargs
        assert call_kwargs["trading_symbol"] == "NIFTY26MAY24000PE"
        assert call_kwargs["exchange_segment"] == "nse_fo"
        assert call_kwargs["order_type"] == "SL"

    def test_modify_sl_order_calls_modify(self):
        from app.services.kotak_service import get_service

        svc = get_service()
        mock_client = MagicMock()
        mock_client.modify_order.return_value = {"stat": "Ok"}
        svc._client = mock_client
        svc._authenticated = True

        svc.modify_sl_order("ORD123", new_trigger=145.0, new_limit=144.0, qty=10)

        mock_client.modify_order.assert_called_once()
        call_kwargs = mock_client.modify_order.call_args.kwargs
        assert call_kwargs["order_id"] == "ORD123"
        assert call_kwargs["order_type"] == "SL"
        assert call_kwargs["quantity"] == "10"


# ── Strategy SL modification in real sessions ─────────────────────────────────

class TestStrategySLModification:
    """Verify _update_exit_order_price calls modify_sl_order for real-session Kotak orders."""

    def test_update_exit_order_price_calls_modify_in_real_session(self):
        from app.services.strategy_service import _update_exit_order_price
        from app.models.schemas import OrderType, TradeSide, OrderStatus

        order = MagicMock()
        order.order_id = "ord_sl_1"
        order.side.value = "SELL"
        order.order_type = OrderType.STOPLOSS
        order.kotak_order_id = "KOTAK_ORD_001"

        session = MagicMock()
        session.session_type = "real"
        session.session_id = "sess_real"
        session.date = "2026-05-26"

        mock_kotak = MagicMock()
        with patch("app.services.order_service.update_order") as mock_update, \
             patch("app.services.kotak_service.get_service", return_value=mock_kotak):
            _update_exit_order_price(session, order, 150.0)

        mock_kotak.modify_sl_order.assert_called_once()
        call_args = mock_kotak.modify_sl_order.call_args
        assert call_args[0][0] == "KOTAK_ORD_001"   # kotak_order_id
        assert call_args[0][1] == 150.0              # new_trigger
        mock_update.assert_called_once()

    def test_update_exit_order_price_no_kotak_id_skips_modify(self):
        from app.services.strategy_service import _update_exit_order_price
        from app.models.schemas import OrderType

        order = MagicMock()
        order.order_id = "ord_local"
        order.side.value = "SELL"
        order.order_type = OrderType.TARGET
        order.kotak_order_id = None

        session = MagicMock()
        session.session_type = "real"
        session.session_id = "sess_real"
        session.date = "2026-05-26"

        mock_kotak = MagicMock()
        with patch("app.services.order_service.update_order"), \
             patch("app.services.kotak_service.get_service", return_value=mock_kotak):
            _update_exit_order_price(session, order, 150.0)

        mock_kotak.modify_sl_order.assert_not_called()

    def test_update_exit_order_price_sim_session_skips_modify(self):
        from app.services.strategy_service import _update_exit_order_price
        from app.models.schemas import OrderType

        order = MagicMock()
        order.order_id = "ord_sim"
        order.side.value = "SELL"
        order.order_type = OrderType.STOPLOSS
        order.kotak_order_id = "KOTAK_123"

        session = MagicMock()
        session.session_type = "sim"   # not real
        session.session_id = "sess_sim"
        session.date = "2026-05-26"

        mock_kotak = MagicMock()
        with patch("app.services.order_service.update_order"), \
             patch("app.services.kotak_service.get_service", return_value=mock_kotak):
            _update_exit_order_price(session, order, 150.0)

        mock_kotak.modify_sl_order.assert_not_called()


# ── Reconcile returns open orders ─────────────────────────────────────────────

class TestReconcileOpenOrders:
    """Verify /api/kotak/reconcile returns open_orders in its response."""

    def test_reconcile_response_includes_open_orders(self):
        kotak_orders = [
            {"kotak_order_id": "K1", "status": "complete", "filled_price": 150.0,
             "filled_quantity": 65, "quantity": 65},
            {"kotak_order_id": "K2", "status": "open", "filled_price": 0,
             "filled_quantity": 0, "quantity": 65},
        ]
        mock_kotak_svc = MagicMock()
        mock_kotak_svc.get_order_history.return_value = kotak_orders
        mock_kotak_svc.get_funds.return_value = 50000.0

        mock_session = MagicMock()
        mock_session.session_type = "real"
        mock_session.symbol = "NIFTY"          # needed for external order symbol check
        mock_session.instrument_type = "equity"
        mock_session.kotak_order_map = {}
        mock_session.external_reconciled_kotak_ids = set()  # needed for Pass 2
        mock_session.current_time = 1000
        mock_session.user_id = FIXED_USER_ID
        mock_session.date = "2026-05-26"

        with patch("app.routers.kotak.get_service", return_value=mock_kotak_svc), \
             patch("app.services.real_trading_service.is_whitelisted_user", return_value=True), \
             patch("app.services.user_service.get_user_info", return_value={"is_admin": True}), \
             patch("app.services.simulation.get_session", return_value=mock_session), \
             patch("app.services.wallet_service.reset"):
            resp = client.post(
                "/api/kotak/reconcile?session_id=sess_test",
                headers=ADMIN_HEADERS,
            )

        assert resp.status_code == 200
        data = resp.json()
        assert "open_orders" in data
        assert len(data["open_orders"]) == 1
        assert data["open_orders"][0]["status"] == "open"
        assert "wallet_balance" in data  # new field from wallet sync
