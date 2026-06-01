"""
Tests for GET /ai/session/{session_id}/commands and
         DELETE /ai/commands/{command_id}?user_id={user_id}
"""
import sys
import os
import pytest
from unittest.mock import patch, MagicMock

# Make aihelper root importable without running full app startup
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Stub out heavy imports before importing the router
_stub_modules = [
    "config", "state",
    "routers.chat", "routers.hook", "routers.decisions", "routers.strategies",
    "services.llm_service", "services.intent_classifier",
    "services.command_evaluator", "services.analysis_service",
    "services.backend_client",
    "processors.bounded_queue", "processors.drop_if_busy",
    "processors.background_tasks",
    "observability.tracing",
    "db.dynamo",
    "db.decision_log_store",
    "db.strategies_store",
    "langfuse", "langfuse.decorators",
    "litellm",
]
for _mod in _stub_modules:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

# Stub config attributes needed by main.py
import config as _cfg  # noqa: E402
_cfg.LOG_DIR = MagicMock()
_cfg.LOG_DIR.mkdir = MagicMock()
_cfg.PROCESSOR_TYPE = "bounded_queue"
_cfg.AI_HELPER_PORT = 8701

import state as _state  # noqa: E402
_state.processor = None

# Force-evict so we get the real commands module, not a MagicMock stub that
# another test file (test_command_evaluator.py) may have placed in sys.modules.
sys.modules.pop("routers.commands", None)
import routers as _routers_pkg  # noqa: E402
if hasattr(_routers_pkg, "commands"):
    delattr(_routers_pkg, "commands")

from fastapi.testclient import TestClient  # noqa: E402
from routers import commands  # noqa: E402

# Minimal FastAPI app — only the commands router
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

_app = FastAPI()
_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_app.include_router(commands.router)

client = TestClient(_app, raise_server_exceptions=True)

# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------

_SESSION_ID = "sess-abc"
_USER_ID = "user-xyz"
_CMD_ID_1 = "cmd-111"
_CMD_ID_2 = "cmd-222"
_CMD_ID_3 = "cmd-333"

_ACTIVE_CMD = {
    "command_id": _CMD_ID_1,
    "user_id": _USER_ID,
    "session_id": _SESSION_ID,
    "command_text": "Buy when CE low < prev bar low",
    "status": "active",
    "order_type": "market",
    "quantity_type": "ratio_l",
    "parsed_trigger": "CE low < prev_bar.low AND bear",
    "parsed_price_expr": "market",
    "symbol": "NIFTY",
    "right": "CE",
    "strike": 24400,
    "created_at": "2026-05-31T09:20:00+00:00",
}

_EXECUTED_CMD = {
    "command_id": _CMD_ID_2,
    "user_id": _USER_ID,
    "session_id": _SESSION_ID,
    "command_text": "Buy when CE close > 89.5",
    "status": "executed",
    "order_type": "target",
    "quantity_type": "ratio_m",
    "parsed_trigger": "CE close > 89.5",
    "parsed_price_expr": "close+0.5",
    "symbol": "NIFTY",
    "right": "CE",
    "created_at": "2026-05-31T09:15:00+00:00",
    "fired_at": "2026-05-31T09:45:00+00:00",
}

_CANCELLED_CMD = {
    "command_id": _CMD_ID_3,
    "user_id": _USER_ID,
    "session_id": _SESSION_ID,
    "command_text": "Sell when PE low < 89",
    "status": "cancelled",
    "order_type": "limit",
    "quantity_type": "ratio_h",
    "parsed_trigger": "PE low < 89",
    "parsed_price_expr": "89",
    "cancel_reason": "session_ended",
    "created_at": "2026-05-31T09:10:00+00:00",
}


# ---------------------------------------------------------------------------
# GET /ai/session/{session_id}/commands
# ---------------------------------------------------------------------------

class TestListCommands:
    def test_returns_all_commands_for_session(self):
        all_cmds = [_ACTIVE_CMD, _EXECUTED_CMD, _CANCELLED_CMD]
        with patch("routers.commands.commands_store.list_all_commands_for_session", return_value=all_cmds):
            resp = client.get(f"/ai/session/{_SESSION_ID}/commands")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 3
        statuses = {item["status"] for item in data}
        assert statuses == {"active", "executed", "cancelled"}

    def test_returns_empty_list_when_no_commands(self):
        with patch("routers.commands.commands_store.list_all_commands_for_session", return_value=[]):
            resp = client.get(f"/ai/session/{_SESSION_ID}/commands")
        assert resp.status_code == 200
        assert resp.json() == []

    def test_does_not_include_other_session_commands(self):
        """The store handles filtering; router only calls list_all_commands_for_session."""
        with patch(
            "routers.commands.commands_store.list_all_commands_for_session",
            return_value=[_ACTIVE_CMD],
        ) as mock_list:
            resp = client.get(f"/ai/session/{_SESSION_ID}/commands")
        mock_list.assert_called_once_with(_SESSION_ID)
        assert len(resp.json()) == 1

    def test_active_command_fields_serialised(self):
        with patch("routers.commands.commands_store.list_all_commands_for_session", return_value=[_ACTIVE_CMD]):
            resp = client.get(f"/ai/session/{_SESSION_ID}/commands")
        item = resp.json()[0]
        assert item["command_id"] == _CMD_ID_1
        assert item["status"] == "active"
        assert item["order_type"] == "market"
        assert item["quantity_type"] == "ratio_l"
        assert item["right"] == "CE"
        assert item["strike"] == 24400
        assert item["hotword"] is None
        assert item["fired_at"] is None
        assert item["cancel_reason"] is None

    def test_executed_command_has_fired_at(self):
        with patch("routers.commands.commands_store.list_all_commands_for_session", return_value=[_EXECUTED_CMD]):
            resp = client.get(f"/ai/session/{_SESSION_ID}/commands")
        item = resp.json()[0]
        assert item["status"] == "executed"
        assert item["fired_at"] is not None

    def test_cancelled_command_has_cancel_reason(self):
        with patch("routers.commands.commands_store.list_all_commands_for_session", return_value=[_CANCELLED_CMD]):
            resp = client.get(f"/ai/session/{_SESSION_ID}/commands")
        item = resp.json()[0]
        assert item["status"] == "cancelled"
        assert item["cancel_reason"] == "session_ended"

    def test_store_exception_returns_empty_list(self):
        with patch(
            "routers.commands.commands_store.list_all_commands_for_session",
            side_effect=Exception("DynamoDB unreachable"),
        ):
            resp = client.get(f"/ai/session/{_SESSION_ID}/commands")
        assert resp.status_code == 200
        assert resp.json() == []


# ---------------------------------------------------------------------------
# DELETE /ai/commands/{command_id}?user_id={user_id}
# ---------------------------------------------------------------------------

class TestCancelCommand:
    def test_cancels_active_command(self):
        with patch("routers.commands.commands_store.get_command", return_value=_ACTIVE_CMD), \
             patch("routers.commands.commands_store.cancel_command") as mock_cancel:
            resp = client.delete(f"/ai/commands/{_CMD_ID_1}?user_id={_USER_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["cancelled"] is True
        assert body["command_id"] == _CMD_ID_1
        mock_cancel.assert_called_once_with(_USER_ID, _CMD_ID_1, reason="user_cancelled")

    def test_returns_404_for_unknown_command(self):
        with patch("routers.commands.commands_store.get_command", return_value=None):
            resp = client.delete(f"/ai/commands/no-such-cmd?user_id={_USER_ID}")
        assert resp.status_code == 404
        assert "not found" in resp.json()["detail"].lower()

    def test_returns_400_for_already_executed_command(self):
        with patch("routers.commands.commands_store.get_command", return_value=_EXECUTED_CMD), \
             patch("routers.commands.commands_store.cancel_command") as mock_cancel:
            resp = client.delete(f"/ai/commands/{_CMD_ID_2}?user_id={_USER_ID}")
        assert resp.status_code == 400
        assert "executed" in resp.json()["detail"]
        mock_cancel.assert_not_called()

    def test_returns_400_for_already_cancelled_command(self):
        with patch("routers.commands.commands_store.get_command", return_value=_CANCELLED_CMD), \
             patch("routers.commands.commands_store.cancel_command") as mock_cancel:
            resp = client.delete(f"/ai/commands/{_CMD_ID_3}?user_id={_USER_ID}")
        assert resp.status_code == 400
        assert "cancelled" in resp.json()["detail"]
        mock_cancel.assert_not_called()

    def test_requires_user_id_query_param(self):
        resp = client.delete(f"/ai/commands/{_CMD_ID_1}")
        assert resp.status_code == 422  # FastAPI validation error — missing required query param
