"""
End-to-end integration tests.

Full flow: POST /ai/chat (register command) → POST /hook/bar-close (bar fires) →
           command_evaluator places order → decision written → GET /ai/session/{id}/decisions.

Each test exercises the wiring between components rather than re-testing individual
units (those live in test_command_evaluator.py, test_guardrails.py, etc.).
"""
import sys
import os
import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ---------------------------------------------------------------------------
# Stubs — only the heavy third-party / infra modules
# ---------------------------------------------------------------------------
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

# observability.tracing.observe must be a no-op so command_evaluator.evaluate stays a real coroutine
def _noop_observe(**_kw):
    def _dec(fn):
        return fn
    return _dec

_obs_stub = MagicMock()
_obs_stub.observe = _noop_observe
sys.modules["observability.tracing"] = _obs_stub

# Evict modules that must be re-imported fresh with the stubs above
for _evict in [
    "guardrails", "guardrails.validator",
    "routers.chat", "routers.hook", "routers.decisions",
    "routers.strategies",
    "services.command_evaluator",
    "db.commands_store", "db.decision_log_store", "db.strategies_store",
]:
    sys.modules.pop(_evict, None)

# Also clear package attributes to prevent stale lookups.
# When a prior test file imported a submodule via the import machinery, Python
# cached it as a package attribute (e.g. db.commands_store). Evicting from
# sys.modules alone is insufficient — `from db import commands_store` would
# still resolve via getattr(db, "commands_store") and return the stale object.
# Deleting the attribute forces a true fresh import.
#
# NOTE: do NOT touch routers.commands — test_commands_router.py pre-builds its
# _app at collection time and evicting the attribute would break route resolution.
import routers as _routers_pkg  # noqa: E402
for _attr in ("chat", "hook", "decisions", "strategies"):
    if hasattr(_routers_pkg, _attr):
        delattr(_routers_pkg, _attr)
import guardrails as _guardrails_pkg  # noqa: E402
if hasattr(_guardrails_pkg, "validator"):
    delattr(_guardrails_pkg, "validator")
import db as _db_pkg  # noqa: E402
for _attr in ("commands_store", "decision_log_store", "strategies_store"):
    if hasattr(_db_pkg, _attr):
        delattr(_db_pkg, _attr)

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from routers import chat as chat_module  # noqa: E402
from routers import hook as hook_module  # noqa: E402
from routers import decisions as decisions_module  # noqa: E402

# Normalise sys.modules to match the package-attribute-resolved module objects
sys.modules["routers.chat"] = chat_module
sys.modules["routers.hook"] = hook_module
sys.modules["routers.decisions"] = decisions_module

# Build a single app with all three routers for e2e tests
_app = FastAPI()
_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_app.include_router(chat_module.router)
_app.include_router(hook_module.router)
_app.include_router(decisions_module.router)

client = TestClient(_app, raise_server_exceptions=True)

# ---------------------------------------------------------------------------
# Shared test data
# ---------------------------------------------------------------------------

_USER_ID = "user-e2e-001"
_SESSION_ID = "sess-e2e-001"
_CMD_ID = "cmd-e2e-abc123"

_BARS = [
    {"time": "2026-05-31T09:15:00+00:00", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0},
    {"time": "2026-05-31T09:18:00+00:00", "open": 101.0, "high": 103.0, "low": 98.0, "close": 99.0},
]

_HOOK_PAYLOAD = {
    "user_id": _USER_ID,
    "session_id": _SESSION_ID,
    "symbol": "NIFTY",
    "right": "CE",
    "bars": _BARS,
    "position": None,
    "timestamp": "2026-05-31T09:18:00+00:00",
    "session_type": "sim",
}

_CHAT_BODY = {
    "message": "If CE bars low crosses low of previous bar and bar is bear, buy market ratio L",
    "session_id": _SESSION_ID,
    "user_id": _USER_ID,
    "symbol": "NIFTY",
    "strike_ce": 24400,
    "strike_pe": 24350,
}

_EXTRACTED_FIELDS = {
    "order_type": "market",
    "quantity_type": "ratio_l",
    "right": "CE",
    "trigger": "CE low < prev_bar.low AND bear",
    "price_expr": "market",
    "hotword": None,
    "missing_fields": [],
}

_STORED_CMD = {
    "command_id": _CMD_ID,
    "user_id": _USER_ID,
    "session_id": _SESSION_ID,
    "command_text": "If CE bars low crosses low of previous bar and bar is bear, buy market ratio L",
    "status": "active",
    "order_type": "market",
    "quantity_type": "ratio_l",
    "parsed_trigger": "CE low < prev_bar.low AND bear",
    "parsed_price_expr": "market",
    "symbol": "NIFTY",
    "right": "CE",
    "strike": 24400,
    "one_shot": True,
}

_DECISION = {
    "command_id": _CMD_ID,
    "command_text": _STORED_CMD["command_text"],
    "bar_time": "2026-05-31T09:18:00+00:00",
    "reason": "CE low (98.0) crossed below prev bar low (99.0) and bar is bear.",
    "action": {"side": "BUY", "quantity_type": "ratio_l", "price_type": "market"},
    "action_result": "order_placed",
    "timestamp": "2026-05-31T09:18:05+00:00",
}


# ---------------------------------------------------------------------------
# 1. Command registration via POST /ai/chat
# ---------------------------------------------------------------------------

class TestCommandRegistration:
    """POST /ai/chat with command intent registers the command and notifies backend."""

    def test_chat_returns_watching_status(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=_EXTRACTED_FIELDS)), \
             patch("db.commands_store.put_command") as mock_put, \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = client.post("/ai/chat", json=_CHAT_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "watching"

    def test_chat_returns_command_id(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=_EXTRACTED_FIELDS)), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = client.post("/ai/chat", json=_CHAT_BODY)

        body = resp.json()
        assert body["command_id"] is not None
        assert len(body["command_id"]) > 0

    def test_command_persisted_with_correct_fields(self):
        stored = []

        def capture_put(item):
            stored.append(item)

        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=_EXTRACTED_FIELDS)), \
             patch("db.commands_store.put_command", side_effect=capture_put), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = client.post("/ai/chat", json=_CHAT_BODY)

        assert resp.status_code == 200
        assert len(stored) == 1
        item = stored[0]
        assert item["user_id"] == _USER_ID
        assert item["session_id"] == _SESSION_ID
        assert item["symbol"] == "NIFTY"
        assert item["order_type"] == "market"
        assert item["quantity_type"] == "ratio_l"
        assert item["right"] == "CE"
        assert item["strike"] == 24400
        assert item["status"] == "active"
        assert item["one_shot"] is True

    def test_backend_notified_after_command_registered(self):
        notified_sessions = []

        async def capture_notify(session_id):
            notified_sessions.append(session_id)

        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=_EXTRACTED_FIELDS)), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=capture_notify), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = client.post("/ai/chat", json=_CHAT_BODY)

        assert resp.status_code == 200
        assert _SESSION_ID in notified_sessions

    def test_summary_contains_symbol_and_trigger(self):
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=_EXTRACTED_FIELDS)), \
             patch("db.commands_store.put_command"), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()), \
             patch("db.strategies_store.get_strategy", return_value=None):
            resp = client.post("/ai/chat", json=_CHAT_BODY)

        message = resp.json()["message"]
        assert "NIFTY" in message or "CE" in message
        assert "24400" in message

    def test_validation_required_when_fields_missing(self):
        incomplete_fields = {
            "order_type": None,
            "quantity_type": "ratio_l",
            "right": "CE",
            "trigger": None,
            "price_expr": None,
            "missing_fields": ["order_type", "trigger"],
        }
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=incomplete_fields)), \
             patch("db.commands_store.put_command") as mock_put:
            resp = client.post("/ai/chat", json=_CHAT_BODY)

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "validation_required"
        mock_put.assert_not_called()


# ---------------------------------------------------------------------------
# 2. Bar-close hook → processor submitted
# ---------------------------------------------------------------------------

class TestBarCloseHookFlow:
    """POST /hook/bar-close — hook received, processor submitted, returns 200."""

    def test_hook_returns_received_when_commands_active(self):
        with patch("db.commands_store.get_active_commands_for_session", return_value=[_STORED_CMD]):
            resp = client.post("/hook/bar-close", json=_HOOK_PAYLOAD)
        assert resp.status_code == 200
        assert resp.json()["status"] == "received"

    def test_hook_returns_no_commands_when_session_inactive(self):
        with patch("db.commands_store.get_active_commands_for_session", return_value=[]):
            resp = client.post("/hook/bar-close", json=_HOOK_PAYLOAD)
        assert resp.status_code == 200
        assert resp.json()["status"] == "no_commands"
        assert resp.json()["commands"] == 0

    def test_hook_submits_to_processor(self):
        _state.processor.submit = AsyncMock()
        with patch("db.commands_store.get_active_commands_for_session", return_value=[_STORED_CMD]):
            resp = client.post("/hook/bar-close", json=_HOOK_PAYLOAD)
        assert resp.status_code == 200
        _state.processor.submit.assert_called_once()

    def test_hook_reports_command_count(self):
        two_cmds = [_STORED_CMD, dict(_STORED_CMD, command_id="cmd-2")]
        with patch("db.commands_store.get_active_commands_for_session", return_value=two_cmds):
            resp = client.post("/hook/bar-close", json=_HOOK_PAYLOAD)
        assert resp.json()["commands"] == 2

    def test_hook_returns_error_on_db_exception(self):
        with patch("db.commands_store.get_active_commands_for_session", side_effect=Exception("DynamoDB down")):
            resp = client.post("/hook/bar-close", json=_HOOK_PAYLOAD)
        assert resp.status_code == 200
        assert resp.json()["status"] == "error"


# ---------------------------------------------------------------------------
# 3. Evaluator chain — hook → evaluate → order → decision log
# ---------------------------------------------------------------------------

class TestEvaluatorChain:
    """
    The bar-close hook triggers the processor which calls command_evaluator.evaluate().
    Here we bypass the real async queue and call evaluate() directly to test the
    full evaluation chain in one flow.
    """

    @pytest.mark.asyncio
    async def test_order_placed_and_decision_logged_on_trigger(self):
        llm_result = {
            "should_trade": True,
            "side": "BUY",
            "reason": "CE low (98.0) crossed below prev bar low (99.0) and bar is bear.",
            "computed_price": None,
        }
        placed_orders = []
        logged_decisions = []

        async def capture_order(**kwargs):
            placed_orders.append(kwargs)
            return {"ok": True}

        def capture_log(item):
            logged_decisions.append(item)

        from processors.base import BarCloseHook, OHLCBar

        hook = BarCloseHook(
            user_id=_USER_ID,
            session_id=_SESSION_ID,
            symbol="NIFTY",
            right="CE",
            bars=[OHLCBar(**b) for b in _BARS],
            position=None,
            timestamp="2026-05-31T09:18:00+00:00",
            session_type="sim",
        )

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(side_effect=capture_order)), \
             patch("db.decision_log_store.write_decision", side_effect=capture_log), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(hook, _STORED_CMD)

        assert len(placed_orders) == 1
        assert placed_orders[0]["session_id"] == _SESSION_ID
        assert placed_orders[0]["payload"]["side"] == "BUY"

        assert len(logged_decisions) == 1
        log = logged_decisions[0]
        assert log["session_id"] == _SESSION_ID
        assert log["action_result"] == "order_placed"
        assert log["action"]["side"] == "BUY"

    @pytest.mark.asyncio
    async def test_no_order_when_condition_not_met(self):
        llm_result = {
            "should_trade": False,
            "side": None,
            "reason": "CE low (101.0) did not cross below prev bar low (99.0).",
            "computed_price": None,
        }
        placed_orders = []
        logged_decisions = []

        from processors.base import BarCloseHook, OHLCBar

        hook = BarCloseHook(
            user_id=_USER_ID,
            session_id=_SESSION_ID,
            symbol="NIFTY",
            right="CE",
            bars=[OHLCBar(**b) for b in _BARS],
            position=None,
            timestamp="2026-05-31T09:18:00+00:00",
            session_type="sim",
        )

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("services.backend_client.place_order", new=AsyncMock(side_effect=lambda **kw: placed_orders.append(kw))), \
             patch("db.decision_log_store.write_decision", side_effect=lambda item: logged_decisions.append(item)):
            from services import command_evaluator
            await command_evaluator.evaluate(hook, _STORED_CMD)

        assert placed_orders == []
        assert logged_decisions == []

    @pytest.mark.asyncio
    async def test_guardrail_block_results_in_rejected_log(self):
        llm_result = {
            "should_trade": True,
            "side": "BUY",
            "reason": "Condition met.",
            "computed_price": None,
        }
        logged_decisions = []
        placed_orders = []

        from processors.base import BarCloseHook, OHLCBar

        hook = BarCloseHook(
            user_id=_USER_ID,
            session_id=_SESSION_ID,
            symbol="NIFTY",
            right="CE",
            bars=[OHLCBar(**b) for b in _BARS],
            position={"side": "BUY", "qty": 3},
            timestamp="2026-05-31T09:18:00+00:00",
            session_type="paper",
        )

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("services.backend_client.place_order", new=AsyncMock(side_effect=lambda **kw: placed_orders.append(kw))), \
             patch("db.decision_log_store.write_decision", side_effect=lambda item: logged_decisions.append(item)), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(hook, _STORED_CMD)

        assert placed_orders == []
        assert len(logged_decisions) == 1
        assert logged_decisions[0]["action_result"] == "rejected_guardrail"


# ---------------------------------------------------------------------------
# 4. Session stop — all active commands cancelled
# ---------------------------------------------------------------------------

class TestSessionStop:
    """POST /hook/session/{id}/stop cancels commands and clears processor queue."""

    def test_session_stop_cancels_commands(self):
        with patch("db.commands_store.cancel_commands_for_session", return_value=3) as mock_cancel:
            resp = client.post(f"/hook/session/{_SESSION_ID}/stop")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "cancelled"
        assert body["cancelled"] == 3
        mock_cancel.assert_called_once_with(_SESSION_ID, reason="session_ended")

    def test_session_stop_clears_processor_queue(self):
        _state.processor.clear_session = MagicMock()
        with patch("db.commands_store.cancel_commands_for_session", return_value=1):
            resp = client.post(f"/hook/session/{_SESSION_ID}/stop")
        assert resp.status_code == 200
        _state.processor.clear_session.assert_called_once_with(_SESSION_ID)

    def test_session_stop_returns_zero_when_no_active_commands(self):
        with patch("db.commands_store.cancel_commands_for_session", return_value=0):
            resp = client.post(f"/hook/session/{_SESSION_ID}/stop")
        assert resp.status_code == 200
        assert resp.json()["cancelled"] == 0

    def test_session_stop_still_succeeds_on_db_error(self):
        """Backend must NOT be blocked even if aihelper DB write fails."""
        _state.processor.clear_session = MagicMock()
        with patch("db.commands_store.cancel_commands_for_session", side_effect=Exception("DB down")):
            resp = client.post(f"/hook/session/{_SESSION_ID}/stop")
        assert resp.status_code == 200
        # cancelled count = 0 (swallowed exception)
        assert resp.json()["cancelled"] == 0


# ---------------------------------------------------------------------------
# 5. Decisions endpoint — GET /ai/session/{id}/decisions
# ---------------------------------------------------------------------------

class TestDecisionsEndpoint:
    """GET /ai/session/{session_id}/decisions returns logged LLM decisions."""

    def test_returns_decisions_for_session(self):
        with patch("db.decision_log_store.get_decisions_since", return_value=[_DECISION]):
            resp = client.get(f"/ai/session/{_SESSION_ID}/decisions")
        assert resp.status_code == 200
        items = resp.json()
        assert len(items) == 1
        assert items[0]["command_id"] == _CMD_ID
        assert items[0]["action_result"] == "order_placed"

    def test_returns_empty_list_when_no_decisions(self):
        with patch("db.decision_log_store.get_decisions_since", return_value=[]):
            resp = client.get(f"/ai/session/{_SESSION_ID}/decisions")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_since_param_forwarded_to_store(self):
        since_ts = "2026-05-31T09:15:00Z"
        with patch("db.decision_log_store.get_decisions_since", return_value=[]) as mock_get:
            resp = client.get(f"/ai/session/{_SESSION_ID}/decisions?since={since_ts}")
        assert resp.status_code == 200
        mock_get.assert_called_once_with(_SESSION_ID, since_ts=since_ts)

    def test_omitting_since_passes_none_to_store(self):
        with patch("db.decision_log_store.get_decisions_since", return_value=[]) as mock_get:
            resp = client.get(f"/ai/session/{_SESSION_ID}/decisions")
        assert resp.status_code == 200
        mock_get.assert_called_once_with(_SESSION_ID, since_ts=None)

    def test_decision_fields_serialised_correctly(self):
        with patch("db.decision_log_store.get_decisions_since", return_value=[_DECISION]):
            resp = client.get(f"/ai/session/{_SESSION_ID}/decisions")
        item = resp.json()[0]
        assert item["command_id"] == _CMD_ID
        assert item["bar_time"] == "2026-05-31T09:18:00+00:00"
        assert item["reason"] == _DECISION["reason"]
        assert item["action"]["side"] == "BUY"
        assert item["action_result"] == "order_placed"
        assert item["timestamp"] == _DECISION["timestamp"]

    def test_decisions_endpoint_returns_empty_on_store_exception(self):
        with patch("db.decision_log_store.get_decisions_since", side_effect=Exception("DynamoDB down")):
            resp = client.get(f"/ai/session/{_SESSION_ID}/decisions")
        assert resp.status_code == 200
        assert resp.json() == []


# ---------------------------------------------------------------------------
# 6. Full flow — chat → hook → decisions
# ---------------------------------------------------------------------------

class TestFullFlow:
    """
    Stitched e2e: register command via chat, trigger bar hook, verify decision appears.
    Uses captured DynamoDB writes as the shared store.
    """

    def test_full_flow_chat_to_decision(self):
        """
        1. POST /ai/chat → command registered (captured in memory)
        2. POST /hook/bar-close → processor.submit called with active command
        3. GET /ai/session/{id}/decisions → decision returned
        """
        # Track what gets stored
        stored_commands = {}
        logged_decisions = []

        def capture_put(item):
            stored_commands[item["command_id"]] = item

        # Phase 1: register command
        with patch("services.intent_classifier.classify", new=AsyncMock(return_value=("command", 0.95))), \
             patch("services.llm_service.extract_command_fields", new=AsyncMock(return_value=_EXTRACTED_FIELDS)), \
             patch("db.commands_store.put_command", side_effect=capture_put), \
             patch("services.backend_client.notify_ai_commands_active", new=AsyncMock()), \
             patch("db.strategies_store.get_strategy", return_value=None):
            chat_resp = client.post("/ai/chat", json=_CHAT_BODY)

        assert chat_resp.status_code == 200
        assert chat_resp.json()["status"] == "watching"
        assert len(stored_commands) == 1
        registered_cmd = list(stored_commands.values())[0]

        # Phase 2: bar-close hook — return the registered command as "active"
        _state.processor.submit = AsyncMock()
        with patch("db.commands_store.get_active_commands_for_session", return_value=[registered_cmd]):
            hook_resp = client.post("/hook/bar-close", json=_HOOK_PAYLOAD)

        assert hook_resp.status_code == 200
        assert hook_resp.json()["status"] == "received"
        _state.processor.submit.assert_called_once()

        # Phase 3: verify decisions endpoint returns a logged decision
        with patch("db.decision_log_store.get_decisions_since", return_value=[_DECISION]):
            dec_resp = client.get(f"/ai/session/{_SESSION_ID}/decisions")

        assert dec_resp.status_code == 200
        decisions = dec_resp.json()
        assert len(decisions) == 1
        assert decisions[0]["action_result"] == "order_placed"
