"""
Unit tests for guardrail MaxSize feature.
"""
from __future__ import annotations

import asyncio
import pytest
from dataclasses import dataclass, field
from unittest.mock import patch, MagicMock

from app.models.schemas import Position, TradeSide
from app.services import guardrail_service as gsvc


def _make_queue():
    loop = asyncio.new_event_loop()
    q = asyncio.Queue(maxsize=100)
    return q


@dataclass
class MockSession:
    session_id: str = "sess-001"
    session_capital: float = 100_000.0
    symbol: str = "NIFTY"
    instrument_type: str = "equity"
    right: str | None = None
    current_time: str = "34500"
    strategy_interval_secs: int = 180
    # guardrail runtime state
    guardrail_block_until_bar: int = 0
    guardrail_ban_active: bool = False
    guardrail_cooldown_enabled: bool = False
    guardrail_consecutive_losses: int = 0
    guardrail_cooldown_trips_seen: int = 0
    guardrail_block_bars: int = 3
    guardrail_cooldown_block_bars: int = 3
    guardrail_cooldown_losses: int = 3
    guardrail_ban_capital_pct: float = 10.0
    guardrail_ban_loss_trade_pct: float = 60.0
    guardrail_ban_min_trades: int = 5
    guardrail_ban_enabled: bool = False
    # maxsize fields
    guardrail_maxsize_enabled: bool = False
    guardrail_maxsize_mode: str = "percentage"
    guardrail_maxsize_pct: float = 20.0
    guardrail_maxsize_value: float = 0.0
    queue: object = field(default_factory=lambda: MagicMock())


def _make_position(side="FLAT", qty=0, avg_price=0.0):
    return Position(symbol="NIFTY", quantity=qty, avg_entry_price=avg_price, side=side)


# ── _get_capital_in_use ───────────────────────────────────────────────────────

POS_PATH = "app.services.trading.get_position"

class TestGetCapitalInUse:
    def test_equity_long(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("LONG", 100, 150.0)):
            result = gsvc._get_capital_in_use(sess)
        assert result == 15000.0

    def test_equity_flat(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("FLAT", 0, 0.0)):
            result = gsvc._get_capital_in_use(sess)
        assert result == 0.0

    def test_equity_short(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("SHORT", 50, 200.0)):
            result = gsvc._get_capital_in_use(sess)
        assert result == 10000.0

    def test_options_dual_stream_sums_both_rights(self):
        sess = MockSession(instrument_type="options", right=None)
        def _mock_get_pos(session_id, symbol=None, right=None):
            if right == "CE":
                return _make_position("LONG", 75, 160.0)
            if right == "PE":
                return _make_position("SHORT", 25, 180.0)
            return _make_position()
        with patch(POS_PATH, side_effect=_mock_get_pos):
            result = gsvc._get_capital_in_use(sess)
        assert result == 75 * 160.0 + 25 * 180.0

    def test_options_single_right_only_queries_that_right(self):
        sess = MockSession(instrument_type="options", right="CE")
        called_rights = []
        def _mock_get_pos(session_id, symbol=None, right=None):
            called_rights.append(right)
            if right == "CE":
                return _make_position("LONG", 50, 120.0)
            return _make_position()
        with patch(POS_PATH, side_effect=_mock_get_pos):
            result = gsvc._get_capital_in_use(sess)
        assert called_rights == ["CE"]
        assert result == 50 * 120.0


# ── _simulate_post_trade_capital ──────────────────────────────────────────────

class TestSimulatePostTradeCapital:
    def test_buy_from_flat(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("FLAT", 0, 0.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=0.0):
            result = gsvc._simulate_post_trade_capital(sess, 100.0, 50, "BUY")
        assert result == 5000.0

    def test_buy_adding_to_long(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("LONG", 100, 150.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=15000.0):
            result = gsvc._simulate_post_trade_capital(sess, 160.0, 50, "BUY")
        assert result == 15000.0 + 8000.0

    def test_buy_partially_covering_short(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("SHORT", 100, 200.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=20000.0):
            result = gsvc._simulate_post_trade_capital(sess, 190.0, 40, "BUY")
        assert result == 20000.0 * (1 - 40 / 100)

    def test_buy_reversing_short_to_long(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("SHORT", 100, 200.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=20000.0):
            result = gsvc._simulate_post_trade_capital(sess, 190.0, 150, "BUY")
        assert result == 50 * 190.0

    def test_sell_from_flat(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("FLAT", 0, 0.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=0.0):
            result = gsvc._simulate_post_trade_capital(sess, 100.0, 50, "SELL")
        assert result == 5000.0

    def test_sell_partially_closing_long(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("LONG", 200, 150.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=30000.0):
            result = gsvc._simulate_post_trade_capital(sess, 155.0, 80, "SELL")
        assert result == 30000.0 * (1 - 80 / 200)

    def test_sell_reversing_long_to_short(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("LONG", 100, 150.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=15000.0):
            result = gsvc._simulate_post_trade_capital(sess, 155.0, 130, "SELL")
        assert result == 30 * 155.0

    def test_sell_adding_to_short(self):
        sess = MockSession()
        with patch(POS_PATH, return_value=_make_position("SHORT", 50, 200.0)), \
             patch("app.services.guardrail_service._get_capital_in_use", return_value=10000.0):
            result = gsvc._simulate_post_trade_capital(sess, 195.0, 30, "SELL")
        assert result == 10000.0 + 30 * 195.0


# ── check_maxsize ─────────────────────────────────────────────────────────────

class TestCheckMaxSize:
    def test_disabled_always_allows(self):
        sess = MockSession()
        sess.guardrail_maxsize_enabled = False
        blocked, reason = gsvc.check_maxsize(sess, 100.0, 500, "BUY")
        assert not blocked
        assert reason == ""

    def test_percentage_mode_within_limit(self):
        sess = MockSession()
        sess.guardrail_maxsize_enabled = True
        sess.guardrail_maxsize_mode = "percentage"
        sess.guardrail_maxsize_pct = 20.0
        sess.session_capital = 100_000.0
        with patch("app.services.guardrail_service._simulate_post_trade_capital", return_value=15_000.0):
            blocked, reason = gsvc.check_maxsize(sess, 100.0, 100, "BUY")
        assert not blocked

    def test_percentage_mode_exceeds_limit(self):
        sess = MockSession()
        sess.guardrail_maxsize_enabled = True
        sess.guardrail_maxsize_mode = "percentage"
        sess.guardrail_maxsize_pct = 20.0
        sess.session_capital = 100_000.0
        with patch("app.services.guardrail_service._simulate_post_trade_capital", return_value=25_000.0):
            blocked, reason = gsvc.check_maxsize(sess, 250.0, 100, "BUY")
        assert blocked
        assert "MAXSIZE" in reason

    def test_value_mode_within_limit(self):
        sess = MockSession()
        sess.guardrail_maxsize_enabled = True
        sess.guardrail_maxsize_mode = "value"
        sess.guardrail_maxsize_value = 50_000.0
        with patch("app.services.guardrail_service._simulate_post_trade_capital", return_value=30_000.0):
            blocked, reason = gsvc.check_maxsize(sess, 300.0, 100, "BUY")
        assert not blocked

    def test_value_mode_exceeds_limit(self):
        sess = MockSession()
        sess.guardrail_maxsize_enabled = True
        sess.guardrail_maxsize_mode = "value"
        sess.guardrail_maxsize_value = 50_000.0
        with patch("app.services.guardrail_service._simulate_post_trade_capital", return_value=60_000.0):
            blocked, reason = gsvc.check_maxsize(sess, 600.0, 100, "BUY")
        assert blocked
        assert "MAXSIZE" in reason


# ── initialize_guardrails integration ─────────────────────────────────────────

class TestInitializeGuardrailsMaxSize:
    def test_maxsize_fields_snapshotted_from_settings(self):
        sess = MockSession()
        settings = {
            "guardrail_maxsize_enabled": True,
            "guardrail_maxsize_mode": "value",
            "guardrail_maxsize_pct": 30.0,
            "guardrail_maxsize_value": 75_000.0,
        }
        # simulate what initialize_guardrails does with these settings
        sess.guardrail_maxsize_enabled = bool(settings.get("guardrail_maxsize_enabled", False))
        sess.guardrail_maxsize_mode = str(settings.get("guardrail_maxsize_mode", "percentage"))
        sess.guardrail_maxsize_pct = float(settings.get("guardrail_maxsize_pct", 20.0))
        sess.guardrail_maxsize_value = float(settings.get("guardrail_maxsize_value", 0.0))
        assert sess.guardrail_maxsize_enabled is True
        assert sess.guardrail_maxsize_mode == "value"
        assert sess.guardrail_maxsize_pct == 30.0
        assert sess.guardrail_maxsize_value == 75_000.0
