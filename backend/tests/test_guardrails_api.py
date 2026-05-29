"""
Integration tests for /api/guardrails endpoints and the order-gate in buy/sell.
"""
from __future__ import annotations

import json
import pytest
from dataclasses import dataclass, field
from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient
from app.main import app
from app.config import FIXED_USER_ID

client = TestClient(app)
HEADERS = {"X-User-Id": FIXED_USER_ID}


# ── Mock session helper ────────────────────────────────────────────────────────

def _make_mock_session(
    session_id="sess-gr-001",
    current_time="34500",
    strategy_interval_secs=180,
    block_until_bar=0,
    ban_active=False,
    cooldown_enabled=False,
    consecutive_losses=0,
    block_bars=3,
    cooldown_losses=3,
    ban_capital_pct=10.0,
    ban_loss_trade_pct=60.0,
    ban_enabled=False,
):
    sess = MagicMock()
    sess.session_id = session_id
    sess.current_time = current_time
    sess.strategy_interval_secs = strategy_interval_secs
    sess.guardrail_block_until_bar = block_until_bar
    sess.guardrail_ban_active = ban_active
    sess.guardrail_cooldown_enabled = cooldown_enabled
    sess.guardrail_consecutive_losses = consecutive_losses
    sess.guardrail_block_bars = block_bars
    sess.guardrail_cooldown_losses = cooldown_losses
    sess.guardrail_ban_capital_pct = ban_capital_pct
    sess.guardrail_ban_loss_trade_pct = ban_loss_trade_pct
    sess.guardrail_ban_enabled = ban_enabled
    sess.queue = MagicMock()
    return sess


# ── POST /api/guardrails/block ─────────────────────────────────────────────────

class TestTriggerBlockEndpoint:
    def test_triggers_block_on_valid_session(self):
        sess = _make_mock_session()
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.post(
                "/api/guardrails/block",
                json={"session_id": "sess-gr-001"},
                headers=HEADERS,
            )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "blocked"
        assert "BLOCK" in data["reason"]
        assert data["until_bar"] > 0

    def test_returns_404_for_unknown_session(self):
        with patch("app.services.simulation.get_session", return_value=None):
            resp = client.post(
                "/api/guardrails/block",
                json={"session_id": "nonexistent"},
                headers=HEADERS,
            )
        assert resp.status_code == 404

    def test_returns_409_when_ban_active(self):
        sess = _make_mock_session(ban_active=True)
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.post(
                "/api/guardrails/block",
                json={"session_id": "sess-gr-001"},
                headers=HEADERS,
            )
        assert resp.status_code == 409


# ── GET /api/guardrails/status ─────────────────────────────────────────────────

class TestGetStatusEndpoint:
    def test_returns_status_for_active_session(self):
        sess = _make_mock_session(current_time="34200", block_until_bar=34740)
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.get("/api/guardrails/status?session_id=sess-gr-001", headers=HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert "block_active" in data
        assert "ban_active" in data
        assert "settings" in data

    def test_block_active_when_within_expiry(self):
        # slot for 34200 = 34200, block_until_bar = 34740 > 34200 → blocked
        sess = _make_mock_session(current_time="34200", block_until_bar=34740)
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.get("/api/guardrails/status?session_id=sess-gr-001", headers=HEADERS)
        data = resp.json()
        assert data["block_active"] is True

    def test_block_not_active_when_expired(self):
        # slot = 34200, block_until_bar = 34000 < 34200 → expired
        sess = _make_mock_session(current_time="34200", block_until_bar=34000)
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.get("/api/guardrails/status?session_id=sess-gr-001", headers=HEADERS)
        data = resp.json()
        assert data["block_active"] is False

    def test_returns_404_for_unknown_session(self):
        with patch("app.services.simulation.get_session", return_value=None):
            resp = client.get("/api/guardrails/status?session_id=unknown", headers=HEADERS)
        assert resp.status_code == 404


# ── GET /api/guardrails/settings ──────────────────────────────────────────────

class TestGetSettingsEndpoint:
    def test_returns_default_settings(self):
        with patch("app.services.user_settings_service.get_settings", return_value={
            "guardrail_block_bars": 3,
            "guardrail_cooldown_losses": 3,
            "guardrail_ban_capital_pct": 10.0,
            "guardrail_ban_loss_trade_pct": 60.0,
            "guardrail_ban_enabled": False,
            "guardrail_cooldown_enabled": False,
        }):
            resp = client.get("/api/guardrails/settings", headers=HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["guardrail_block_bars"] == 3
        assert data["guardrail_ban_enabled"] is False

    def test_returns_custom_settings(self):
        with patch("app.services.user_settings_service.get_settings", return_value={
            "guardrail_block_bars": 5,
            "guardrail_cooldown_losses": 4,
            "guardrail_ban_capital_pct": 15.0,
            "guardrail_ban_loss_trade_pct": 70.0,
            "guardrail_ban_enabled": True,
            "guardrail_cooldown_enabled": True,
        }):
            resp = client.get("/api/guardrails/settings", headers=HEADERS)
        assert resp.status_code == 200
        data = resp.json()
        assert data["guardrail_block_bars"] == 5
        assert data["guardrail_ban_enabled"] is True


# ── POST /api/guardrails/settings ─────────────────────────────────────────────

class TestUpdateSettingsEndpoint:
    def test_updates_block_bars(self):
        with patch("app.services.user_settings_service.update_settings", return_value={
            "guardrail_block_bars": 5,
            "guardrail_cooldown_losses": 3,
            "guardrail_ban_capital_pct": 10.0,
            "guardrail_ban_loss_trade_pct": 60.0,
            "guardrail_ban_enabled": False,
            "guardrail_cooldown_enabled": False,
        }) as mock_update:
            resp = client.post(
                "/api/guardrails/settings",
                json={"guardrail_block_bars": 5},
                headers=HEADERS,
            )
        assert resp.status_code == 200
        assert resp.json()["guardrail_block_bars"] == 5

    def test_rejects_block_bars_zero(self):
        resp = client.post(
            "/api/guardrails/settings",
            json={"guardrail_block_bars": 0},
            headers=HEADERS,
        )
        assert resp.status_code == 422

    def test_rejects_block_bars_too_large(self):
        resp = client.post(
            "/api/guardrails/settings",
            json={"guardrail_block_bars": 25},
            headers=HEADERS,
        )
        assert resp.status_code == 422

    def test_rejects_ban_pct_below_minimum(self):
        resp = client.post(
            "/api/guardrails/settings",
            json={"guardrail_ban_capital_pct": 0.5},
            headers=HEADERS,
        )
        assert resp.status_code == 422


# ── Order gate: buy/sell blocked by guardrail ─────────────────────────────────

class TestOrderGuardRailGate:
    def _mock_session_for_order(self, ban_active=False, block_until=0, current_time="34500"):
        sess = MagicMock()
        sess.session_id = "sess-order-001"
        sess.current_time = current_time
        sess.strategy_interval_secs = 180
        sess.guardrail_ban_active = ban_active
        sess.guardrail_block_until_bar = block_until
        sess.instrument_type = "equity"
        sess.right = None
        sess.last_price = 100.0
        sess.last_price_ce = 0.0
        sess.last_price_pe = 0.0
        sess.symbol = "NIFTY"
        sess.session_type = "sim"
        return sess

    def test_buy_blocked_when_ban_active(self):
        sess = self._mock_session_for_order(ban_active=True)
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.post(
                "/api/trades/buy",
                json={"session_id": "sess-order-001"},
                headers=HEADERS,
            )
        assert resp.status_code == 403
        assert "GUARDRAIL" in resp.json().get("detail", "")

    def test_sell_blocked_when_ban_active(self):
        sess = self._mock_session_for_order(ban_active=True)
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.post(
                "/api/trades/sell",
                json={"session_id": "sess-order-001"},
                headers=HEADERS,
            )
        assert resp.status_code == 403
        assert "GUARDRAIL" in resp.json().get("detail", "")

    def test_buy_blocked_during_block_period(self):
        # current_time 34200, slot 34200, block_until 34740 → blocked
        sess = self._mock_session_for_order(block_until=34740, current_time="34200")
        with patch("app.services.simulation.get_session", return_value=sess):
            resp = client.post(
                "/api/trades/buy",
                json={"session_id": "sess-order-001"},
                headers=HEADERS,
            )
        assert resp.status_code == 403
