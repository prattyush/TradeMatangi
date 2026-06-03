"""
Tests for ExitEntryTemplates feature in routers/chat.py and db/strategies_store.py.

Covers:
  - save_template intent: valid save, missing hotword, missing placeholder, duplicate hotword
  - use_template intent: fills ok → dispatches command, missing placeholder → validation_required,
    not found → error, wrong count of values → validation_required
  - list_templates intent: empty, with entries
  - _fill_template utility: correct fill, partial fill, no values
  - strategies_store template helpers: list_templates, get_template_by_hotword
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

VALID_SESSION = "sess-001"
VALID_USER = "user-001"

_BASE_PAYLOAD = {
    "session_id": VALID_SESSION,
    "user_id": VALID_USER,
    "symbol": "NIFTY",
    "strike_ce": 24000,
    "strike_pe": 24000,
}


# ---------------------------------------------------------------------------
# _fill_template utility unit tests
# ---------------------------------------------------------------------------

def test_fill_template_all_values():
    filled, remaining = chat_module._fill_template(
        "Buy ${symbol} with ratio ${ratio} when close above ${price}",
        "CE,M,30",
    )
    assert filled == "Buy CE with ratio M when close above 30"
    assert remaining == []


def test_fill_template_partial_values():
    filled, remaining = chat_module._fill_template(
        "Buy ${symbol} with ratio ${ratio} when close above ${price}",
        "CE,M",
    )
    assert "CE" in filled
    assert "M" in filled
    assert "${price}" in filled
    assert remaining == ["price"]


def test_fill_template_no_values():
    filled, remaining = chat_module._fill_template(
        "Buy ${symbol} with ratio ${ratio}",
        None,
    )
    assert "${symbol}" in filled
    assert "${ratio}" in filled
    assert set(remaining) == {"symbol", "ratio"}


def test_fill_template_extra_values_ok():
    """Extra values beyond placeholders are silently ignored."""
    filled, remaining = chat_module._fill_template("Buy ${symbol}", "CE,M,30")
    assert filled == "Buy CE"
    assert remaining == []


# ---------------------------------------------------------------------------
# strategies_store template helpers (unit)
# ---------------------------------------------------------------------------

def test_list_templates_filters_correctly():
    from db import strategies_store
    items = [
        {"user_id": "u1", "hotword": "hw1", "strategy_text": "plain"},
        {"user_id": "u1", "hotword": "tmpl1", "strategy_text": "${x}", "is_template": True},
        {"user_id": "u1", "hotword": "tmpl2", "strategy_text": "${y}", "is_template": True},
    ]
    with patch.object(strategies_store, "list_strategies", return_value=items):
        result = strategies_store.list_templates("u1")
    assert len(result) == 2
    assert all(r["is_template"] for r in result)


def test_get_template_by_hotword_returns_none_for_plain():
    from db import strategies_store
    plain = {"user_id": "u1", "hotword": "plain", "strategy_text": "text"}
    with patch.object(strategies_store, "get_strategy", return_value=plain):
        result = strategies_store.get_template_by_hotword("u1", "plain")
    assert result is None


def test_get_template_by_hotword_returns_template():
    from db import strategies_store
    tmpl = {"user_id": "u1", "hotword": "bbwp", "is_template": True, "template_text": "Buy ${x}"}
    with patch.object(strategies_store, "get_strategy", return_value=tmpl):
        result = strategies_store.get_template_by_hotword("u1", "bbwp")
    assert result is not None
    assert result["hotword"] == "bbwp"


# ---------------------------------------------------------------------------
# save_template endpoint tests
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_classify_save_template():
    with patch("services.intent_classifier.classify", AsyncMock(return_value=("save_template", 0.95))):
        yield


@pytest.fixture
def mock_classify_use_template():
    with patch("services.intent_classifier.classify", AsyncMock(return_value=("use_template", 0.95))):
        yield


@pytest.fixture
def mock_classify_list_templates():
    with patch("services.intent_classifier.classify", AsyncMock(return_value=("list_templates", 0.95))):
        yield


def test_save_template_valid(mock_classify_save_template):
    with (
        patch("services.llm_service.extract_template_fields", AsyncMock(return_value={
            "hotword": "bbwp",
            "template_type": "entry",
            "template_text": "Buy ${symbol} with ratio ${ratio} when close above ${price}",
            "missing_fields": [],
        })),
        patch("db.strategies_store.get_strategy", return_value=None),
        patch("db.strategies_store.put_strategy") as mock_put,
    ):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "entry template..."})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "saved"
    assert "bbwp" in data["message"]
    assert "${symbol}" in data["message"]
    mock_put.assert_called_once()
    saved_item = mock_put.call_args[0][0]
    assert saved_item["is_template"] is True
    assert saved_item["hotword"] == "bbwp"
    assert saved_item["template_type"] == "entry"


def test_save_template_missing_hotword(mock_classify_save_template):
    with (
        patch("services.llm_service.extract_template_fields", AsyncMock(return_value={
            "hotword": None,
            "template_type": "entry",
            "template_text": "Buy ${symbol} with ratio ${ratio}",
            "missing_fields": ["hotword"],
        })),
    ):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "entry template without hotword"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "validation_required"
    assert "hotword" in data["message"].lower()


def test_save_template_no_placeholders(mock_classify_save_template):
    with (
        patch("services.llm_service.extract_template_fields", AsyncMock(return_value={
            "hotword": "bbwp",
            "template_type": "entry",
            "template_text": "Buy CE at market",
            "missing_fields": [],
        })),
    ):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "save as bbwp: Buy CE at market"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "validation_required"
    assert "placeholder" in data["message"].lower()


def test_save_template_duplicate_hotword(mock_classify_save_template):
    existing = {"user_id": VALID_USER, "hotword": "bbwp", "strategy_text": "existing"}
    with (
        patch("services.llm_service.extract_template_fields", AsyncMock(return_value={
            "hotword": "bbwp",
            "template_type": "entry",
            "template_text": "Buy ${symbol} at ${price}",
            "missing_fields": [],
        })),
        patch("db.strategies_store.get_strategy", return_value=existing),
    ):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "..."})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "error"
    assert "bbwp" in data["message"]


# ---------------------------------------------------------------------------
# use_template endpoint tests
# ---------------------------------------------------------------------------

def test_use_template_fills_and_dispatches(mock_classify_use_template):
    template_item = {
        "user_id": VALID_USER,
        "hotword": "bbwp",
        "is_template": True,
        "template_type": "entry",
        "template_text": "Buy ${symbol} with ratio ${ratio} at market when bar is bull",
    }
    with (
        patch("services.llm_service.extract_template_use", AsyncMock(return_value={
            "hotword": "bbwp",
            "values_csv": "CE,M",
        })),
        patch("db.strategies_store.get_template_by_hotword", return_value=template_item),
        patch("db.strategies_store.increment_use_count"),
        patch("services.llm_service.extract_command_fields", AsyncMock(return_value={
            "order_type": "market",
            "quantity_type": "ratio_m",
            "quantity_value": None,
            "right": "CE",
            "trigger_right": "CE",
            "trigger": "bar is bull",
            "price_expr": "market",
            "hotword": None,
            "missing_fields": [],
        })),
        patch("services.backend_client.get_user_funds_ratios", AsyncMock(return_value={
            "ratio_l": 0.03, "ratio_m": 0.06, "ratio_h": 0.12,
        })),
        patch("db.commands_store.put_command"),
        patch("services.backend_client.notify_ai_commands_active", AsyncMock()),
        patch("guardrails.validator.sanitize_command_text", side_effect=lambda x: x),
    ):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "start template bbwp with values - CE,M"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "watching"
    assert "bbwp" in data["message"]
    assert "CE" in data["message"] or "Buy" in data["message"]
    assert data["hotword"] == "bbwp"


def test_use_template_missing_values(mock_classify_use_template):
    template_item = {
        "user_id": VALID_USER,
        "hotword": "bbwp",
        "is_template": True,
        "template_type": "entry",
        "template_text": "Buy ${symbol} with ratio ${ratio} at ${price}",
    }
    with (
        patch("services.llm_service.extract_template_use", AsyncMock(return_value={
            "hotword": "bbwp",
            "values_csv": "CE",
        })),
        patch("db.strategies_store.get_template_by_hotword", return_value=template_item),
        patch("db.strategies_store.increment_use_count"),
    ):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "start template bbwp with values - CE"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "validation_required"
    assert "unfilled" in data["message"].lower() or "still" in data["message"].lower()


def test_use_template_not_found(mock_classify_use_template):
    with (
        patch("services.llm_service.extract_template_use", AsyncMock(return_value={
            "hotword": "unknown",
            "values_csv": "CE,M,30",
        })),
        patch("db.strategies_store.get_template_by_hotword", return_value=None),
        patch("db.strategies_store.list_templates", return_value=[]),
    ):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "start template unknown with values - CE,M,30"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "error"
    assert "not found" in data["message"].lower()


# ---------------------------------------------------------------------------
# list_templates endpoint tests
# ---------------------------------------------------------------------------

def test_list_templates_empty(mock_classify_list_templates):
    with patch("db.strategies_store.list_templates", return_value=[]):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "list my templates"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "list"
    assert "no saved templates" in data["message"].lower()


def test_list_templates_with_entries(mock_classify_list_templates):
    templates = [
        {
            "user_id": VALID_USER,
            "hotword": "bbwp",
            "is_template": True,
            "template_type": "entry",
            "template_text": "Buy ${symbol} with ratio ${ratio}",
        },
        {
            "user_id": VALID_USER,
            "hotword": "bearbreak",
            "is_template": True,
            "template_type": "exit",
            "template_text": "Exit ${symbol} when bar is bear",
        },
    ]
    with patch("db.strategies_store.list_templates", return_value=templates):
        resp = client.post("/ai/chat", json={**_BASE_PAYLOAD, "message": "show templates"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "list"
    assert "bbwp" in data["message"]
    assert "bearbreak" in data["message"]
    assert "symbol" in data["message"]
