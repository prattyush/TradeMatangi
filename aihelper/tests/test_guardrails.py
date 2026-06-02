"""
Tests for Step 9 — Guardrails.

Covers:
  - guardrails.validator: sanitize_command_text, check_market_hours, validate_action
  - routers.hook: market-hours check for paper/real sessions, bypass for sim
  - routers.chat: sanitize_command_text called before LLM in _handle_command
"""
import sys
import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from datetime import datetime, timezone, timedelta

# ---------------------------------------------------------------------------
# Bootstrap: make aihelper root importable without full app startup
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_STUB_MODULES = [
    "config", "state",
    "routers.decisions", "routers.strategies",
    "processors.bounded_queue", "processors.drop_if_busy",
    "processors.background_tasks",
    "observability.tracing",
    "db.dynamo",
    "db.commands_store",
    "db.strategies_store",
    "db.decision_log_store",
    "litellm",
]
for _mod in _STUB_MODULES:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

import config as _cfg  # noqa: E402
_cfg.LOG_DIR = MagicMock()
_cfg.LOG_DIR.mkdir = MagicMock()
_cfg.PROCESSOR_TYPE = "bounded_queue"
_cfg.AI_HELPER_PORT = 8701
_cfg.MODEL_INTENT_CLASSIFIER = "deepseek/deepseek-chat"
_cfg.MODEL_COMMAND_EVALUATOR = "deepseek/deepseek-chat"
_cfg.MODEL_ANALYSIS = "openai/gpt-4o-mini"
_cfg.MODEL_FALLBACK = "openrouter/meta-llama/llama-3.1-8b-instruct:free"
_cfg.BACKEND_URL = "http://localhost:8700"
_cfg.MARKET_OPEN_IST = "09:15:00"
_cfg.MARKET_CLOSE_IST = "15:30:00"

import state as _state  # noqa: E402
_state.processor = MagicMock()
_state.processor.submit = AsyncMock()
_state.processor.clear_session = MagicMock()

# Force-evict modules that must be real in this test file so they re-import fresh
# with the correct config values set above (guards against stale stubs from other
# test files that may have imported these with a bare MagicMock config earlier).
for _real_mod in [
    "guardrails", "guardrails.validator",
    "routers.hook", "routers.chat",
]:
    sys.modules.pop(_real_mod, None)

# Also clear the submodule attributes from their parent packages so that
# `from package import submodule` always triggers a real import rather than
# returning a cached (stale) attribute from the package object.
import routers as _routers_pkg  # noqa: E402
for _attr in ("hook", "chat"):
    if hasattr(_routers_pkg, _attr):
        delattr(_routers_pkg, _attr)
import guardrails as _guardrails_pkg  # noqa: E402
if hasattr(_guardrails_pkg, "validator"):
    delattr(_guardrails_pkg, "validator")

from fastapi.testclient import TestClient  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402


# ---------------------------------------------------------------------------
# Unit tests: guardrails.validator
# ---------------------------------------------------------------------------

class TestSanitizeCommandText:
    """Unit tests for sanitize_command_text()."""

    def setup_method(self):
        from guardrails.validator import sanitize_command_text
        self.fn = sanitize_command_text

    def test_preserves_valid_trading_chars(self):
        text = "If CE bars low < prev bar low and bar is bear, buy target at (open+close)/2 ratio L"
        result = self.fn(text)
        assert "CE bars low" in result
        assert "(open+close)/2" in result
        assert "ratio L" in result

    def test_strips_backtick_injection(self):
        text = "buy CE `rm -rf /` ratio L"
        result = self.fn(text)
        assert "`" not in result

    def test_strips_dollar_sign(self):
        text = "buy CE $PATH ratio L"
        result = self.fn(text)
        assert "$" not in result

    def test_strips_pipe_and_semicolon(self):
        text = "buy CE; drop table users | ratio L"
        result = self.fn(text)
        assert "|" not in result
        assert ";" in result  # semicolons are explicitly allowed

    def test_strips_backslash(self):
        text = "buy CE \\ratio L"
        result = self.fn(text)
        assert "\\" not in result

    def test_preserves_comparison_operators(self):
        text = "if close > 89.5 and close <= 90.0 and open >= 88.0"
        result = self.fn(text)
        assert ">" in result
        assert "<=" in result
        assert ">=" in result

    def test_preserves_arithmetic_operators(self):
        text = "(open+close)/2 - 0.5 * 2"
        result = self.fn(text)
        assert "+" in result
        assert "/" in result
        assert "-" in result
        assert "*" in result

    def test_strips_leading_trailing_whitespace(self):
        text = "  buy CE  "
        result = self.fn(text)
        assert result == result.strip()

    def test_empty_string_returns_empty(self):
        assert self.fn("") == ""

    def test_preserves_numbers_and_decimals(self):
        text = "close crosses 89.50 then buy 3 lots"
        result = self.fn(text)
        assert "89.50" in result
        assert "3" in result


class TestCheckMarketHours:
    """Unit tests for check_market_hours()."""

    def setup_method(self):
        from guardrails.validator import check_market_hours
        self.fn = check_market_hours

    def _ist_time(self, h: int, m: int, s: int = 0) -> datetime:
        """Return a UTC datetime whose IST wall-clock value equals h:m:s."""
        ist_offset = timedelta(hours=5, minutes=30)
        # IST = UTC + 5:30 → UTC = IST - 5:30
        return datetime(2026, 5, 31, h, m, s, tzinfo=timezone.utc) - ist_offset

    def test_during_market_hours_returns_ok(self):
        # 11:00 IST → well within 09:15–15:30
        mock_utc = self._ist_time(11, 0)
        with patch("guardrails.validator.datetime") as mock_dt:
            mock_dt.now.return_value = mock_utc
            ok, reason = self.fn()
        assert ok is True
        assert reason == ""

    def test_at_market_open_returns_ok(self):
        # 09:15:00 IST — boundary is inclusive
        mock_utc = self._ist_time(9, 15, 0)
        with patch("guardrails.validator.datetime") as mock_dt:
            mock_dt.now.return_value = mock_utc
            ok, reason = self.fn()
        assert ok is True

    def test_at_market_close_returns_ok(self):
        # 15:30:00 IST — boundary is inclusive
        mock_utc = self._ist_time(15, 30, 0)
        with patch("guardrails.validator.datetime") as mock_dt:
            mock_dt.now.return_value = mock_utc
            ok, reason = self.fn()
        assert ok is True

    def test_before_market_open_returns_blocked(self):
        # 09:00 IST — before 09:15
        mock_utc = self._ist_time(9, 0)
        with patch("guardrails.validator.datetime") as mock_dt:
            mock_dt.now.return_value = mock_utc
            ok, reason = self.fn()
        assert ok is False
        assert "09:00" in reason or "market" in reason.lower()

    def test_after_market_close_returns_blocked(self):
        # 16:00 IST — after 15:30
        mock_utc = self._ist_time(16, 0)
        with patch("guardrails.validator.datetime") as mock_dt:
            mock_dt.now.return_value = mock_utc
            ok, reason = self.fn()
        assert ok is False
        assert "16:00" in reason or "market" in reason.lower()

    def test_midnight_ist_returns_blocked(self):
        # 00:00 IST — well outside market hours
        mock_utc = self._ist_time(0, 0)
        with patch("guardrails.validator.datetime") as mock_dt:
            mock_dt.now.return_value = mock_utc
            ok, reason = self.fn()
        assert ok is False


class TestValidateAction:
    """Unit tests for validate_action()."""

    def setup_method(self):
        from guardrails.validator import validate_action
        self.fn = validate_action

    def test_valid_buy_no_position(self):
        action = {"side": "BUY", "quantity_type": "ratio_l"}
        ok, reason = self.fn(action, None)
        assert ok is True
        assert reason == ""

    def test_valid_sell_with_position(self):
        action = {"side": "SELL", "quantity_type": "ratio_m"}
        position = {"side": "BUY", "qty": 3}
        ok, reason = self.fn(action, position)
        assert ok is True
        assert reason == ""

    def test_valid_buy_all_quantity_types(self):
        for qty_type in ("ratio_l", "ratio_m", "ratio_h", "pct_position", "fixed"):
            action = {"side": "BUY", "quantity_type": qty_type}
            ok, _ = self.fn(action, None)
            assert ok is True, f"Expected ok for quantity_type={qty_type}"

    def test_invalid_side_rejected(self):
        action = {"side": "HOLD", "quantity_type": "ratio_l"}
        ok, reason = self.fn(action, None)
        assert ok is False
        assert "HOLD" in reason or "side" in reason.lower()

    def test_empty_side_rejected(self):
        action = {"side": "", "quantity_type": "ratio_l"}
        ok, reason = self.fn(action, None)
        assert ok is False

    def test_invalid_quantity_type_rejected(self):
        action = {"side": "BUY", "quantity_type": "all_in"}
        ok, reason = self.fn(action, None)
        assert ok is False
        assert "all_in" in reason or "quantity_type" in reason.lower()

    def test_buy_blocked_when_long_position_exists(self):
        action = {"side": "BUY", "quantity_type": "ratio_l"}
        position = {"side": "BUY", "qty": 3}
        ok, reason = self.fn(action, position)
        assert ok is False
        assert "BUY" in reason or "long" in reason.lower() or "position" in reason.lower()

    def test_buy_allowed_when_short_position_exists(self):
        # Closing a short via BUY should be allowed
        action = {"side": "BUY", "quantity_type": "ratio_l"}
        position = {"side": "SELL", "qty": 3}
        ok, _ = self.fn(action, position)
        assert ok is True

    def test_sell_blocked_when_no_position(self):
        action = {"side": "SELL", "quantity_type": "ratio_l"}
        ok, reason = self.fn(action, None)
        assert ok is False
        assert "SELL" in reason or "position" in reason.lower()

    def test_sell_blocked_when_zero_qty_position(self):
        action = {"side": "SELL", "quantity_type": "ratio_l"}
        position = {"side": "BUY", "qty": 0}
        ok, reason = self.fn(action, position)
        assert ok is False

    def test_side_comparison_case_insensitive(self):
        # action.side lowercase should still be normalised
        action = {"side": "buy", "quantity_type": "ratio_l"}
        ok, _ = self.fn(action, None)
        assert ok is True


# ---------------------------------------------------------------------------
# Integration tests: routers.hook — market hours check
# ---------------------------------------------------------------------------

from routers import hook as hook_module  # noqa: E402

_hook_app = FastAPI()
_hook_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_hook_app.include_router(hook_module.router)

hook_client = TestClient(_hook_app, raise_server_exceptions=True)

_ACTIVE_CMD = {
    "command_id": "cmd-g1",
    "user_id": "u1",
    "session_id": "sess-g1",
    "command_text": "Buy when CE low < prev bar low",
    "status": "active",
    "order_type": "market",
    "quantity_type": "ratio_l",
    "parsed_trigger": "CE low < prev_bar.low",
    "parsed_price_expr": "market",
}

_SAMPLE_BARS = [
    {"time": "2026-05-31T09:15:00+00:00", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5}
] * 5

_HOOK_PAYLOAD_BASE = {
    "user_id": "u1",
    "session_id": "sess-g1",
    "symbol": "NIFTY",
    "right": "CE",
    "bars": _SAMPLE_BARS,
    "position": None,
    "timestamp": "2026-05-31T09:18:00+00:00",
}


class TestBarCloseHookMarketHours:
    """Integration tests for market-hours guardrail in /hook/bar-close."""

    def _make_payload(self, session_type: str | None = None) -> dict:
        p = dict(_HOOK_PAYLOAD_BASE)
        if session_type is not None:
            p["session_type"] = session_type
        return p

    def test_sim_session_bypasses_market_hours_check(self):
        """Simulation sessions are never blocked by the market-hours guardrail."""
        payload = self._make_payload(session_type="sim")
        with patch("routers.hook.commands_store.get_active_commands_for_session", return_value=[_ACTIVE_CMD]), \
             patch("guardrails.validator.check_market_hours", return_value=(False, "Outside hours")) as mock_check:
            resp = hook_client.post("/hook/bar-close", json=payload)
        # check_market_hours should NOT be called for sim sessions
        mock_check.assert_not_called()
        assert resp.status_code == 200
        assert resp.json()["status"] == "received"

    def test_none_session_type_bypasses_market_hours_check(self):
        """session_type=None (default) is treated as simulation — no market hours check."""
        payload = self._make_payload(session_type=None)
        with patch("routers.hook.commands_store.get_active_commands_for_session", return_value=[_ACTIVE_CMD]), \
             patch("guardrails.validator.check_market_hours", return_value=(False, "Outside hours")) as mock_check:
            resp = hook_client.post("/hook/bar-close", json=payload)
        mock_check.assert_not_called()
        assert resp.json()["status"] == "received"

    def test_paper_session_outside_market_hours_is_blocked(self):
        payload = self._make_payload(session_type="paper")
        with patch("routers.hook.commands_store.get_active_commands_for_session", return_value=[_ACTIVE_CMD]), \
             patch("routers.hook.check_market_hours", return_value=(False, "Outside market hours (08:00:00 IST; market 09:15–15:30)")):
            resp = hook_client.post("/hook/bar-close", json=payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "outside_market_hours"
        assert resp.json()["commands"] == 0

    def test_real_session_outside_market_hours_is_blocked(self):
        payload = self._make_payload(session_type="real")
        with patch("routers.hook.commands_store.get_active_commands_for_session", return_value=[_ACTIVE_CMD]), \
             patch("routers.hook.check_market_hours", return_value=(False, "Outside market hours")):
            resp = hook_client.post("/hook/bar-close", json=payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "outside_market_hours"

    def test_paper_session_during_market_hours_proceeds(self):
        payload = self._make_payload(session_type="paper")
        with patch("routers.hook.commands_store.get_active_commands_for_session", return_value=[_ACTIVE_CMD]), \
             patch("routers.hook.check_market_hours", return_value=(True, "")):
            resp = hook_client.post("/hook/bar-close", json=payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "received"

    def test_real_session_during_market_hours_proceeds(self):
        payload = self._make_payload(session_type="real")
        with patch("routers.hook.commands_store.get_active_commands_for_session", return_value=[_ACTIVE_CMD]), \
             patch("routers.hook.check_market_hours", return_value=(True, "")):
            resp = hook_client.post("/hook/bar-close", json=payload)
        assert resp.status_code == 200
        assert resp.json()["status"] == "received"

    def test_market_hours_not_checked_when_no_commands(self):
        """If there are no commands, the market-hours check is never reached."""
        payload = self._make_payload(session_type="paper")
        with patch("routers.hook.commands_store.get_active_commands_for_session", return_value=[]), \
             patch("guardrails.validator.check_market_hours", return_value=(False, "Closed")) as mock_check:
            resp = hook_client.post("/hook/bar-close", json=payload)
        mock_check.assert_not_called()
        assert resp.json()["status"] == "no_commands"


# ---------------------------------------------------------------------------
# Integration tests: routers.chat — input sanitization
# ---------------------------------------------------------------------------

from routers import chat as chat_module  # noqa: E402

_chat_app = FastAPI()
_chat_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_chat_app.include_router(chat_module.router)

chat_client = TestClient(_chat_app, raise_server_exceptions=True)

_CHAT_BODY = {
    "message": "If CE bars low crosses low of prev bar, buy target at (open+close)/2 ratio L",
    "session_id": "sess-g2",
    "user_id": "u2",
    "symbol": "NIFTY",
    "strike_ce": 24400,
    "strike_pe": 24350,
}

_EXTRACTED_FIELDS = {
    "order_type": "target",
    "quantity_type": "ratio_l",
    "right": "CE",
    "trigger": "CE low < prev_bar.low",
    "price_expr": "(open+close)/2",
    "missing_fields": [],
}


class TestChatCommandSanitization:
    """Verify sanitize_command_text is called before LLM in _handle_command."""

    def test_sanitize_called_before_llm_extract(self):
        """sanitize_command_text must be called with the raw message before extract_command_fields."""
        from guardrails.validator import sanitize_command_text as _real_sanitize
        classify = AsyncMock(return_value=("entry_command", 0.95))
        notify = AsyncMock()
        captured_extract_args = []
        sanitize_call_count = [0]

        def tracking_sanitize(text):
            sanitize_call_count[0] += 1
            return _real_sanitize(text)

        async def capture_extract(text):
            captured_extract_args.append(text)
            return _EXTRACTED_FIELDS

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.llm_service.extract_command_fields", new=capture_extract), \
             patch("routers.chat.sanitize_command_text", side_effect=tracking_sanitize), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=notify), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = chat_client.post("/ai/chat", json=_CHAT_BODY)

        assert resp.status_code == 200
        # sanitize was called exactly once
        assert sanitize_call_count[0] == 1
        # extract received the sanitized version of the raw message
        assert len(captured_extract_args) == 1
        assert captured_extract_args[0] == _real_sanitize(_CHAT_BODY["message"])

    def test_injection_chars_stripped_from_command_text(self):
        """Command text with injection chars: LLM is called with sanitized text."""
        dirty_body = dict(_CHAT_BODY)
        dirty_body["message"] = "If CE low < prev low buy `os.system()` ratio L"

        classify = AsyncMock(return_value=("entry_command", 0.95))
        extract = AsyncMock(return_value=_EXTRACTED_FIELDS)
        notify = AsyncMock()

        captured_calls = []

        async def capture_extract(text):
            captured_calls.append(text)
            return _EXTRACTED_FIELDS

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.llm_service.extract_command_fields", new=capture_extract), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=notify), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = chat_client.post("/ai/chat", json=dirty_body)

        assert resp.status_code == 200
        assert len(captured_calls) == 1
        assert "`" not in captured_calls[0]

    def test_sanitized_text_stored_as_command_text(self):
        """The command_text persisted to DynamoDB should be the sanitized version."""
        dirty_body = dict(_CHAT_BODY)
        dirty_body["message"] = "buy CE`injection` ratio L target"

        classify = AsyncMock(return_value=("entry_command", 0.95))
        extract = AsyncMock(return_value=_EXTRACTED_FIELDS)
        notify = AsyncMock()
        stored_items = []

        def capture_put(item):
            stored_items.append(item)

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.llm_service.extract_command_fields", new=extract), \
             patch("db.commands_store.put_command", side_effect=capture_put), \
             patch("services.backend_client.notify_ai_commands_active", new=notify), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = chat_client.post("/ai/chat", json=dirty_body)

        assert resp.status_code == 200
        assert len(stored_items) == 1
        assert "`" not in stored_items[0]["command_text"]
