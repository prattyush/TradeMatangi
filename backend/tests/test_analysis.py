"""
Tests for /api/analysis endpoints.
analysis_service DynamoDB calls are patched using unittest.mock.patch,
consistent with the project's established test pattern.
"""
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

FIXED_USER_ID = "abc12300-0000-0000-0000-000000000001"

SESSION_A = {
    "session_id": "sess-001",
    "user_id": FIXED_USER_ID,
    "symbol": "NIFTY",
    "date": "2026-05-07",
    "start_time": "09:15:00",
    "instrument_type": "equity",
    "session_capital": 100000.0,
    "state": "ended",
}

TRADES_A = [
    {
        "trade_id": "t-001",
        "session_id": "sess-001",
        "user_id": FIXED_USER_ID,
        "symbol": "NIFTY",
        "side": "BUY",
        "quantity": 65,
        "price": 24200.5,
        "timestamp": 1746589800,
        "instrument_type": "equity",
        "right": None,
        "strike": None,
        "expiry": None,
        "commission": 2.65,
    },
    {
        "trade_id": "t-002",
        "session_id": "sess-001",
        "user_id": FIXED_USER_ID,
        "symbol": "NIFTY",
        "side": "SELL",
        "quantity": 65,
        "price": 24350.0,
        "timestamp": 1746593400,
        "instrument_type": "equity",
        "right": None,
        "strike": None,
        "expiry": None,
        "commission": 15.22,
    },
]


# ── GET /api/analysis/sessions ────────────────────────────────────────────────

class TestGetSessions:
    def test_returns_list(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get("/api/analysis/sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["session_id"] == "sess-001"
        assert data[0]["symbol"] == "NIFTY"

    def test_trade_count(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get("/api/analysis/sessions")
        s = resp.json()[0]
        assert s["trade_count"] == 2
        assert s["buy_count"] == 1
        assert s["sell_count"] == 1

    def test_pnl_calculation(self):
        # SELL proceeds: 24350 * 65 = 1582750
        # BUY cost:      24200.5 * 65 = 1573032.5
        # gross P&L = 9717.5
        # commissions = 2.65 + 15.22 = 17.87
        # net P&L = 9717.5 - 17.87 = 9699.63
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get("/api/analysis/sessions")
        s = resp.json()[0]
        assert abs(s["net_pnl"] - 9699.63) < 0.1
        assert s["session_capital"] == 100000.0

    def test_pnl_pct(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get("/api/analysis/sessions")
        s = resp.json()[0]
        # pnl_pct = net_pnl / session_capital * 100 ≈ 9.70 (stored as %)
        assert abs(s["pnl_pct"] - 9.6996) < 0.1

    def test_symbol_filter_forwarded(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn, \
             patch("app.services.analysis_service.get_trades_for_session", return_value=[]):
            client.get("/api/analysis/sessions?symbol=TATPOW")
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, symbol="TATPOW", start_date=None, end_date=None,
            instrument_type=None,
        )

    def test_date_range_filter_forwarded(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn, \
             patch("app.services.analysis_service.get_trades_for_session", return_value=[]):
            client.get("/api/analysis/sessions?start_date=2026-05-01&end_date=2026-05-07")
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, symbol=None, start_date="2026-05-01", end_date="2026-05-07",
            instrument_type=None,
        )

    def test_empty_result(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=[]):
            resp = client.get("/api/analysis/sessions")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_negative_pnl_session(self):
        trades_losing = [
            {**TRADES_A[0], "price": 24400.0},   # BUY at 24400
            {**TRADES_A[1], "price": 24200.0},   # SELL at 24200 (loss)
        ]
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=trades_losing):
            resp = client.get("/api/analysis/sessions")
        s = resp.json()[0]
        assert s["net_pnl"] < 0


# ── GET /api/analysis/sessions/{session_id} ───────────────────────────────────

class TestGetSessionDetail:
    def _detail(self):
        from app.services.analysis_service import compute_session_summary, _serialize_trade
        summary = compute_session_summary(SESSION_A, TRADES_A)
        summary["trades"] = [_serialize_trade(t) for t in TRADES_A]
        return summary

    def test_returns_session_with_trades(self):
        with patch("app.services.analysis_service.get_session_summary_with_trades", return_value=self._detail()):
            resp = client.get("/api/analysis/sessions/sess-001")
        assert resp.status_code == 200
        data = resp.json()
        assert "trades" in data
        assert len(data["trades"]) == 2

    def test_trades_sorted_by_timestamp(self):
        with patch("app.services.analysis_service.get_session_summary_with_trades", return_value=self._detail()):
            resp = client.get("/api/analysis/sessions/sess-001")
        trades = resp.json()["trades"]
        timestamps = [t["timestamp"] for t in trades]
        assert timestamps == sorted(timestamps)

    def test_not_found(self):
        with patch("app.services.analysis_service.get_session_summary_with_trades", return_value=None):
            resp = client.get("/api/analysis/sessions/nonexistent")
        assert resp.status_code == 404

    def test_trade_fields_present(self):
        with patch("app.services.analysis_service.get_session_summary_with_trades", return_value=self._detail()):
            resp = client.get("/api/analysis/sessions/sess-001")
        t = resp.json()["trades"][0]
        for field in ("trade_id", "side", "quantity", "price", "timestamp", "commission"):
            assert field in t


# ── analysis_service unit tests ───────────────────────────────────────────────

class TestComputeSessionSummary:
    def test_basic_pnl(self):
        from app.services.analysis_service import compute_session_summary
        summary = compute_session_summary(SESSION_A, TRADES_A)
        assert abs(summary["net_pnl"] - 9699.63) < 0.1
        assert summary["trade_count"] == 2

    def test_zero_capital_pnl_pct_is_zero(self):
        from app.services.analysis_service import compute_session_summary
        session_no_capital = {**SESSION_A, "session_capital": 0}
        summary = compute_session_summary(session_no_capital, TRADES_A)
        assert summary["pnl_pct"] == 0.0

    def test_no_trades(self):
        from app.services.analysis_service import compute_session_summary
        summary = compute_session_summary(SESSION_A, [])
        assert summary["net_pnl"] == 0.0
        assert summary["trade_count"] == 0
        assert summary["buy_count"] == 0
        assert summary["sell_count"] == 0
