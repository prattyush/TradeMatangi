"""
Tests for the exit command flow in routers/chat.py.

Covers:
  - Missing required fields → validation_required + EXIT_VALIDATION_PROMPT
  - Valid exit command → watching status + command_id returned
  - FLAT position advisory warning included in message
  - "entry_command" intent still routes to _handle_command (entry path unchanged)
"""
import sys
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_STUB_MODULES = [
    "config", "state",
    "db.dynamo",
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

def _noop_observe(**_kw):
    def _dec(fn):
        return fn
    return _dec

_obs_stub = MagicMock()
_obs_stub.observe = _noop_observe
sys.modules["observability.tracing"] = _obs_stub

for _evict in [
    "guardrails", "guardrails.validator",
    "routers.chat", "routers.hook", "routers.decisions", "routers.strategies",
    "services.command_evaluator",
]:
    sys.modules.pop(_evict, None)

import routers as _routers_pkg  # noqa: E402
for _attr in ("chat", "hook", "decisions", "strategies"):
    if hasattr(_routers_pkg, _attr):
        delattr(_routers_pkg, _attr)
import guardrails as _guardrails_pkg  # noqa: E402
if hasattr(_guardrails_pkg, "validator"):
    delattr(_guardrails_pkg, "validator")

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from routers import chat as chat_module  # noqa: E402

sys.modules["routers.chat"] = chat_module

_app = FastAPI()
_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_app.include_router(chat_module.router)

client = TestClient(_app, raise_server_exceptions=True)

# ---------------------------------------------------------------------------
# Shared data
# ---------------------------------------------------------------------------

_USER_ID = "user-chat-exit-001"
_SESSION_ID = "sess-chat-exit-001"

_EXIT_CHAT_BODY = {
    "message": "Exit CE position when the first bear body bar appears",
    "session_id": _SESSION_ID,
    "user_id": _USER_ID,
    "symbol": "NIFTY",
    "strike_ce": 24400,
    "strike_pe": 24350,
}

_VALID_EXIT_FIELDS = {
    "right": "CE",
    "trigger_right": "CE",
    "exit_action": "exit_position",
    "exit_price_expr": None,
    "trigger": "first bear body bar",
    "hotword": None,
    "missing_fields": [],
}

_MISSING_EXIT_FIELDS = {
    "right": "CE",
    "trigger_right": "CE",
    "exit_action": None,
    "exit_price_expr": None,
    "trigger": "some bar condition",
    "hotword": None,
    "missing_fields": ["exit_action"],
}


# ---------------------------------------------------------------------------
# Tests: validation
# ---------------------------------------------------------------------------

class TestExitCommandValidation:
    """Missing required exit fields → validation_required response."""

    def test_missing_exit_action_returns_validation_required(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("exit_command", 0.95))), \
             patch("services.llm_service.extract_exit_command_fields", new=AsyncMock(return_value=_MISSING_EXIT_FIELDS)):
            resp = client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "validation_required"
        assert "exit" in body["message"].lower() or "action" in body["message"].lower()

    def test_validation_prompt_mentions_exit_examples(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("exit_command", 0.95))), \
             patch("services.llm_service.extract_exit_command_fields", new=AsyncMock(return_value=_MISSING_EXIT_FIELDS)):
            resp = client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        body = resp.json()
        assert "exit" in body["message"].lower()


# ---------------------------------------------------------------------------
# Tests: successful registration
# ---------------------------------------------------------------------------

class TestExitCommandRegistered:
    """Valid exit command → watching status, command_id in response."""

    def test_returns_watching_status(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("exit_command", 0.95))), \
             patch("services.llm_service.extract_exit_command_fields", new=AsyncMock(return_value=_VALID_EXIT_FIELDS)), \
             patch("services.backend_client.get_position", new=AsyncMock(return_value={"side": "LONG", "qty": 50})), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()):
            resp = client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "watching"

    def test_returns_command_id(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("exit_command", 0.95))), \
             patch("services.llm_service.extract_exit_command_fields", new=AsyncMock(return_value=_VALID_EXIT_FIELDS)), \
             patch("services.backend_client.get_position", new=AsyncMock(return_value={"side": "LONG", "qty": 50})), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()):
            resp = client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        body = resp.json()
        assert body["command_id"] is not None
        assert len(body["command_id"]) > 0

    def test_command_stored_with_exit_type(self):
        stored = []
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("exit_command", 0.95))), \
             patch("services.llm_service.extract_exit_command_fields", new=AsyncMock(return_value=_VALID_EXIT_FIELDS)), \
             patch("services.backend_client.get_position", new=AsyncMock(return_value={"side": "LONG", "qty": 50})), \
             patch("db.commands_store.put_command", side_effect=stored.append), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()):
            client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        assert len(stored) == 1
        item = stored[0]
        assert item["command_type"] == "exit"
        assert item["exit_action"] == "exit_position"
        assert item["session_id"] == _SESSION_ID


# ---------------------------------------------------------------------------
# Tests: advisory position warning
# ---------------------------------------------------------------------------

class TestExitCommandPositionWarning:
    """FLAT position → warning included in message, command still saved."""

    def test_flat_position_warning_in_message(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("exit_command", 0.95))), \
             patch("services.llm_service.extract_exit_command_fields", new=AsyncMock(return_value=_VALID_EXIT_FIELDS)), \
             patch("services.backend_client.get_position", new=AsyncMock(return_value={"side": "FLAT", "qty": 0})), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()):
            resp = client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        body = resp.json()
        assert body["status"] == "watching"  # still saved
        assert "No open" in body["message"] or "no open" in body["message"].lower()

    def test_position_check_failure_does_not_block_registration(self):
        """If backend position check fails, command is still saved (non-fatal)."""
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("exit_command", 0.95))), \
             patch("services.llm_service.extract_exit_command_fields", new=AsyncMock(return_value=_VALID_EXIT_FIELDS)), \
             patch("services.backend_client.get_position", new=AsyncMock(side_effect=Exception("Backend down"))), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()):
            resp = client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        assert resp.status_code == 200
        assert resp.json()["status"] == "watching"


# ---------------------------------------------------------------------------
# Tests: entry command path unchanged
# ---------------------------------------------------------------------------

class TestEntryCommandUnchanged:
    """Renaming 'command' → 'entry_command' intent must not break the entry flow."""

    def test_entry_command_intent_routes_to_handle_command(self):
        entry_fields = {
            "order_type": "market",
            "quantity_type": "ratio_l",
            "right": "CE",
            "trigger": "CE low < prev_bar.low AND bear",
            "price_expr": "market",
            "hotword": None,
            "missing_fields": [],
        }
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("entry_command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=entry_fields)), \
             patch("services.backend_client.get_user_funds_ratios", new=AsyncMock(return_value={"ratio_l": 0.03, "ratio_m": 0.06, "ratio_h": 0.12})), \
             patch("db.commands_store.put_command"), \
             patch("db.strategies_store.get_strategy", return_value=None), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()):
            resp = client.post("/ai/chat", json=_EXIT_CHAT_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "watching"
        assert body["command_id"] is not None
