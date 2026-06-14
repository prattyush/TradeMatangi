import pytest
from unittest.mock import MagicMock, patch
from app.services.trading import record_trade, _trades
from app.models.schemas import TradeSide

@pytest.fixture(autouse=True)
def clear_trades():
    _trades.clear()
    yield
    _trades.clear()

def test_record_trade_underlying_price_live_session():
    """Test that record_trade captures underlying_price from an active session."""
    session_id = "test_live_session"
    
    mock_session = MagicMock()
    mock_session.last_price = 22500.5
    
    with patch("app.services.simulation.get_session", return_value=mock_session):
        trade = record_trade(
            session_id=session_id,
            side=TradeSide.BUY,
            price=150.0,
            timestamp=1715000000,
            instrument_type="options",
            symbol="NIFTY"
        )
        
        assert trade.underlying_price == 22500.5

def test_record_trade_underlying_price_fallback():
    """Test that record_trade falls back to parquet if no active session exists."""
    session_id = "test_fallback_session"
    
    with patch("app.services.simulation.get_session", return_value=None):
        with patch("app.services.options_service.get_underlying_price_at", return_value=22600.75) as mock_lookup:
            trade = record_trade(
                session_id=session_id,
                side=TradeSide.BUY,
                price=150.0,
                timestamp=1715000000,
                instrument_type="options",
                symbol="NIFTY"
            )
            
            assert trade.underlying_price == 22600.75
            mock_lookup.assert_called_once()

def test_record_trade_no_underlying_for_equity():
    """Test that underlying_price is not looked up for equity trades (uses trade price)."""
    session_id = "test_equity_session"
    
    # We allow get_session to be called (by guardrails), but check that the trade object
    # itself doesn't have an underlying_price set.
    with patch("app.services.simulation.get_session") as mock_get_sess:
        # Mock session to satisfy guardrail checks
        mock_sess = MagicMock()
        mock_sess.guardrail_ban_active = False
        mock_sess.guardrail_ban_enabled = False
        mock_sess.guardrail_cooldown_enabled = False
        mock_get_sess.return_value = mock_sess

        trade = record_trade(
            session_id=session_id,
            side=TradeSide.BUY,
            price=2500.0,
            timestamp=1715000000,
            instrument_type="equity",
            symbol="RELIANCE"
        )
        
        assert trade.underlying_price is None
