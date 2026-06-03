"""
Unit tests for guardrail_service.py.
"""
from __future__ import annotations

import asyncio
import pytest
from collections import deque
from dataclasses import dataclass, field
from unittest.mock import patch, MagicMock

from app.models.schemas import TradeSide
from app.services import guardrail_service as gsvc


# ── Fixtures / helpers ────────────────────────────────────────────────────────

def _make_queue():
    loop = asyncio.new_event_loop()
    q = asyncio.Queue(maxsize=100)
    return q


@dataclass
class MockSession:
    session_id: str = "sess-001"
    current_time: str = "34500"   # 09:35 IST as Unix (IST-as-UTC trick)
    strategy_interval_secs: int = 180
    session_capital: float = 150_000.0
    # guardrail runtime state
    guardrail_block_until_bar: int = 0
    guardrail_ban_active: bool = False
    guardrail_cooldown_enabled: bool = False
    guardrail_consecutive_losses: int = 0
    # snapshotted settings
    guardrail_block_bars: int = 3
    guardrail_cooldown_losses: int = 3
    guardrail_ban_capital_pct: float = 10.0
    guardrail_ban_loss_trade_pct: float = 60.0
    guardrail_ban_min_trades: int = 5
    guardrail_ban_enabled: bool = False
    queue: object = field(default_factory=lambda: MagicMock())


def _make_trade(side, price, qty=75, right=None, ts=34500):
    t = MagicMock()
    t.side = TradeSide.BUY if side == "BUY" else TradeSide.SELL
    t.price = float(price)
    t.quantity = qty
    t.right = right
    t.timestamp = ts
    t.commission = 0.0
    return t


# ── _current_bar_slot ─────────────────────────────────────────────────────────

class TestCurrentBarSlot:
    def test_aligned_boundary(self):
        sess = MockSession(current_time="34200")  # 09:30 — exact boundary for 3-min bars
        slot = gsvc._current_bar_slot(sess)
        assert slot == 34200

    def test_mid_bar(self):
        sess = MockSession(current_time="34350")  # 09:32:30 — mid-bar
        slot = gsvc._current_bar_slot(sess)
        assert slot == 34200  # floor to 09:30 bar

    def test_none_time(self):
        sess = MockSession(current_time=None)
        slot = gsvc._current_bar_slot(sess)
        assert slot == 0

    def test_5min_interval(self):
        sess = MockSession(current_time="34560", strategy_interval_secs=300)  # 09:36
        slot = gsvc._current_bar_slot(sess)
        assert slot == 34500  # 09:35 bar


# ── check_guardrails ──────────────────────────────────────────────────────────

class TestCheckGuardrails:
    def test_no_guardrail_active_allows_trade(self):
        sess = MockSession()
        blocked, reason = gsvc.check_guardrails(sess)
        assert not blocked
        assert reason == ""

    def test_ban_active_blocks(self):
        sess = MockSession()
        sess.guardrail_ban_active = True
        blocked, reason = gsvc.check_guardrails(sess)
        assert blocked
        assert "BAN" in reason

    def test_block_until_bar_in_future_blocks(self):
        # current_time=34500 → slot=34380 (34500//180*180=34380)
        sess = MockSession(current_time="34500")
        # block until bar 34380 + 3*180 = 34920
        sess.guardrail_block_until_bar = 34920
        blocked, reason = gsvc.check_guardrails(sess)
        assert blocked
        assert "BLOCK" in reason

    def test_block_until_bar_expired_allows_trade(self):
        # current slot = 34380, block_until_bar is in the past
        sess = MockSession(current_time="34500")
        sess.guardrail_block_until_bar = 34000
        blocked, reason = gsvc.check_guardrails(sess)
        assert not blocked

    def test_ban_takes_priority_over_block(self):
        sess = MockSession(current_time="34500")
        sess.guardrail_ban_active = True
        sess.guardrail_block_until_bar = 99999
        blocked, reason = gsvc.check_guardrails(sess)
        assert blocked
        assert "BAN" in reason


# ── trigger_block ─────────────────────────────────────────────────────────────

class TestTriggerBlock:
    def test_sets_block_until_bar(self):
        sess = MockSession(current_time="34200")  # slot = 34200
        reason, until_bar = gsvc.trigger_block(sess)
        # until_bar = 34200 + 3*180 = 34740
        assert until_bar == 34200 + 3 * 180
        assert sess.guardrail_block_until_bar == until_bar

    def test_reason_string_contains_block(self):
        sess = MockSession()
        reason, _ = gsvc.trigger_block(sess)
        assert "BLOCK" in reason

    def test_custom_n_bars(self):
        sess = MockSession(current_time="34200")
        sess.guardrail_block_bars = 5
        _, until_bar = gsvc.trigger_block(sess)
        assert until_bar == 34200 + 5 * 180

    def test_emits_sse_event(self):
        sess = MockSession()
        mock_q = MagicMock()
        sess.queue = mock_q
        gsvc.trigger_block(sess)
        mock_q.put_nowait.assert_called_once()
        arg = mock_q.put_nowait.call_args[0][0]
        import json
        event = json.loads(arg)
        assert event["guardrail_type"] == "BLOCK"


# ── _count_consecutive_losses ─────────────────────────────────────────────────

class TestCountConsecutiveLosses:
    def test_no_trades_returns_zero(self):
        with patch("app.services.trading.get_trades", return_value=[]):
            result = gsvc._count_consecutive_losses("sess-001")
        assert result == 0

    def test_single_loss_trade(self):
        # BUY at 100, SELL at 90 → loss
        trades = [
            _make_trade("BUY", 100, ts=1000),
            _make_trade("SELL", 90, ts=2000),
        ]
        with patch("app.services.trading.get_trades", return_value=trades):
            result = gsvc._count_consecutive_losses("sess-001")
        assert result == 1

    def test_single_win_trade_returns_zero(self):
        trades = [
            _make_trade("BUY", 100, ts=1000),
            _make_trade("SELL", 110, ts=2000),
        ]
        with patch("app.services.trading.get_trades", return_value=trades):
            result = gsvc._count_consecutive_losses("sess-001")
        assert result == 0

    def test_two_consecutive_losses(self):
        trades = [
            # Round-trip 1: loss
            _make_trade("BUY", 100, ts=1000),
            _make_trade("SELL", 90, ts=2000),
            # Round-trip 2: loss
            _make_trade("BUY", 100, ts=3000),
            _make_trade("SELL", 95, ts=4000),
        ]
        with patch("app.services.trading.get_trades", return_value=trades):
            result = gsvc._count_consecutive_losses("sess-001")
        assert result == 2

    def test_win_resets_consecutive_count(self):
        trades = [
            # Round-trip 1: loss
            _make_trade("BUY", 100, ts=1000),
            _make_trade("SELL", 90, ts=2000),
            # Round-trip 2: WIN — resets counter
            _make_trade("BUY", 100, ts=3000),
            _make_trade("SELL", 110, ts=4000),
            # Round-trip 3: loss
            _make_trade("BUY", 100, ts=5000),
            _make_trade("SELL", 95, ts=6000),
        ]
        with patch("app.services.trading.get_trades", return_value=trades):
            result = gsvc._count_consecutive_losses("sess-001")
        assert result == 1

    def test_open_position_not_counted(self):
        # BUY but no SELL — no completed round-trip
        trades = [_make_trade("BUY", 100, ts=1000)]
        with patch("app.services.trading.get_trades", return_value=trades):
            result = gsvc._count_consecutive_losses("sess-001")
        assert result == 0

    def test_options_ce_pe_separate_then_combined(self):
        # CE: 1 loss, PE: 1 loss → 2 consecutive losses in order
        trades = [
            _make_trade("BUY", 100, right="CE", ts=1000),
            _make_trade("SELL", 90, right="CE", ts=2000),
            _make_trade("BUY", 50, right="PE", ts=3000),
            _make_trade("SELL", 40, right="PE", ts=4000),
        ]
        with patch("app.services.trading.get_trades", return_value=trades):
            result = gsvc._count_consecutive_losses("sess-001")
        assert result == 2


# ── _compute_ban_check ────────────────────────────────────────────────────────

class TestComputeBanCheck:
    def test_no_trades_no_ban(self):
        sess = MockSession()
        with patch("app.services.trading.get_trades", return_value=[]):
            banned, reason = gsvc._compute_ban_check(sess)
        assert not banned

    def test_capital_loss_triggers_ban(self):
        sess = MockSession(session_capital=100_000.0)
        sess.guardrail_ban_capital_pct = 10.0
        # Lose ₹12,000 = 12% of capital
        trades = [
            _make_trade("BUY", 100, qty=120, ts=1000),
            _make_trade("SELL", 0, qty=120, ts=2000),  # sell at 0 = total loss
        ]
        trades[0].commission = 0.0
        trades[1].commission = 0.0
        # override sell price to create 12k loss
        trades[0].price = 100.0
        trades[0].quantity = 120
        trades[1].price = 0.0
        trades[1].quantity = 120
        with patch("app.services.trading.get_trades", return_value=trades):
            banned, reason = gsvc._compute_ban_check(sess)
        assert banned
        assert "BAN" in reason
        assert "capital loss" in reason

    def test_no_ban_when_below_threshold(self):
        sess = MockSession(session_capital=100_000.0)
        sess.guardrail_ban_capital_pct = 10.0
        sess.guardrail_ban_loss_trade_pct = 100.0  # disable loss-trade check for this test
        sess.guardrail_ban_min_trades = 1  # allow check from first trade
        # Lose ₹5,000 = 5% of capital — below capital threshold
        trades = [
            _make_trade("BUY", 100.0, qty=50, ts=1000),
            _make_trade("SELL", 90.0, qty=50, ts=2000),
        ]
        trades[0].commission = 0.0; trades[1].commission = 0.0
        with patch("app.services.trading.get_trades", return_value=trades):
            banned, reason = gsvc._compute_ban_check(sess)
        assert not banned

    def test_loss_trade_pct_triggers_ban(self):
        sess = MockSession(session_capital=100_000.0)
        sess.guardrail_ban_loss_trade_pct = 60.0
        sess.guardrail_ban_min_trades = 4  # 4 round-trips required before check applies
        # 3 loss trades, 1 win trade = 75% loss rate (4 trades total — meets min_trades threshold)
        trades = [
            # win
            _make_trade("BUY", 100, ts=1000), _make_trade("SELL", 110, ts=2000),
            # loss
            _make_trade("BUY", 100, ts=3000), _make_trade("SELL", 95, ts=4000),
            _make_trade("BUY", 100, ts=5000), _make_trade("SELL", 95, ts=6000),
            _make_trade("BUY", 100, ts=7000), _make_trade("SELL", 95, ts=8000),
        ]
        for t in trades:
            t.commission = 0.0
        with patch("app.services.trading.get_trades", return_value=trades):
            banned, reason = gsvc._compute_ban_check(sess)
        assert banned
        assert "BAN" in reason

    def test_zero_capital_no_ban(self):
        sess = MockSession(session_capital=0.0)
        trades = [_make_trade("BUY", 100, ts=1000), _make_trade("SELL", 80, ts=2000)]
        for t in trades: t.commission = 0.0
        with patch("app.services.trading.get_trades", return_value=trades):
            banned, reason = gsvc._compute_ban_check(sess)
        assert not banned

    def test_loss_trade_pct_skipped_below_min_trades(self):
        """Loss-trade % check must not trigger until min_trades round-trips are done."""
        sess = MockSession(session_capital=100_000.0)
        sess.guardrail_ban_capital_pct = 50.0   # high capital threshold — won't trigger
        sess.guardrail_ban_loss_trade_pct = 60.0
        sess.guardrail_ban_min_trades = 5       # need 5 trades before check applies
        # Only 3 round-trips completed (all losses = 100% loss rate) — below min_trades
        trades = [
            _make_trade("BUY", 100, ts=1000), _make_trade("SELL", 95, ts=2000),
            _make_trade("BUY", 100, ts=3000), _make_trade("SELL", 95, ts=4000),
            _make_trade("BUY", 100, ts=5000), _make_trade("SELL", 95, ts=6000),
        ]
        for t in trades:
            t.commission = 0.0
        with patch("app.services.trading.get_trades", return_value=trades):
            banned, reason = gsvc._compute_ban_check(sess)
        assert not banned  # loss-trade % not evaluated yet

    def test_capital_loss_triggers_ban_regardless_of_min_trades(self):
        """Capital loss % must fire on the very first trade — min_trades does not gate it."""
        sess = MockSession(session_capital=100_000.0)
        sess.guardrail_ban_capital_pct = 10.0
        sess.guardrail_ban_loss_trade_pct = 60.0
        sess.guardrail_ban_min_trades = 10  # high min_trades — loss-trade % would be skipped
        # Single trade: BUY 150 @ 100, SELL 150 @ 0 → ₹15,000 loss = 15% of capital
        trades = [
            _make_trade("BUY", 100.0, qty=150, ts=1000),
            _make_trade("SELL", 0.0, qty=150, ts=2000),
        ]
        for t in trades:
            t.commission = 0.0
        with patch("app.services.trading.get_trades", return_value=trades):
            banned, reason = gsvc._compute_ban_check(sess)
        assert banned
        assert "capital loss" in reason  # capital check fired on trade 1

    def test_loss_trade_pct_triggers_after_min_trades_reached(self):
        """Loss-trade % check fires once min_trades is met."""
        sess = MockSession(session_capital=100_000.0)
        sess.guardrail_ban_capital_pct = 50.0   # high capital threshold — won't trigger
        sess.guardrail_ban_loss_trade_pct = 60.0
        sess.guardrail_ban_min_trades = 3       # need 3 trades before check applies
        # 3 round-trips: 1 win, 2 losses = 67% loss rate → exceeds 60% threshold
        trades = [
            _make_trade("BUY", 100, ts=1000), _make_trade("SELL", 110, ts=2000),  # win
            _make_trade("BUY", 100, ts=3000), _make_trade("SELL", 95, ts=4000),   # loss
            _make_trade("BUY", 100, ts=5000), _make_trade("SELL", 95, ts=6000),   # loss
        ]
        for t in trades:
            t.commission = 0.0
        with patch("app.services.trading.get_trades", return_value=trades):
            banned, reason = gsvc._compute_ban_check(sess)
        assert banned
        assert "BAN" in reason


# ── initialize_guardrails ─────────────────────────────────────────────────────

class TestInitializeGuardrails:
    def test_snapshots_settings_onto_session(self):
        sess = MockSession()
        settings = {
            "guardrail_block_bars": 5,
            "guardrail_cooldown_losses": 4,
            "guardrail_ban_capital_pct": 15.0,
            "guardrail_ban_loss_trade_pct": 70.0,
            "guardrail_ban_min_trades": 8,
            "guardrail_ban_enabled": True,
            "guardrail_cooldown_enabled": True,
        }
        with patch("app.services.user_settings_service.get_settings", return_value=settings):
            gsvc.initialize_guardrails(sess, "user-123")
        assert sess.guardrail_block_bars == 5
        assert sess.guardrail_cooldown_losses == 4
        assert sess.guardrail_ban_capital_pct == 15.0
        assert sess.guardrail_ban_min_trades == 8
        assert sess.guardrail_ban_enabled is True
        assert sess.guardrail_cooldown_enabled is True

    def test_resets_runtime_state(self):
        sess = MockSession()
        sess.guardrail_ban_active = True
        sess.guardrail_block_until_bar = 99999
        sess.guardrail_consecutive_losses = 5
        with patch("app.services.user_settings_service.get_settings", return_value={}):
            gsvc.initialize_guardrails(sess, "user-123")
        assert sess.guardrail_ban_active is False
        assert sess.guardrail_block_until_bar == 0
        assert sess.guardrail_consecutive_losses == 0

    def test_uses_defaults_on_db_error(self):
        sess = MockSession()
        with patch("app.services.user_settings_service.get_settings", side_effect=RuntimeError("DB error")):
            gsvc.initialize_guardrails(sess, "user-123")
        assert sess.guardrail_block_bars == 3  # default
