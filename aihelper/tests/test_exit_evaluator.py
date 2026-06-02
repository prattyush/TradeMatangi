"""
Unit tests for _evaluate_exit() — the exit-command branch of command_evaluator.evaluate().

Covers:
  - No position (FLAT/None) → auto_cancelled_no_position, cancel_command called
  - should_exit=False → no_exit, no backend call, no log
  - exit_position → exit_position_market called, decision logged, command marked executed
  - update_stoploss → update_or_create_stoploss called with correct args
  - start_takeprofit → start_takeprofit_strategy called
  - Guardrail block → rejected_guardrail, no backend call
  - Backend error → backend_error, command NOT marked executed
  - LLM failure → llm_error, no crash
  - Stream filter mismatch → skipped_wrong_stream
  - one_shot=False → command not marked executed after success
"""
import sys
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_STUB_MODULES = [
    "config", "state",
    "routers.chat", "routers.hook", "routers.decisions", "routers.strategies",
    "routers.commands",
    "processors.bounded_queue", "processors.drop_if_busy",
    "processors.background_tasks",
    "db.dynamo",
    "litellm",
]
for _mod in _STUB_MODULES:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

def _noop_observe(**_kwargs):
    def _decorator(fn):
        return fn
    return _decorator

import observability.tracing as _tracing_stub  # noqa: E402
if not isinstance(_tracing_stub, MagicMock):
    _tracing_stub.observe = _noop_observe
else:
    _tracing_stub.observe = _noop_observe

_obs_stub = MagicMock()
_obs_stub.observe = _noop_observe
sys.modules["observability.tracing"] = _obs_stub

sys.modules.pop("services.command_evaluator", None)

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

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_BARS = [
    {"time": "2026-05-31T09:15:00+00:00", "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0},
    {"time": "2026-05-31T09:18:00+00:00", "open": 101.0, "high": 103.0, "low": 97.0, "close": 98.0},
]

_EXIT_CMD = {
    "command_id": "exit-cmd-001",
    "user_id": "user-exit-001",
    "session_id": "sess-exit-001",
    "command_text": "Exit CE when first bear bar appears",
    "command_type": "exit",
    "exit_action": "exit_position",
    "parsed_trigger": "bear bar closes",
    "exit_price_expr": None,
    "symbol": "NIFTY",
    "right": "CE",
    "trigger_right": "CE",
    "strike": 24400,
    "one_shot": True,
}

_SL_CMD = dict(_EXIT_CMD, command_id="exit-sl-001", exit_action="update_stoploss", exit_price_expr="prev_bar.low")
_TP_CMD = dict(_EXIT_CMD, command_id="exit-tp-001", exit_action="start_takeprofit", exit_price_expr="prev_bar.high")


def _make_hook(with_position=True, right="CE"):
    from processors.base import BarCloseHook, OHLCBar, PositionInfo
    bars = [OHLCBar(**b) for b in _BARS]
    position = PositionInfo(side="LONG", qty=50, avg_entry=99.0, unrealized_pnl_pct=2.0) if with_position else None
    return BarCloseHook(
        user_id="user-exit-001",
        session_id="sess-exit-001",
        symbol="NIFTY",
        right=right,
        bars=bars,
        position=position,
        timestamp="2026-05-31T09:18:00+00:00",
        session_type="paper",
    )


# ---------------------------------------------------------------------------
# Tests: no position → auto-cancel
# ---------------------------------------------------------------------------

class TestExitNoPosition:
    """When hook.position is None or qty=0, command should be auto-cancelled."""

    @pytest.mark.asyncio
    async def test_auto_cancelled_when_position_none(self):
        with patch("db.commands_store.cancel_command") as mock_cancel:
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(with_position=False), _EXIT_CMD)
        assert result["outcome"] == "auto_cancelled_no_position"
        mock_cancel.assert_called_once_with("user-exit-001", "exit-cmd-001", reason="no_position")

    @pytest.mark.asyncio
    async def test_no_backend_call_when_auto_cancelled(self):
        with patch("db.commands_store.cancel_command"), \
             patch("services.backend_client.exit_position_market", new=AsyncMock()) as mock_exit:
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(with_position=False), _EXIT_CMD)
        mock_exit.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: no-op when should_exit=False
# ---------------------------------------------------------------------------

class TestExitNoOp:
    """LLM returns should_exit=False — no backend call, no log entry."""

    @pytest.mark.asyncio
    async def test_no_exit_when_should_exit_false(self):
        llm_result = {"should_exit": False, "exit_action": "exit_position", "computed_price": None, "reason": "Not a bear bar."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("services.backend_client.exit_position_market", new=AsyncMock()) as mock_exit, \
             patch("db.decision_log_store.write_decision") as mock_log:
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(), _EXIT_CMD)
        assert result["outcome"] == "no_exit"
        mock_exit.assert_not_called()
        mock_log.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: exit_position
# ---------------------------------------------------------------------------

class TestExitPosition:
    """should_exit=True + exit_position → exit_position_market called."""

    @pytest.mark.asyncio
    async def test_exit_position_market_called(self):
        llm_result = {"should_exit": True, "exit_action": "exit_position", "computed_price": None, "reason": "Bear bar."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")), \
             patch("services.backend_client.exit_position_market", new=AsyncMock(return_value={"ok": True})) as mock_exit, \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(), _EXIT_CMD)
        assert result["outcome"] == "exit_executed"
        mock_exit.assert_called_once_with("sess-exit-001", "CE")

    @pytest.mark.asyncio
    async def test_decision_logged_after_exit(self):
        llm_result = {"should_exit": True, "exit_action": "exit_position", "computed_price": None, "reason": "Bear bar."}
        written = []
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")), \
             patch("services.backend_client.exit_position_market", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision", side_effect=written.append), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _EXIT_CMD)
        assert len(written) == 1
        assert written[0]["action_result"] == "exit_executed"
        assert written[0]["action"]["exit_action"] == "exit_position"

    @pytest.mark.asyncio
    async def test_command_marked_executed_on_one_shot(self):
        llm_result = {"should_exit": True, "exit_action": "exit_position", "computed_price": None, "reason": "Bear bar."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")), \
             patch("services.backend_client.exit_position_market", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed") as mock_mark:
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), dict(_EXIT_CMD, one_shot=True))
        mock_mark.assert_called_once_with("user-exit-001", "exit-cmd-001")

    @pytest.mark.asyncio
    async def test_command_not_marked_when_one_shot_false(self):
        llm_result = {"should_exit": True, "exit_action": "exit_position", "computed_price": None, "reason": "Bear bar."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")), \
             patch("services.backend_client.exit_position_market", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed") as mock_mark:
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), dict(_EXIT_CMD, one_shot=False))
        mock_mark.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: update_stoploss
# ---------------------------------------------------------------------------

class TestExitUpdateStoploss:
    """should_exit=True + update_stoploss → update_or_create_stoploss called."""

    @pytest.mark.asyncio
    async def test_update_stoploss_called_with_correct_price(self):
        llm_result = {"should_exit": True, "exit_action": "update_stoploss", "computed_price": 97.0, "reason": "Shift SL."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")), \
             patch("services.backend_client.update_or_create_stoploss", new=AsyncMock(return_value={"action": "updated"})) as mock_sl, \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(), _SL_CMD)
        assert result["outcome"] == "exit_executed"
        mock_sl.assert_called_once()
        call_args = mock_sl.call_args
        assert call_args.args[0] == "sess-exit-001"  # session_id
        assert call_args.args[1] == "CE"             # right
        assert call_args.args[2] == 97.0             # trigger_price


# ---------------------------------------------------------------------------
# Tests: start_takeprofit
# ---------------------------------------------------------------------------

class TestExitStartTakeprofit:
    """should_exit=True + start_takeprofit → start_takeprofit_strategy called."""

    @pytest.mark.asyncio
    async def test_takeprofit_strategy_started(self):
        llm_result = {"should_exit": True, "exit_action": "start_takeprofit", "computed_price": 103.0, "reason": "TP at prev high."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")), \
             patch("services.backend_client.start_takeprofit_strategy", new=AsyncMock(return_value={"strategy_id": "s1"})) as mock_tp, \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(), _TP_CMD)
        assert result["outcome"] == "exit_executed"
        mock_tp.assert_called_once_with("sess-exit-001", "CE", 103.0)


# ---------------------------------------------------------------------------
# Tests: guardrail blocks
# ---------------------------------------------------------------------------

class TestExitGuardrailBlocked:
    """validate_exit_action returns False → rejected_guardrail, no backend call."""

    @pytest.mark.asyncio
    async def test_no_backend_call_when_guardrail_blocks(self):
        llm_result = {"should_exit": True, "exit_action": "exit_position", "computed_price": None, "reason": "Bear bar."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(False, "No open position")), \
             patch("services.backend_client.exit_position_market", new=AsyncMock()) as mock_exit, \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(), _EXIT_CMD)
        assert result["outcome"] == "rejected_guardrail"
        mock_exit.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: backend error
# ---------------------------------------------------------------------------

class TestExitBackendError:
    """Backend raises exception → backend_error logged, command NOT marked executed."""

    @pytest.mark.asyncio
    async def test_backend_error_does_not_mark_executed(self):
        llm_result = {"should_exit": True, "exit_action": "exit_position", "computed_price": None, "reason": "Bear bar."}
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")), \
             patch("services.backend_client.exit_position_market", new=AsyncMock(side_effect=Exception("500"))), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed") as mock_mark:
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(), _EXIT_CMD)
        assert result["outcome"] == "backend_error"
        mock_mark.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: LLM failure
# ---------------------------------------------------------------------------

class TestExitLLMFailure:
    """LLM raises exception → llm_error returned, no crash."""

    @pytest.mark.asyncio
    async def test_llm_error_returns_llm_error_outcome(self):
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(side_effect=RuntimeError("LLM down"))), \
             patch("services.backend_client.exit_position_market", new=AsyncMock()) as mock_exit:
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_hook(), _EXIT_CMD)
        assert result["outcome"] == "llm_error"
        mock_exit.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: stream filter
# ---------------------------------------------------------------------------

class TestExitStreamFilter:
    """trigger_right mismatch → skipped_wrong_stream."""

    @pytest.mark.asyncio
    async def test_skipped_when_wrong_stream(self):
        hook = _make_hook(right="PE")  # hook fires on PE
        cmd = dict(_EXIT_CMD, trigger_right="CE")  # command listens to CE
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock()) as mock_llm:
            from services import command_evaluator
            result = await command_evaluator.evaluate(hook, cmd)
        assert result["outcome"] == "skipped_wrong_stream"
        mock_llm.assert_not_called()
