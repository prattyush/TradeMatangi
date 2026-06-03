"""
Tests for trade analysis flow in POST /ai/chat (intent == "analysis").
Covers: date range parsing, analysis service integration, ChatResponse shape,
and error handling when backend is unreachable.
"""
import sys
import os
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_stub_modules = [
    "config", "state",
    "routers.hook", "routers.decisions", "routers.strategies",
    "processors.bounded_queue", "processors.drop_if_busy",
    "processors.background_tasks",
    "db.dynamo",
    "db.commands_store",
    "db.strategies_store",
    "db.decision_log_store",
    "litellm",
]
for _mod in _stub_modules:
    if _mod not in sys.modules:
        sys.modules[_mod] = MagicMock()

# observability.tracing.observe must be a no-op pass-through decorator so that
# @observe(name=...) decorators in chat.py / llm_service.py don't wrap async
# functions in a MagicMock (which breaks 'await _chat_observed(req)').
def _noop_observe(name=None, as_type=None):
    def _decorator(fn):
        return fn
    return _decorator

_obs_stub = MagicMock()
_obs_stub.observe = _noop_observe
_obs_stub.tracing_enabled = False
sys.modules["observability.tracing"] = _obs_stub

# Force-evict modules that use @observe so they re-import fresh with the no-op decorator.
for _m in ("routers.chat", "services.llm_service", "services.intent_classifier"):
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

import state as _state  # noqa: E402
_state.processor = None

from fastapi.testclient import TestClient  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from routers import chat  # noqa: E402

_app = FastAPI()
_app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_app.include_router(chat.router)

client = TestClient(_app, raise_server_exceptions=True)

_USER_ID = "user-ana-001"
_SESSION_ID = "sess-ana-001"

_ANALYSIS_RESULT = {
    "summary": "You have a 40% win rate with losses averaging 3.2%. Entry timing is inconsistent.",
    "patterns": [
        {
            "type": "negative",
            "title": "Late entries",
            "detail": "8 of 10 entries were placed more than 5 ticks above bar open.",
            "frequency": "8 of 10 trades",
        },
        {
            "type": "positive",
            "title": "Good risk management",
            "detail": "Stoploss was used in 9 of 10 trades, limiting downside.",
            "frequency": "9 of 10 trades",
        },
    ],
    "suggestions": [
        "Enter closer to bar open to improve risk/reward.",
        "Focus trading in the first 90 minutes when win rate is higher.",
    ],
    "notable_stats": {
        "win_rate": "40%",
        "avg_profit_pct": "1.5%",
        "avg_loss_pct": "3.2%",
        "best_time_of_day": "09:15–10:30",
        "worst_time_of_day": "13:00–14:30",
    },
}


def _chat_body(message: str) -> dict:
    return {
        "message": message,
        "session_id": _SESSION_ID,
        "user_id": _USER_ID,
        "symbol": "NIFTY",
    }


class TestAnalysisDateRangeParsing:
    """Tests for analysis_service.parse_date_range()."""

    @pytest.mark.asyncio
    async def test_parses_last_7_days(self):
        from services import analysis_service
        llm_result = {
            "from_date": "2026-05-24",
            "to_date": "2026-05-31",
            "period_description": "last 7 days",
        }
        with patch("services.analysis_service._extract_range", new=AsyncMock(return_value=llm_result)):
            from_d, to_d, desc = await analysis_service.parse_date_range("analyze last 7 days")
        assert from_d == "2026-05-24"
        assert to_d == "2026-05-31"
        assert desc == "last 7 days"

    @pytest.mark.asyncio
    async def test_falls_back_on_invalid_date(self):
        from services import analysis_service
        bad_result = {
            "from_date": "not-a-date",
            "to_date": "also-bad",
            "period_description": "???",
        }
        with patch("services.analysis_service._extract_range", new=AsyncMock(return_value=bad_result)):
            from_d, to_d, desc = await analysis_service.parse_date_range("analyze trades")
        # Should fall back to last 7 days
        from datetime import date, timedelta
        today = date.today()
        expected_from = (today - timedelta(days=7)).isoformat()
        assert from_d == expected_from
        assert "7 days" in desc

    @pytest.mark.asyncio
    async def test_falls_back_on_llm_error(self):
        from services import analysis_service
        with patch("services.analysis_service._extract_range", new=AsyncMock(side_effect=Exception("LLM down"))):
            from_d, to_d, desc = await analysis_service.parse_date_range("show me analysis")
        from datetime import date, timedelta
        today = date.today()
        expected_from = (today - timedelta(days=7)).isoformat()
        assert from_d == expected_from
        assert "7 days" in desc


class TestAnalysisServiceRunAnalysis:
    """Tests for analysis_service.run_analysis()."""

    @pytest.mark.asyncio
    async def test_returns_no_trades_message_when_empty(self):
        from services import analysis_service
        with patch("services.analysis_service.backend_client.get_trades", new=AsyncMock(return_value=[])):
            result = await analysis_service.run_analysis(_USER_ID, "2026-05-24", "2026-05-31", "last 7 days")
        assert "No sessions found" in result["summary"]
        assert result["patterns"] == []
        assert len(result["suggestions"]) > 0

    @pytest.mark.asyncio
    async def test_calls_llm_when_trades_present(self):
        from services import analysis_service
        fake_trades = [{"session_id": "s1", "date": "2026-05-29", "trades": []}]
        with patch("services.analysis_service.backend_client.get_trades", new=AsyncMock(return_value=fake_trades)), \
             patch("services.analysis_service._analyze", new=AsyncMock(return_value=_ANALYSIS_RESULT)) as mock_analyze, \
             patch("services.analysis_service.backend_client.get_ohlc_context", new=AsyncMock(side_effect=Exception("no data"))):
            result = await analysis_service.run_analysis(_USER_ID, "2026-05-24", "2026-05-31", "last 7 days")
        assert mock_analyze.called
        assert result["summary"] == _ANALYSIS_RESULT["summary"]

    @pytest.mark.asyncio
    async def test_date_range_passed_to_llm(self):
        from services import analysis_service
        fake_trades = [{"session_id": "s1", "trades": []}]
        with patch("services.analysis_service.backend_client.get_trades", new=AsyncMock(return_value=fake_trades)), \
             patch("services.analysis_service._analyze", new=AsyncMock(return_value=_ANALYSIS_RESULT)) as mock_analyze, \
             patch("services.analysis_service.backend_client.get_ohlc_context", new=AsyncMock(side_effect=Exception("no data"))):
            await analysis_service.run_analysis(_USER_ID, "2026-05-01", "2026-05-31", "May 2026")
        call_args = mock_analyze.call_args
        assert call_args[0][1] == "May 2026"

    @pytest.mark.asyncio
    async def test_symbol_and_session_type_forwarded(self):
        from services import analysis_service
        with patch("services.analysis_service.backend_client.get_trades", new=AsyncMock(return_value=[])) as mock_get, \
             patch("services.analysis_service._analyze", new=AsyncMock(return_value=_ANALYSIS_RESULT)):
            await analysis_service.run_analysis(
                _USER_ID, "2026-05-01", "2026-05-31", "May 2026",
                symbol="NIFTY", session_type="paper",
            )
        mock_get.assert_called_once_with(
            _USER_ID, "2026-05-01", "2026-05-31",
            symbol="NIFTY", session_type="paper",
        )

    @pytest.mark.asyncio
    async def test_analysis_price_source_options_uses_options_ohlc(self):
        """When analysis_price_source='options', options sessions use CE/PE OHLC context."""
        from services import analysis_service
        _trade = {"trade_id": "t1", "side": "BUY", "price": 100.0, "quantity": 75,
                  "timestamp": 1748490000, "right": "CE", "strike": 24400, "expiry": "2026-05-29"}
        options_session = {
            "session_id": "s1", "date": "2026-05-29",
            "instrument_type": "options", "symbol": "NIFTY",
            "trades": [_trade],
        }
        captured_ohlc_calls = []

        async def mock_ohlc(**kwargs):
            captured_ohlc_calls.append(kwargs)
            raise Exception("no data")

        with patch("services.analysis_service.backend_client.get_trades", new=AsyncMock(return_value=[options_session])), \
             patch("services.analysis_service.backend_client.get_user_settings", new=AsyncMock(return_value={"analysis_price_source": "options"})), \
             patch("services.analysis_service.backend_client.get_ohlc_context", new=mock_ohlc), \
             patch("services.analysis_service._analyze", new=AsyncMock(return_value=_ANALYSIS_RESULT)):
            await analysis_service.run_analysis(_USER_ID, "2026-05-29", "2026-05-29", "May 29")

        # For options price source, OHLC call should include right (CE/PE chain OHLC)
        assert len(captured_ohlc_calls) == 1
        assert captured_ohlc_calls[0]["right"] == "CE"

    @pytest.mark.asyncio
    async def test_analysis_price_source_underlying_forces_equity_ohlc(self):
        """When analysis_price_source='underlying', options sessions use NIFTY OHLC context."""
        from services import analysis_service
        _trade = {"trade_id": "t1", "side": "BUY", "price": 100.0, "quantity": 75,
                  "timestamp": 1748490000, "right": "CE", "strike": 24400, "expiry": "2026-05-29"}
        options_session = {
            "session_id": "s1", "date": "2026-05-29",
            "instrument_type": "options", "symbol": "NIFTY",
            "trades": [_trade],
        }
        captured_ohlc_calls = []

        async def mock_ohlc(**kwargs):
            captured_ohlc_calls.append(kwargs)
            raise Exception("no data")

        with patch("services.analysis_service.backend_client.get_trades", new=AsyncMock(return_value=[options_session])), \
             patch("services.analysis_service.backend_client.get_user_settings", new=AsyncMock(return_value={"analysis_price_source": "underlying"})), \
             patch("services.analysis_service.backend_client.get_ohlc_context", new=mock_ohlc), \
             patch("services.analysis_service._analyze", new=AsyncMock(return_value=_ANALYSIS_RESULT)):
            await analysis_service.run_analysis(_USER_ID, "2026-05-29", "2026-05-29", "May 29")

        # For underlying price source, right=None so equity OHLC is fetched (not options chain)
        assert len(captured_ohlc_calls) == 1
        assert captured_ohlc_calls[0].get("right") is None


class TestAnalysisChatEndpoint:
    """End-to-end tests for /ai/chat with analysis intent."""

    def test_analysis_intent_returns_analysis_status(self):
        parse_req = AsyncMock(return_value=("2026-05-24", "2026-05-31", "last 7 days", None, None))
        run_analysis = AsyncMock(return_value=_ANALYSIS_RESULT)
        classify = AsyncMock(return_value=("analysis", 0.97))

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.analysis_service.parse_analysis_request", new=parse_req), \
             patch("services.analysis_service.run_analysis", new=run_analysis):
            resp = client.post("/ai/chat", json=_chat_body("analyze my trades from last 7 days"))

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "analysis"
        assert "last 7 days" in body["message"]
        assert body["analysis"] is not None
        assert body["analysis"]["summary"] == _ANALYSIS_RESULT["summary"]

    def test_analysis_response_contains_all_fields(self):
        parse_req = AsyncMock(return_value=("2026-05-24", "2026-05-31", "last 7 days", None, None))
        run_analysis = AsyncMock(return_value=_ANALYSIS_RESULT)
        classify = AsyncMock(return_value=("analysis", 0.95))

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.analysis_service.parse_analysis_request", new=parse_req), \
             patch("services.analysis_service.run_analysis", new=run_analysis):
            resp = client.post("/ai/chat", json=_chat_body("analyze my trades"))

        analysis = resp.json()["analysis"]
        assert "patterns" in analysis
        assert "suggestions" in analysis
        assert "notable_stats" in analysis
        assert len(analysis["patterns"]) == 2
        assert len(analysis["suggestions"]) == 2
        assert analysis["notable_stats"]["win_rate"] == "40%"

    def test_analysis_error_returns_error_status(self):
        parse_req = AsyncMock(return_value=("2026-05-24", "2026-05-31", "last 7 days", None, None))
        run_analysis = AsyncMock(side_effect=Exception("backend unreachable"))
        classify = AsyncMock(return_value=("analysis", 0.95))

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.analysis_service.parse_analysis_request", new=parse_req), \
             patch("services.analysis_service.run_analysis", new=run_analysis):
            resp = client.post("/ai/chat", json=_chat_body("analyze trades"))

        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "error"
        assert "backend" in body["message"].lower() or "failed" in body["message"].lower()

    def test_no_trades_returns_analysis_with_empty_message(self):
        empty_result = {
            "summary": "No sessions found for the period last 7 days.",
            "patterns": [],
            "suggestions": ["Take some trades first to generate analysis."],
            "notable_stats": {},
        }
        parse_req = AsyncMock(return_value=("2026-05-24", "2026-05-31", "last 7 days", None, None))
        run_analysis = AsyncMock(return_value=empty_result)
        classify = AsyncMock(return_value=("analysis", 0.94))

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.analysis_service.parse_analysis_request", new=parse_req), \
             patch("services.analysis_service.run_analysis", new=run_analysis):
            resp = client.post("/ai/chat", json=_chat_body("show analysis"))

        body = resp.json()
        assert body["status"] == "analysis"
        assert body["analysis"]["patterns"] == []
        assert "No sessions found" in body["analysis"]["summary"]

    def test_analysis_response_message_contains_period(self):
        parse_req = AsyncMock(return_value=("2026-05-01", "2026-05-31", "May 2026", None, None))
        run_analysis = AsyncMock(return_value=_ANALYSIS_RESULT)
        classify = AsyncMock(return_value=("analysis", 0.96))

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.analysis_service.parse_analysis_request", new=parse_req), \
             patch("services.analysis_service.run_analysis", new=run_analysis):
            resp = client.post("/ai/chat", json=_chat_body("analyze May 2026"))

        body = resp.json()
        assert "May 2026" in body["message"]

    def test_symbol_and_session_type_forwarded_to_run_analysis(self):
        parse_req = AsyncMock(return_value=("2026-05-01", "2026-05-31", "May 2026", "NIFTY", "paper"))
        run_analysis = AsyncMock(return_value=_ANALYSIS_RESULT)
        classify = AsyncMock(return_value=("analysis", 0.96))

        with patch("services.intent_classifier.classify", new=classify), \
             patch("services.analysis_service.parse_analysis_request", new=parse_req), \
             patch("services.analysis_service.run_analysis", new=run_analysis) as mock_run:
            client.post("/ai/chat", json=_chat_body("analyze my NIFTY paper trades from May 2026"))

        mock_run.assert_called_once()
        call_kwargs = mock_run.call_args[1]
        assert call_kwargs.get("symbol") == "NIFTY"
        assert call_kwargs.get("session_type") == "paper"


class TestAnalysisBackendClient:
    """Tests for backend_client.get_trades() and get_ohlc_context()."""

    @pytest.mark.asyncio
    async def test_get_trades_calls_correct_endpoint(self):
        from services import backend_client as bc
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value=[{"session_id": "s1"}])
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_resp)

        with patch("services.backend_client.get_client", return_value=mock_client):
            result = await bc.get_trades("u1", "2026-05-24", "2026-05-31")

        mock_client.get.assert_called_once_with(
            "/api/analysis/trades",
            params={"user_id": "u1", "from": "2026-05-24", "to": "2026-05-31"},
        )
        assert result == [{"session_id": "s1"}]

    @pytest.mark.asyncio
    async def test_get_trades_forwards_optional_params(self):
        from services import backend_client as bc
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value=[])
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_resp)

        with patch("services.backend_client.get_client", return_value=mock_client):
            await bc.get_trades("u1", "2026-05-24", "2026-05-31", symbol="NIFTY", session_type="paper")

        call_params = mock_client.get.call_args[1]["params"]
        assert call_params["symbol"] == "NIFTY"
        assert call_params["session_type"] == "paper"

    @pytest.mark.asyncio
    async def test_get_ohlc_context_calls_correct_endpoint(self):
        from services import backend_client as bc
        mock_resp = MagicMock()
        mock_resp.raise_for_status = MagicMock()
        mock_resp.json = MagicMock(return_value={"symbol": "NIFTY", "date": "2026-05-29", "bars": []})
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_resp)

        with patch("services.backend_client.get_client", return_value=mock_client):
            result = await bc.get_ohlc_context("NIFTY", "2026-05-29", entry_ts=1748511300)

        assert mock_client.get.called
        call_url = mock_client.get.call_args[0][0]
        assert call_url == "/api/analysis/ohlc-context"
        assert result["symbol"] == "NIFTY"
