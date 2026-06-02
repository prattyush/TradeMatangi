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
            instrument_type=None, session_type=None,
        )

    def test_date_range_filter_forwarded(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn, \
             patch("app.services.analysis_service.get_trades_for_session", return_value=[]):
            client.get("/api/analysis/sessions?start_date=2026-05-01&end_date=2026-05-07")
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, symbol=None, start_date="2026-05-01", end_date="2026-05-07",
            instrument_type=None, session_type=None,
        )

    def test_session_type_filter_sim(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn, \
             patch("app.services.analysis_service.get_trades_for_session", return_value=[]):
            resp = client.get("/api/analysis/sessions?session_type=sim")
        assert resp.status_code == 200
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, symbol=None, start_date=None, end_date=None,
            instrument_type=None, session_type="sim",
        )

    def test_session_type_filter_paper(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn, \
             patch("app.services.analysis_service.get_trades_for_session", return_value=[]):
            resp = client.get("/api/analysis/sessions?session_type=paper")
        assert resp.status_code == 200
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, symbol=None, start_date=None, end_date=None,
            instrument_type=None, session_type="paper",
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


# ── GET /api/analysis/trades ──────────────────────────────────────────────────

class TestGetTradesForAnalysis:
    def test_returns_sessions_with_embedded_trades(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01&to=2026-05-31"
            )
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["session_id"] == "sess-001"
        assert data[0]["symbol"] == "NIFTY"
        assert "trades" in data[0]
        assert len(data[0]["trades"]) == 2

    def test_trade_items_have_required_fields(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01&to=2026-05-31"
            )
        trade = resp.json()[0]["trades"][0]
        for field in ("trade_id", "side", "price", "quantity", "timestamp", "commission"):
            assert field in trade

    def test_session_summary_fields_present(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01&to=2026-05-31"
            )
        s = resp.json()[0]
        for field in ("date", "symbol", "session_type", "instrument_type", "session_capital", "net_pnl", "pnl_pct"):
            assert field in s

    def test_empty_result_when_no_sessions(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]):
            resp = client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01&to=2026-05-31"
            )
        assert resp.status_code == 200
        assert resp.json() == []

    def test_requires_user_id(self):
        resp = client.get("/api/analysis/trades?from=2026-05-01&to=2026-05-31")
        assert resp.status_code == 422

    def test_requires_from_date(self):
        resp = client.get(f"/api/analysis/trades?user_id={FIXED_USER_ID}&to=2026-05-31")
        assert resp.status_code == 422

    def test_requires_to_date(self):
        resp = client.get(f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01")
        assert resp.status_code == 422

    def test_date_range_forwarded_to_service(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn:
            client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-10&to=2026-05-20"
            )
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, start_date="2026-05-10", end_date="2026-05-20",
            symbol=None, session_type=None,
        )

    def test_symbol_filter_forwarded(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn:
            client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01&to=2026-05-31&symbol=NIFTY"
            )
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, start_date="2026-05-01", end_date="2026-05-31",
            symbol="NIFTY", session_type=None,
        )

    def test_session_type_filter_forwarded(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[]) as mock_fn:
            client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01&to=2026-05-31&session_type=paper"
            )
        mock_fn.assert_called_once_with(
            FIXED_USER_ID, start_date="2026-05-01", end_date="2026-05-31",
            symbol=None, session_type="paper",
        )

    def test_trades_include_expiry_field(self):
        with patch("app.services.analysis_service.get_sessions_for_user", return_value=[SESSION_A]), \
             patch("app.services.analysis_service.get_trades_for_session", return_value=TRADES_A):
            resp = client.get(
                f"/api/analysis/trades?user_id={FIXED_USER_ID}&from=2026-05-01&to=2026-05-31"
            )
        trade = resp.json()[0]["trades"][0]
        assert "expiry" in trade  # field present (may be null for equity)


# ── GET /api/analysis/ohlc-context ───────────────────────────────────────────

class TestGetOhlcContext:
    """Tests for the /api/analysis/ohlc-context endpoint."""

    def _make_candle_df(self):
        import pandas as pd
        import numpy as np
        # Build a simple 20-row second-level DataFrame starting at 09:15 IST-as-UTC
        base = pd.Timestamp("2026-05-29 09:15:00", tz="UTC")
        idx = pd.date_range(start=base, periods=20 * 180, freq="s")
        df = pd.DataFrame(
            {
                "open": np.linspace(100.0, 119.0, len(idx)),
                "high": np.linspace(101.0, 120.0, len(idx)),
                "low": np.linspace(99.0, 118.0, len(idx)),
                "close": np.linspace(100.5, 119.5, len(idx)),
            },
            index=idx,
        )
        return df

    _FETCH_EQ = "app.services.broker_service.fetch_historical"
    _FETCH_OPT = "app.services.options_service.fetch_options_historical"

    def test_equity_returns_labeled_bars(self):
        df = self._make_candle_df()
        base_ts = int(df.index[0].timestamp())  # 09:15 candle start
        entry_ts = base_ts + 3 * 180  # 4th candle (index 3)
        exit_ts = base_ts + 6 * 180   # 7th candle (index 6)

        with patch(self._FETCH_EQ), \
             patch("app.services.data_loader.load_dataframe", return_value=df):
            resp = client.get(
                f"/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29"
                f"&entry_ts={entry_ts}&exit_ts={exit_ts}"
            )

        assert resp.status_code == 200
        bars = resp.json()["bars"]
        labels = [b["label"] for b in bars]
        assert "pre" in labels
        assert "entry" in labels
        assert "exit" in labels
        assert "post" in labels

    def test_entry_bar_labeled_correctly(self):
        df = self._make_candle_df()
        base_ts = int(df.index[0].timestamp())
        entry_ts = base_ts + 3 * 180  # 4th candle

        with patch(self._FETCH_EQ), \
             patch("app.services.data_loader.load_dataframe", return_value=df):
            resp = client.get(
                f"/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29&entry_ts={entry_ts}"
            )

        assert resp.status_code == 200
        bars = resp.json()["bars"]
        entry_bars = [b for b in bars if b["label"] == "entry"]
        assert len(entry_bars) == 1
        assert entry_bars[0]["time"] == (entry_ts // 180) * 180

    def test_missing_data_returns_404(self):
        with patch(self._FETCH_EQ, side_effect=RuntimeError("no breeze")), \
             patch(
                 "app.services.data_loader.load_dataframe",
                 side_effect=FileNotFoundError("no data"),
             ):
            resp = client.get(
                "/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29&entry_ts=1748511300"
            )
        assert resp.status_code == 404

    def test_pre_bars_count(self):
        df = self._make_candle_df()
        base_ts = int(df.index[0].timestamp())
        entry_ts = base_ts + 6 * 180  # enough room for 6 pre bars

        with patch(self._FETCH_EQ), \
             patch("app.services.data_loader.load_dataframe", return_value=df):
            resp = client.get(
                f"/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29"
                f"&entry_ts={entry_ts}&pre_bars=6"
            )

        bars = resp.json()["bars"]
        pre_count = sum(1 for b in bars if b["label"] == "pre")
        assert pre_count == 6

    def test_same_bar_entry_exit_labeled_entry_exit(self):
        df = self._make_candle_df()
        base_ts = int(df.index[0].timestamp())
        bar_ts = base_ts + 3 * 180
        # Entry and exit in the same 3-min candle
        entry_ts = bar_ts + 30
        exit_ts = bar_ts + 90

        with patch(self._FETCH_EQ), \
             patch("app.services.data_loader.load_dataframe", return_value=df):
            resp = client.get(
                f"/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29"
                f"&entry_ts={entry_ts}&exit_ts={exit_ts}"
            )

        bars = resp.json()["bars"]
        labels = [b["label"] for b in bars]
        assert "entry_exit" in labels

    def test_fetch_historical_called_before_equity_load(self):
        """fetch_historical is always invoked so partial files get refreshed."""
        df = self._make_candle_df()
        base_ts = int(df.index[0].timestamp())
        entry_ts = base_ts + 3 * 180

        with patch(self._FETCH_EQ) as mock_fetch, \
             patch("app.services.data_loader.load_dataframe", return_value=df):
            client.get(
                f"/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29&entry_ts={entry_ts}"
            )

        mock_fetch.assert_called_once_with("NIFTY", "2026-05-29")

    def test_fetch_options_historical_called_for_options_path(self):
        """fetch_options_historical called for options requests."""
        df = self._make_candle_df()
        base_ts = int(df.index[0].timestamp())
        entry_ts = base_ts + 3 * 180

        with patch(self._FETCH_OPT) as mock_fetch_opt, \
             patch("app.services.options_service.load_options_dataframe", return_value=df):
            resp = client.get(
                f"/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29"
                f"&entry_ts={entry_ts}&right=CE&strike=23500&expiry=2026-05-29"
            )

        assert resp.status_code == 200
        mock_fetch_opt.assert_called_once_with("NIFTY", "2026-05-29", 23500, "2026-05-29", "CE")

    def test_returns_404_when_breeze_fetch_fails_and_no_file(self):
        """404 when both Breeze fetch and local file are unavailable."""
        with patch(self._FETCH_EQ, side_effect=ConnectionError("breeze down")), \
             patch(
                 "app.services.data_loader.load_dataframe",
                 side_effect=FileNotFoundError("no file"),
             ):
            resp = client.get(
                "/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29&entry_ts=1748511300"
            )
        assert resp.status_code == 404

    def test_partial_data_entry_bar_missing_returns_404(self):
        """404 when file exists but doesn't cover entry timestamp (partial write)."""
        import pandas as pd
        import numpy as np
        # Partial df: only 09:15–10:00 (15 bars × 180 s)
        base = pd.Timestamp("2026-05-29 09:15:00", tz="UTC")
        idx = pd.date_range(start=base, periods=15 * 180, freq="s")
        partial_df = pd.DataFrame(
            {"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5},
            index=idx,
        )
        # Entry at 11:00 — outside the partial df range
        entry_ts = int(pd.Timestamp("2026-05-29 11:00:00", tz="UTC").timestamp())

        with patch(self._FETCH_EQ, side_effect=RuntimeError("breeze unavailable")), \
             patch("app.services.data_loader.load_dataframe", return_value=partial_df):
            resp = client.get(
                f"/api/analysis/ohlc-context?symbol=NIFTY&date=2026-05-29&entry_ts={entry_ts}"
            )
        assert resp.status_code == 404


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
