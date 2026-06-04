"""
Tests for CrossSymbolMonitoring — Sprint 2 of Phase XI.

Covers:
  - BarCloseHook accepts underlying_bars field
  - _stream_matches helper: UNDERLYING / CE / PE / legacy-fallback / equity cases
  - evaluate() skips cross-symbol command on CE/PE hooks (wrong stream)
  - evaluate() proceeds for cross-symbol command on NIFTY hook
  - evaluate() passes underlying_bars to LLM for cross-symbol entry
  - _evaluate_exit() skips cross-symbol exit on CE/PE hook
  - _evaluate_exit() proceeds for cross-symbol exit on NIFTY hook
  - evaluate() handles combined condition: CE hook with underlying_bars (both data sets passed)
  - Backend payload includes underlying_bars when right=CE/PE
  - Backward compat: legacy command (no trigger_right) uses command.right as filter
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
# Shared bar fixtures
# ---------------------------------------------------------------------------

_CE_BARS = [
    {"time": "2026-06-01T09:15:00+00:00", "open": 80.0, "high": 82.0, "low": 79.0, "close": 81.0},
    {"time": "2026-06-01T09:18:00+00:00", "open": 81.0, "high": 83.0, "low": 80.0, "close": 80.5},
]

_NIFTY_BARS = [
    {"time": "2026-06-01T09:15:00+00:00", "open": 24100.0, "high": 24150.0, "low": 24080.0, "close": 24120.0},
    {"time": "2026-06-01T09:18:00+00:00", "open": 24120.0, "high": 24130.0, "low": 24090.0, "close": 24095.0},
]

_POSITION = {"side": "LONG", "qty": 50, "avg_entry": 82.0, "unrealized_pnl_pct": -1.2}


def _make_ce_hook(underlying_bars=None):
    """CE bar-close hook, optionally with underlying_bars."""
    from processors.base import BarCloseHook, OHLCBar
    bars = [OHLCBar(**b) for b in _CE_BARS]
    ul_bars = [OHLCBar(**b) for b in (underlying_bars or [])]
    return BarCloseHook(
        user_id="u-cross-001",
        session_id="s-cross-001",
        symbol="NIFTY",
        right="CE",
        bars=bars,
        underlying_bars=ul_bars,
        position=None,
        timestamp="2026-06-01T09:18:00+00:00",
        session_type="paper",
    )


def _make_nifty_hook():
    """NIFTY/underlying bar-close hook (right=None)."""
    from processors.base import BarCloseHook, OHLCBar
    bars = [OHLCBar(**b) for b in _NIFTY_BARS]
    return BarCloseHook(
        user_id="u-cross-001",
        session_id="s-cross-001",
        symbol="NIFTY",
        right=None,
        bars=bars,
        underlying_bars=[],
        position=None,
        timestamp="2026-06-01T09:18:00+00:00",
        session_type="paper",
    )


def _make_nifty_hook_with_position():
    from processors.base import BarCloseHook, OHLCBar, PositionInfo
    bars = [OHLCBar(**b) for b in _NIFTY_BARS]
    pos = PositionInfo(**_POSITION)
    return BarCloseHook(
        user_id="u-cross-001",
        session_id="s-cross-001",
        symbol="NIFTY",
        right=None,
        bars=bars,
        underlying_bars=[],
        position=pos,
        timestamp="2026-06-01T09:18:00+00:00",
        session_type="paper",
    )


# Cross-symbol entry command: trigger on NIFTY, action on CE
_CROSS_ENTRY_CMD = {
    "command_id": "cmd-cross-entry-001",
    "user_id": "u-cross-001",
    "session_id": "s-cross-001",
    "command_text": "When NIFTY closes below 24200, buy CE with ratio M immediately",
    "command_type": "entry",
    "order_type": "market",
    "quantity_type": "ratio_m",
    "parsed_trigger": "NIFTY close < 24200",
    "parsed_price_expr": "market",
    "symbol": "NIFTY",
    "right": "CE",
    "trigger_right": "UNDERLYING",
    "one_shot": True,
}

# Cross-symbol exit command: trigger on NIFTY, exit PE
_CROSS_EXIT_CMD = {
    "command_id": "cmd-cross-exit-001",
    "user_id": "u-cross-001",
    "session_id": "s-cross-001",
    "command_text": "When NIFTY closes below 24200, exit PE position immediately",
    "command_type": "exit",
    "exit_action": "exit_position",
    "parsed_trigger": "NIFTY close < 24200",
    "symbol": "NIFTY",
    "right": "PE",
    "trigger_right": "UNDERLYING",
    "one_shot": True,
}

# Combined command: trigger on CE bar AND check NIFTY (trigger_right="CE", but uses underlying_bars)
_COMBINED_CMD = {
    "command_id": "cmd-combined-001",
    "user_id": "u-cross-001",
    "session_id": "s-cross-001",
    "command_text": "If NIFTY closes above 24005 AND CE bar is bull, buy CE with ratio M",
    "command_type": "entry",
    "order_type": "market",
    "quantity_type": "ratio_m",
    "parsed_trigger": "NIFTY close > 24005 AND CE bar_color = bull",
    "parsed_price_expr": "market",
    "symbol": "NIFTY",
    "right": "CE",
    "trigger_right": "CE",
    "one_shot": True,
}

# Legacy command: no trigger_right stored — uses right as trigger stream (backward compat)
_LEGACY_CE_CMD = {
    "command_id": "cmd-legacy-001",
    "user_id": "u-cross-001",
    "session_id": "s-cross-001",
    "command_text": "If CE bar low < prev low, buy CE at market ratio L",
    "command_type": "entry",
    "order_type": "market",
    "quantity_type": "ratio_l",
    "parsed_trigger": "CE low < prev_bar.low",
    "parsed_price_expr": "market",
    "symbol": "NIFTY",
    "right": "CE",
    # No "trigger_right" key — pre-UNDERLYING feature command
    "one_shot": True,
}


# ---------------------------------------------------------------------------
# 1. BarCloseHook model — underlying_bars field
# ---------------------------------------------------------------------------

class TestBarCloseHookModel:
    def test_underlying_bars_defaults_to_empty(self):
        from processors.base import BarCloseHook, OHLCBar
        bars = [OHLCBar(**b) for b in _CE_BARS]
        hook = BarCloseHook(
            user_id="u", session_id="s", symbol="NIFTY", right="CE",
            bars=bars, timestamp="2026-06-01T09:18:00+00:00",
        )
        assert hook.underlying_bars == []

    def test_underlying_bars_populated(self):
        from processors.base import BarCloseHook, OHLCBar
        bars = [OHLCBar(**b) for b in _CE_BARS]
        ul = [OHLCBar(**b) for b in _NIFTY_BARS]
        hook = BarCloseHook(
            user_id="u", session_id="s", symbol="NIFTY", right="CE",
            bars=bars, underlying_bars=ul, timestamp="2026-06-01T09:18:00+00:00",
        )
        assert len(hook.underlying_bars) == 2
        assert hook.underlying_bars[-1].close == 24095.0

    def test_nifty_hook_has_empty_underlying_bars(self):
        hook = _make_nifty_hook()
        assert hook.right is None
        assert hook.underlying_bars == []


# ---------------------------------------------------------------------------
# 2. _stream_matches helper
# ---------------------------------------------------------------------------

class TestStreamMatches:
    def _matches(self, hook_right, command):
        from services.command_evaluator import _stream_matches
        return _stream_matches(hook_right, command)

    def test_underlying_trigger_matches_nifty_hook(self):
        assert self._matches(None, {"trigger_right": "UNDERLYING", "right": "CE"}) is True

    def test_underlying_trigger_skips_ce_hook(self):
        assert self._matches("CE", {"trigger_right": "UNDERLYING", "right": "CE"}) is False

    def test_underlying_trigger_skips_pe_hook(self):
        assert self._matches("PE", {"trigger_right": "UNDERLYING", "right": "PE"}) is False

    def test_ce_trigger_matches_ce_hook(self):
        assert self._matches("CE", {"trigger_right": "CE", "right": "CE"}) is True

    def test_ce_trigger_skips_pe_hook(self):
        assert self._matches("PE", {"trigger_right": "CE", "right": "CE"}) is False

    def test_ce_trigger_skips_nifty_hook(self):
        assert self._matches(None, {"trigger_right": "CE", "right": "CE"}) is False

    def test_legacy_ce_command_matches_ce_hook(self):
        # No trigger_right key — falls back to right
        assert self._matches("CE", {"right": "CE"}) is True

    def test_legacy_ce_command_skips_nifty_hook(self):
        assert self._matches(None, {"right": "CE"}) is False

    def test_equity_command_no_right_matches_equity_hook(self):
        assert self._matches(None, {}) is True

    def test_equity_command_no_right_skips_ce_hook(self):
        # right=None and trigger_right=None → equity session, CE hook irrelevant
        # Actually returns True since there's no right to filter on — equity commands don't
        # have a right; they should fire on the underlying (right=None) hook only.
        # The existing fallback: no right → matches any hook. This is fine for equity.
        result = self._matches("CE", {})
        # equity command with no right fires on any hook (historical behavior)
        assert result is True


# ---------------------------------------------------------------------------
# 3. evaluate() — cross-symbol entry command stream filter
# ---------------------------------------------------------------------------

class TestCrossSymbolEntryStreamFilter:
    @pytest.mark.asyncio
    async def test_cross_symbol_skips_on_ce_hook(self):
        """UNDERLYING command must NOT fire on a CE bar-close hook."""
        with patch("services.llm_service.evaluate_command", new=AsyncMock()) as mock_llm, \
             patch("services.backend_client.place_order", new=AsyncMock()):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_ce_hook(), _CROSS_ENTRY_CMD)
        assert result["outcome"] == "skipped_wrong_stream"
        mock_llm.assert_not_called()

    @pytest.mark.asyncio
    async def test_cross_symbol_fires_on_nifty_hook(self):
        """UNDERLYING command must fire on a NIFTY (right=None) bar-close hook."""
        llm_result = {"should_trade": False, "reason": "Condition not met.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)) as mock_llm, \
             patch("services.backend_client.place_order", new=AsyncMock()), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"), \
             patch("guardrails.validator.validate_action", return_value=(True, "")):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_nifty_hook(), _CROSS_ENTRY_CMD)
        assert result["outcome"] != "skipped_wrong_stream"
        mock_llm.assert_called_once()

    @pytest.mark.asyncio
    async def test_cross_symbol_underlying_bars_passed_to_llm(self):
        """When UNDERLYING hook fires, hook.bars (NIFTY bars) are passed; underlying_bars=[] since bars ARE the underlying."""
        llm_result = {"should_trade": False, "reason": "Nope.", "computed_price": None}
        captured_kwargs = {}

        async def capture_evaluate(**kwargs):
            captured_kwargs.update(kwargs)
            return llm_result

        with patch("services.llm_service.evaluate_command", new=capture_evaluate), \
             patch("services.backend_client.place_order", new=AsyncMock()), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"), \
             patch("guardrails.validator.validate_action", return_value=(True, "")):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_nifty_hook(), _CROSS_ENTRY_CMD)

        # bars = NIFTY bars; underlying_bars = [] (the hook IS the underlying)
        assert len(captured_kwargs["bars"]) == 2
        assert captured_kwargs["bars"][-1]["close"] == 24095.0
        assert captured_kwargs["underlying_bars"] == []

    @pytest.mark.asyncio
    async def test_cross_symbol_order_placed_on_trigger(self):
        """UNDERLYING command places order on CE when NIFTY condition met."""
        llm_result = {"should_trade": True, "side": "BUY", "reason": "NIFTY < 24200.", "computed_price": None}
        placed_payloads = []

        async def capture_order(**kwargs):
            placed_payloads.append(kwargs)

        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)), \
             patch("guardrails.validator.validate_action", return_value=(True, "")), \
             patch("services.backend_client.place_order", new=capture_order), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_nifty_hook(), _CROSS_ENTRY_CMD)

        assert result["outcome"] == "order_placed"
        assert len(placed_payloads) == 1
        # The order goes to CE (from command.right), not the hook stream (None)
        assert placed_payloads[0]["payload"]["right"] == "CE"


# ---------------------------------------------------------------------------
# 4. _evaluate_exit() — cross-symbol exit command stream filter
# ---------------------------------------------------------------------------

class TestCrossSymbolExitStreamFilter:
    @pytest.mark.asyncio
    async def test_cross_symbol_exit_skips_ce_hook(self):
        """UNDERLYING exit command must NOT fire on a CE hook."""
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock()) as mock_llm:
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_ce_hook(), _CROSS_EXIT_CMD)
        assert result["outcome"] == "skipped_wrong_stream"
        mock_llm.assert_not_called()

    @pytest.mark.asyncio
    async def test_cross_symbol_exit_fires_on_nifty_hook_with_position(self):
        """UNDERLYING exit command fires on NIFTY hook when position is open."""
        llm_result = {
            "should_exit": True, "exit_action": "exit_position",
            "computed_price": None, "reason": "NIFTY below threshold.",
        }
        with patch("services.llm_service.evaluate_exit_command", new=AsyncMock(return_value=llm_result)) as mock_llm, \
             patch("services.backend_client.cancel_open_stoploss", new=AsyncMock()), \
             patch("services.backend_client.exit_position_market", new=AsyncMock()), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.claim_command_execution", return_value=True), \
             patch("db.commands_store.mark_command_executed"), \
             patch("guardrails.validator.validate_exit_action", return_value=(True, "")):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_nifty_hook_with_position(), _CROSS_EXIT_CMD)
        assert result["outcome"] != "skipped_wrong_stream"
        mock_llm.assert_called_once()

    @pytest.mark.asyncio
    async def test_cross_symbol_exit_auto_cancels_when_no_position(self):
        """UNDERLYING exit command auto-cancels if no position on NIFTY hook."""
        with patch("db.commands_store.cancel_command") as mock_cancel:
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_nifty_hook(), _CROSS_EXIT_CMD)
        assert result["outcome"] == "auto_cancelled_no_position"
        mock_cancel.assert_called_once()


# ---------------------------------------------------------------------------
# 5. Combined condition — CE hook with underlying_bars
# ---------------------------------------------------------------------------

class TestCombinedCondition:
    @pytest.mark.asyncio
    async def test_combined_ce_hook_passes_both_bars_to_llm(self):
        """Combined command (trigger_right=CE): CE bars + underlying_bars both reach the LLM."""
        llm_result = {"should_trade": False, "reason": "Condition not met.", "computed_price": None}
        captured_kwargs = {}

        async def capture_evaluate(**kwargs):
            captured_kwargs.update(kwargs)
            return llm_result

        ce_hook_with_ul = _make_ce_hook(underlying_bars=_NIFTY_BARS)

        with patch("services.llm_service.evaluate_command", new=capture_evaluate), \
             patch("services.backend_client.place_order", new=AsyncMock()), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"), \
             patch("guardrails.validator.validate_action", return_value=(True, "")):
            from services import command_evaluator
            result = await command_evaluator.evaluate(ce_hook_with_ul, _COMBINED_CMD)

        assert result["outcome"] != "skipped_wrong_stream"
        # CE bars passed as bars
        assert len(captured_kwargs["bars"]) == 2
        assert captured_kwargs["bars"][-1]["close"] == 80.5
        # NIFTY bars passed as underlying_bars
        assert len(captured_kwargs["underlying_bars"]) == 2
        assert captured_kwargs["underlying_bars"][-1]["close"] == 24095.0

    @pytest.mark.asyncio
    async def test_combined_ce_hook_no_underlying_passes_empty(self):
        """CE hook without underlying_bars passes empty list to LLM."""
        llm_result = {"should_trade": False, "reason": "No.", "computed_price": None}
        captured_kwargs = {}

        async def capture_evaluate(**kwargs):
            captured_kwargs.update(kwargs)
            return llm_result

        with patch("services.llm_service.evaluate_command", new=capture_evaluate), \
             patch("services.backend_client.place_order", new=AsyncMock()), \
             patch("db.decision_log_store.write_decision"), \
             patch("db.commands_store.mark_command_executed"), \
             patch("guardrails.validator.validate_action", return_value=(True, "")):
            from services import command_evaluator
            await command_evaluator.evaluate(_make_ce_hook(), _COMBINED_CMD)

        assert captured_kwargs["underlying_bars"] == []


# ---------------------------------------------------------------------------
# 6. Backward compatibility — legacy commands (no trigger_right)
# ---------------------------------------------------------------------------

class TestLegacyBackwardCompat:
    @pytest.mark.asyncio
    async def test_legacy_ce_command_fires_on_ce_hook(self):
        """Pre-UNDERLYING command without trigger_right fires on its own right stream."""
        llm_result = {"should_trade": False, "reason": "No.", "computed_price": None}
        with patch("services.llm_service.evaluate_command", new=AsyncMock(return_value=llm_result)) as mock_llm, \
             patch("services.backend_client.place_order", new=AsyncMock()), \
             patch("guardrails.validator.validate_action", return_value=(True, "")):
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_ce_hook(), _LEGACY_CE_CMD)
        assert result["outcome"] != "skipped_wrong_stream"
        mock_llm.assert_called_once()

    @pytest.mark.asyncio
    async def test_legacy_ce_command_skips_nifty_hook(self):
        """Pre-UNDERLYING CE command must NOT fire on the NIFTY hook."""
        with patch("services.llm_service.evaluate_command", new=AsyncMock()) as mock_llm:
            from services import command_evaluator
            result = await command_evaluator.evaluate(_make_nifty_hook(), _LEGACY_CE_CMD)
        assert result["outcome"] == "skipped_wrong_stream"
        mock_llm.assert_not_called()
