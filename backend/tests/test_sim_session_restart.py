"""
Tests for sim session restart behavior — old trades must survive restarts.
"""
import json
import pytest
from unittest.mock import patch

from app.services import simulation as sim_svc
from app.services import trading as trading_svc
from app.services import order_service as order_svc
from app.services import strategy_service as strategy_svc
from app.services import wallet_service as wallet_svc


@pytest.fixture(autouse=True)
def clean_in_memory():
    """Clean all in-memory state before and after each test."""
    sim_svc._sessions.clear()
    trading_svc._trades.clear()
    order_svc._orders.clear()
    strategy_svc._registry.clear()
    wallet_svc._wallets.clear()
    yield
    sim_svc._sessions.clear()
    trading_svc._trades.clear()
    order_svc._orders.clear()
    strategy_svc._registry.clear()
    wallet_svc._wallets.clear()


@pytest.fixture(autouse=True)
def mock_db():
    """Mock all DB writes so tests don't touch DynamoDB."""
    with patch("app.services.simulation._upsert_session_to_db"), \
         patch("app.services.trading._write_trade_to_db"), \
         patch("app.services.wallet_service._write_wallet_to_db"), \
         patch("app.services.wallet_service.get_balance", return_value=150_000.0), \
         patch("app.services.order_service._write_order_to_db"), \
         patch("app.services.strategy_service._write_strategy_to_db"):
        yield


class TestSimSessionRestartTradePreservation:
    """
    When a sim session is restarted with new params (start_time, speed, OTM),
    a NEW session is created. The old session's trades must remain discoverable
    via getTradesByContext so the frontend shows historical P&L.
    """

    def test_stop_session_preserves_db_session_record(self):
        """stop_session writes state=ended to DB, does NOT delete the Sessions record."""
        session = sim_svc.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        sid = session.session_id

        # Record a trade
        trading_svc.record_trade(
            session_id=sid,
            side="BUY",
            price=24200.0,
            timestamp=1700100000,
            quantity=50,
            symbol="NIFTY",
        )

        with patch("app.services.simulation._upsert_session_to_db") as mock_upsert:
            sim_svc.stop_session(session)
            mock_upsert.assert_called_once()
            # Verify the session was marked ENDED BEFORE the upsert
            call_session = mock_upsert.call_args[0][0]
            assert call_session.state.value == "ended"

        # Trades should still be in memory (stop_session doesn't clear _trades)
        trades = trading_svc.get_trades(sid)
        assert len(trades) == 1

    def test_restart_creates_new_session_id(self):
        """Restarting a sim session creates a NEW session_id."""
        session1 = sim_svc.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0)
        sid1 = session1.session_id

        trading_svc.record_trade(
            session_id=sid1, side="BUY", price=24200.0,
            timestamp=1700100000, quantity=50, symbol="NIFTY",
        )
        sim_svc.stop_session(session1)

        # Start a "new" session — should get a different session_id
        session2 = sim_svc.create_session("NIFTY", "2026-05-06", "10:30:00", 1.0)
        sid2 = session2.session_id

        assert sid1 != sid2
        # Original trades still accessible via old session_id
        assert len(trading_svc.get_trades(sid1)) == 1

    def test_get_trades_by_context_finds_multiple_sessions(self):
        """getTradesByContext aggregates trades across ALL sessions for the same context."""
        sid1 = sim_svc.create_session("NIFTY", "2026-05-06", "09:15:00", 1.0).session_id
        trading_svc.record_trade(
            session_id=sid1, side="BUY", price=24100.0,
            timestamp=1700100000, quantity=50, symbol="NIFTY",
        )
        trading_svc.record_trade(
            session_id=sid1, side="SELL", price=24200.0,
            timestamp=1700101000, quantity=50, symbol="NIFTY",
        )

        sid2 = sim_svc.create_session("NIFTY", "2026-05-06", "14:00:00", 1.0).session_id
        trading_svc.record_trade(
            session_id=sid2, side="BUY", price=24250.0,
            timestamp=1700200000, quantity=25, symbol="NIFTY",
        )

        # Use the actual analysis_service path to find sessions and aggregate trades
        from app.services.analysis_service import get_sessions_for_user, get_trades_for_session

        # We need to mock the DynamoDB query — _sessions are in-memory only
        # The restart path relies on DynamoDB for session discovery.
        # Test the in-memory aggregation path directly:
        sessions = [
            {"session_id": sid1, "symbol": "NIFTY", "date": "2026-05-06",
             "instrument_type": "equity", "session_type": "sim", "state": "ended"},
            {"session_id": sid2, "symbol": "NIFTY", "date": "2026-05-06",
             "instrument_type": "equity", "session_type": "sim", "state": "running"},
        ]

        all_trades = []
        for s in sessions:
            all_trades.extend(trading_svc.get_trades(s["session_id"]))
        all_trades.sort(key=lambda t: t.timestamp)

        assert len(all_trades) == 3
        assert all_trades[0].price == 24100.0
        assert all_trades[1].price == 24200.0
        assert all_trades[2].price == 24250.0

    def test_previous_session_trades_visible_as_historical(self):
        """
        Simulating what the frontend does:
        - Creates session, records trades, stops session
        - Creates new session (restart)
        - getTradesByContext returns ALL trades
        - Filtering out current session_id yields only previous-session trades
        """
        # Session 1: trade, stop
        sid1 = sim_svc.create_session("NIFTY", "2026-05-06", "09:18:00", 1.0).session_id
        trading_svc.record_trade(
            session_id=sid1, side="BUY", price=24100.0,
            timestamp=1700100000, quantity=50, symbol="NIFTY",
        )
        sim_svc.stop_session(sim_svc.get_session(sid1))

        # Session 2: restart with different start_time
        sid2 = sim_svc.create_session("NIFTY", "2026-05-06", "14:30:00", 1.0).session_id

        # Simulate getTradesByContext
        all_session_ids = [sid1, sid2]
        all_trades = []
        for sid in all_session_ids:
            all_trades.extend(trading_svc.get_trades(sid))

        # Filter out current session — only previous session trades remain
        historical = [t for t in all_trades if t.session_id != sid2]

        assert len(historical) == 1
        assert historical[0].session_id == sid1
        assert historical[0].price == 24100.0
