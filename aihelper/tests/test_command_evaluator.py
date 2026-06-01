"""
Unit tests for services/command_evaluator.evaluate().

Covers:
  - should_trade=False: no-op — no order placed, no decision log entry
  - should_trade=True + guardrail pass: order placed, decision logged, command marked executed
  - should_trade=True + guardrail fail: log entry with rejected_guardrail, no order
  - should_trade=True + backend error: log entry with backend_error, command not marked executed
  - LLM raises exception: swallowed, no crash, no log
  - one_shot=False: command NOT marked executed after successful order
  - side normalization: lowercase "buy" from LLM → "BUY" in action
"""
import sys
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch, call

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_STUB_MODULES = [
    "config", "state",
    "routers.chat", "routers.hook", "routers.decisions", "routers.strategies",
    "routers.commands",
    "processors.bounded_queue", "processors.drop_if_busy",
    "processors.background_tasks",
    "db.dynamo",
    "langfuse", "langfuse.decorators",
    "litellm",
]
for _mod in _STUB_MODULES:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

# observability.tracing.observe must be a no-op pass-through decorator so that
# @observe(name=...) on command_evaluator.evaluate doesn't wrap it in a MagicMock.
def _noop_observe(**_kwargs):
    def _decorator(fn):
        return fn
    return _decorator

import observability.tracing as _tracing_stub  # noqa: E402
if not isinstance(_tracing_stub, MagicMock):
    # Fresh import — set observe on the real module
    _tracing_stub.observe = _noop_observe
else:
    # Stubbed as MagicMock — override the observe attribute
    _tracing_stub.observe = _noop_observe

# Also stub the full module path in sys.modules for clean imports
_obs_stub = MagicMock()
_obs_stub.observe = _noop_observe
sys.modules["observability.tracing"] = _obs_stub

# Force-evict command_evaluator so it re-imports fresh and picks up the no-op observe
sys.modules.pop("services.command_evaluator", None)
# Also evict db stores so they re-import with the correct db.dynamo stub
for _m in ("db.commands_store", "db.decision_log_store"):
    sys.modules.pop(_m, None)

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
    {"time": "2026-05-31T09:18:00+00:00", "open": 101.0, "high": 103.0, "low": 100.0, "close": 99.5},
]

_CMD = {
    "command_id": "cmd-eval-001",
    "user_id": "user-eval-001",
    "session_id": "sess-eval-001",
    "command_text": "If CE bars low < prev bar low and bear, buy market ratio L",
    "order_type": "market",
    "quantity_type": "ratio_l",
    "parsed_trigger": "CE low < prev_bar.low AND bear",
    "parsed_price_expr": "market",
    "symbol": "NIFTY",
    "right": "CE",
    "strike": 24400,
    "one_shot": True,
}


def _make_hook():
    from processors.base import BarCloseHook, OHLCBar
    bars = [OHLCBar(**b) for b in _BARS]
    return BarCloseHook(
        user_id="user-eval-001",
        session_id="sess-eval-001",
        symbol="NIFTY",
        right="CE",
        bars=bars,
        position=None,
        timestamp="2026-05-31T09:18:00+00:00",
        session_type="paper",
    )


# ---------------------------------------------------------------------------
# Tests: no-op when should_trade=False
# ---------------------------------------------------------------------------

class TestEvaluateNoOp:
    """LLM returns should_trade=False — no order, no log entry."""

    @pytest.mark.asyncio
    async def test_no_order_when_should_trade_false(self):
        llm_result = {"should_trade": False, "reason": "Trigger not met.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("services.backend_client.place_order", new=AsyncMock()) as mock_order, \
             patch("db.decision_log_store.write_decision") as mock_log, \
             patch("db.commands_store.mark_command_executed") as mock_mark, \
             patch("guardrails.validator.validate_action", return_value=(True, "")):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)
        mock_order.assert_not_called()
        mock_log.assert_not_called()
        mock_mark.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_decision_log_when_should_trade_false(self):
        llm_result = {"should_trade": False, "reason": "Condition not met.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("db.decision_log_store.write_decision") as mock_log, \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)
        mock_log.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: order placed when condition met
# ---------------------------------------------------------------------------

class TestEvaluateOrderPlaced:
    """LLM returns should_trade=True and guardrail passes — order placed, log written."""

    @pytest.mark.asyncio
    async def test_order_placed_on_trigger(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Condition met.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={"ok": True})) as mock_order, \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)
        mock_order.assert_called_once()
        call_kwargs = mock_order.call_args
        assert call_kwargs.kwargs["session_id"] == "sess-eval-001"
        assert call_kwargs.kwargs["payload"]["side"] == "BUY"

    @pytest.mark.asyncio
    async def test_decision_logged_after_order_placed(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Low crossed.", "computed_price": None}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        assert len(written_items) == 1
        item = written_items[0]
        assert item["session_id"] == "sess-eval-001"
        assert item["command_id"] == "cmd-eval-001"
        assert item["action_result"] == "order_placed"
        assert item["reason"] == "Low crossed."
        assert item["action"]["side"] == "BUY"

    @pytest.mark.asyncio
    async def test_command_marked_executed_on_one_shot(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Fired.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed") as mock_mark:
            from services import command_evaluator
            cmd = dict(_CMD, one_shot=True)
            await command_evaluator.evaluate(_make_hook(), cmd)
        mock_mark.assert_called_once_with("user-eval-001", "cmd-eval-001")

    @pytest.mark.asyncio
    async def test_command_not_marked_executed_on_one_shot_false(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Fired.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed") as mock_mark:
            from services import command_evaluator
            cmd = dict(_CMD, one_shot=False)
            await command_evaluator.evaluate(_make_hook(), cmd)
        mock_mark.assert_not_called()

    @pytest.mark.asyncio
    async def test_side_normalized_to_uppercase(self):
        llm_result = {"should_trade": True, "side": "buy", "reason": "Fired.", "computed_price": None}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")) as mock_validate, \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        # Guardrail validate_action receives normalised side
        validate_call_action = mock_validate.call_args[0][0]
        assert validate_call_action["side"] == "BUY"
        # Decision log also has normalised side
        assert written_items[0]["action"]["side"] == "BUY"

    @pytest.mark.asyncio
    async def test_computed_price_passed_to_action(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Fired.", "computed_price": 100.05}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        assert written_items[0]["action"]["price_value"] == 100.05


# ---------------------------------------------------------------------------
# Tests: guardrail blocks the action
# ---------------------------------------------------------------------------

class TestEvaluateGuardrailBlocked:
    """LLM returns should_trade=True but guardrail blocks — log rejected_guardrail, no order."""

    @pytest.mark.asyncio
    async def test_no_order_on_guardrail_rejection(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Triggered.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(False, "BUY blocked — long position exists")), \
             patch("services.backend_client.place_order", new=AsyncMock()) as mock_order, \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)
        mock_order.assert_not_called()

    @pytest.mark.asyncio
    async def test_log_written_with_rejected_guardrail(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Triggered.", "computed_price": None}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(False, "BUY blocked")), \
             patch("services.backend_client.place_order", new=AsyncMock()), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        assert len(written_items) == 1
        assert written_items[0]["action_result"] == "rejected_guardrail"

    @pytest.mark.asyncio
    async def test_command_not_marked_executed_on_guardrail_block(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Triggered.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(False, "Blocked")), \
             patch("services.backend_client.place_order", new=AsyncMock()), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed") as mock_mark:
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)
        mock_mark.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: backend raises exception
# ---------------------------------------------------------------------------

class TestEvaluateBackendError:
    """Backend place_order raises — log backend_error, command NOT marked executed."""

    @pytest.mark.asyncio
    async def test_log_written_with_backend_error(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Triggered.", "computed_price": None}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(side_effect=Exception("Backend down"))), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        assert len(written_items) == 1
        assert written_items[0]["action_result"] == "backend_error"

    @pytest.mark.asyncio
    async def test_command_not_marked_executed_on_backend_error(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Triggered.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(side_effect=Exception("Backend down"))), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed") as mock_mark:
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)
        mock_mark.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_crash_on_backend_error(self):
        """evaluate() must not propagate backend exceptions."""
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Triggered.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(side_effect=RuntimeError("crash"))), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)  # must not raise


# ---------------------------------------------------------------------------
# Tests: LLM raises exception
# ---------------------------------------------------------------------------

class TestEvaluateLLMFailure:
    """LLM call raises — evaluate() swallows it cleanly, no order, no log."""

    @pytest.mark.asyncio
    async def test_no_crash_on_llm_exception(self):
        with patch("services.llm_service.evaluate_command", new=AsyncMock(side_effect=Exception("LLM down"))), \
             patch("services.backend_client.place_order", new=AsyncMock()) as mock_order, \
             patch("db.decision_log_store.write_decision") as mock_log:
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)  # must not raise
        mock_order.assert_not_called()
        mock_log.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_log_on_llm_exception(self):
        with patch("services.llm_service.evaluate_command", new=AsyncMock(side_effect=RuntimeError("LLM timeout"))), \
             patch("db.decision_log_store.write_decision") as mock_log, \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)
        mock_log.assert_not_called()


# ---------------------------------------------------------------------------
# Tests: decision log structure
# ---------------------------------------------------------------------------

class TestEvaluateDecisionLogStructure:
    """Verify the shape of the decision log entry written to AIDecisionLog."""

    @pytest.mark.asyncio
    async def test_log_contains_required_fields(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Met.", "computed_price": 100.05}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        item = written_items[0]
        required_keys = {
            "session_id", "ts_command_id", "command_id", "command_text",
            "bar_time", "reason", "action", "action_result", "timestamp",
        }
        assert required_keys.issubset(item.keys())

    @pytest.mark.asyncio
    async def test_ts_command_id_format(self):
        """ts_command_id must be '{ISO_ts}#{command_id}' for DynamoDB sort ordering."""
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Met.", "computed_price": None}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        ts_command_id = written_items[0]["ts_command_id"]
        assert "#" in ts_command_id
        parts = ts_command_id.split("#")
        assert parts[-1] == "cmd-eval-001"

    @pytest.mark.asyncio
    async def test_action_contains_quantity_from_command(self):
        llm_result = {"should_trade": True, "side": "BUY", "reason": "Met.", "computed_price": None}
        written_items = []

        def capture_write(item):
            written_items.append(item)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=AsyncMock(return_value={})), \
             patch("db.decision_log_store.write_decision", side_effect=capture_write), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_hook(), _CMD)

        action = written_items[0]["action"]
        assert action["quantity_type"] == "ratio_l"
        assert action["price_type"] == "market"
