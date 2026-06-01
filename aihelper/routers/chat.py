"""
POST /ai/chat — primary user-facing endpoint.
Classifies intent then dispatches to: command registration, hotword recall,
list active commands, trade analysis (stub — Step 8), or general Q&A.
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from db import commands_store, strategies_store
from services import backend_client, intent_classifier, llm_service, analysis_service
from guardrails.validator import sanitize_command_text

logger = logging.getLogger("aihelper.routers.chat")

router = APIRouter()

VALIDATION_PROMPT = """\
For adding a command, please mention all four of:

1) Order Type — Limit, Market, or Target
2) Quantity or Ratio — ratio values are L, M, or H (% of session wallet)
3) Symbol — CE or PE (required for options sessions)
4) Entry Criteria — defined using bar parameters: low, high, close, open, bear, bull

Examples:
• "If CE bars low crosses low of previous bar, and the bar is a bear bar, \
place a target order at (open+close)/2 with quantity ratio L."
• "If CE bars close crosses 89.5, place a target order at close+0.5 with trade quantity ratio L.\""""

_QTY_LABELS = {
    "ratio_l": "ratio L (3% of wallet)",
    "ratio_m": "ratio M (6% of wallet)",
    "ratio_h": "ratio H (12% of wallet)",
}


class ChatRequest(BaseModel):
    message: str
    session_id: str
    user_id: str
    symbol: str | None = None
    strike_ce: int | None = None   # current CE strike from session state (null for equity)
    strike_pe: int | None = None   # current PE strike from session state (null for equity)


class ChatResponse(BaseModel):
    status: str
    message: str
    command_id: str | None = None
    hotword: str | None = None
    commands: list | None = None
    analysis: dict | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_summary(extracted: dict[str, Any], symbol: str | None, strike: int | None) -> str:
    qty_label = _QTY_LABELS.get(
        extracted.get("quantity_type", ""),
        f"qty {extracted.get('quantity_value')}",
    )
    right = extracted.get("right") or ""
    if strike:
        symbol_str = f"{symbol or ''} {right} ({strike})".strip()
    else:
        symbol_str = (symbol or "").strip()
    order_type = extracted.get("order_type", "market")
    price_expr = extracted.get("price_expr", "market")
    trigger = extracted.get("trigger", "condition met")
    return f"Watching {symbol_str}: {order_type} order at {price_expr}, {qty_label} — fires when {trigger}"


def _strike_for(extracted: dict[str, Any], strike_ce: int | None, strike_pe: int | None) -> int | None:
    right = extracted.get("right")
    if right == "CE":
        return strike_ce
    if right == "PE":
        return strike_pe
    return None


async def _persist_command(
    user_id: str,
    session_id: str,
    symbol: str | None,
    strike_ce: int | None,
    strike_pe: int | None,
    extracted: dict[str, Any],
    original_text: str,
) -> str:
    """Write AICommand to DynamoDB, notify backend, return command_id."""
    strike = _strike_for(extracted, strike_ce, strike_pe)
    command_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    item: dict[str, Any] = {
        "user_id": user_id,
        "command_id": command_id,
        "session_id": session_id,
        "symbol": symbol or "",
        "order_type": extracted["order_type"],
        "quantity_type": extracted["quantity_type"],
        "parsed_trigger": extracted.get("trigger", ""),
        "parsed_price_expr": extracted.get("price_expr", "market"),
        "command_text": original_text,
        "status": "active",
        "one_shot": True,
        "created_at": now,
    }
    # Optional nullable fields — omit rather than store None in DynamoDB
    if extracted.get("right"):
        item["right"] = extracted["right"]
    if strike is not None:
        item["strike"] = strike
    if extracted.get("quantity_value") is not None:
        item["quantity_value"] = extracted["quantity_value"]
    if extracted.get("hotword"):
        item["hotword"] = extracted["hotword"]

    commands_store.put_command(item)
    await backend_client.notify_ai_commands_active(session_id)
    logger.info("Registered command %s session=%s user=%s", command_id, session_id, user_id)
    return command_id


def _validate_extracted(
    extracted: dict[str, Any],
    is_options: bool,
) -> set[str]:
    """Return set of missing field names; empty set means the command is valid."""
    missing = set(extracted.get("missing_fields") or [])
    for field in ("order_type", "quantity_type", "trigger"):
        if not extracted.get(field):
            missing.add(field)
    if not extracted.get("price_expr"):
        missing.add("price_expr")
    if is_options and not extracted.get("right"):
        missing.add("right")
    return missing


# ---------------------------------------------------------------------------
# Intent handlers
# ---------------------------------------------------------------------------

async def _handle_command(req: ChatRequest) -> ChatResponse:
    sanitized = sanitize_command_text(req.message)
    extracted = await llm_service.extract_command_fields(sanitized)

    # Market orders always use "market" price expression
    if extracted.get("order_type") == "market" and not extracted.get("price_expr"):
        extracted["price_expr"] = "market"

    is_options = req.strike_ce is not None or req.strike_pe is not None
    missing = _validate_extracted(extracted, is_options)
    if missing:
        logger.info("Command validation failed — missing: %s", missing)
        return ChatResponse(status="validation_required", message=VALIDATION_PROMPT)

    hotword = extracted.get("hotword")
    if hotword:
        existing = strategies_store.get_strategy(req.user_id, hotword)
        if existing:
            return ChatResponse(
                status="error",
                message=f"Hotword '{hotword}' is already in use. Choose a different name or omit it.",
            )
        now = datetime.now(timezone.utc).isoformat()
        strategies_store.put_strategy({
            "user_id": req.user_id,
            "hotword": hotword,
            "strategy_text": sanitized,
            "description": _build_summary(extracted, req.symbol, _strike_for(extracted, req.strike_ce, req.strike_pe)),
            "created_at": now,
            "last_used_at": now,
            "use_count": 0,
        })

    command_id = await _persist_command(
        req.user_id, req.session_id, req.symbol,
        req.strike_ce, req.strike_pe, extracted, sanitized,
    )
    strike = _strike_for(extracted, req.strike_ce, req.strike_pe)
    summary = _build_summary(extracted, req.symbol, strike)

    return ChatResponse(
        status="watching",
        message=summary,
        command_id=command_id,
        hotword=hotword,
    )


async def _handle_hotword(req: ChatRequest) -> ChatResponse:
    hotword = await llm_service.extract_hotword_name(req.message)
    if not hotword:
        return ChatResponse(
            status="error",
            message="Could not identify the strategy name. Try: 'use <strategy name>'.",
        )

    strategy = strategies_store.get_strategy(req.user_id, hotword)
    if not strategy:
        saved = strategies_store.list_strategies(req.user_id)
        names = [s["hotword"] for s in saved]
        hint = f" Saved hotwords: {', '.join(names)}." if names else " You have no saved hotwords yet."
        return ChatResponse(
            status="error",
            message=f"Hotword '{hotword}' not found.{hint}",
        )

    strategy_text = sanitize_command_text(strategy["strategy_text"])
    extracted = await llm_service.extract_command_fields(strategy_text)
    if extracted.get("order_type") == "market" and not extracted.get("price_expr"):
        extracted["price_expr"] = "market"

    command_id = await _persist_command(
        req.user_id, req.session_id, req.symbol,
        req.strike_ce, req.strike_pe, extracted, strategy_text,
    )
    strategies_store.increment_use_count(req.user_id, hotword, datetime.now(timezone.utc).isoformat())

    strike = _strike_for(extracted, req.strike_ce, req.strike_pe)
    summary = f"Recalled '{hotword}': {_build_summary(extracted, req.symbol, strike)}"

    return ChatResponse(
        status="watching",
        message=summary,
        command_id=command_id,
        hotword=hotword,
    )


async def _handle_analysis(req: ChatRequest) -> ChatResponse:
    from_date, to_date, period_desc = await analysis_service.parse_date_range(req.message)
    logger.info(
        "Analysis: user=%s period=%s (%s → %s)",
        req.user_id, period_desc, from_date, to_date,
    )
    try:
        result = await analysis_service.run_analysis(req.user_id, from_date, to_date, period_desc)
    except Exception:
        logger.exception("Analysis failed")
        return ChatResponse(
            status="error",
            message="Failed to fetch or analyze trade data. Make sure the backend is running.",
        )
    summary = result.get("summary", "No summary available.")
    return ChatResponse(
        status="analysis",
        message=f"Trade analysis for {period_desc}:\n\n{summary}",
        analysis=result,
    )


async def _handle_list_commands(req: ChatRequest) -> ChatResponse:
    active_cmds = commands_store.list_active_commands_for_session(req.session_id)
    saved = strategies_store.list_strategies(req.user_id)

    lines: list[str] = []
    if active_cmds:
        lines.append(f"Active commands ({len(active_cmds)}):")
        for i, cmd in enumerate(active_cmds, 1):
            hw = f" [{cmd.get('hotword')}]" if cmd.get("hotword") else ""
            lines.append(f"  {i}.{hw} {cmd.get('command_text', '')[:80]}")
    else:
        lines.append("No active commands this session.")

    if saved:
        lines.append(f"\nSaved hotwords ({len(saved)}):")
        for s in saved:
            desc = s.get("description") or s.get("strategy_text", "")[:60]
            lines.append(f"  '{s['hotword']}' — {desc}")
    else:
        lines.append("No saved hotwords.")

    return ChatResponse(
        status="list",
        message="\n".join(lines),
        commands=active_cmds,
    )


# ---------------------------------------------------------------------------
# Main endpoint
# ---------------------------------------------------------------------------

@router.post("/ai/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    logger.info(
        "chat(): session=%s user=%s message=%r",
        req.session_id, req.user_id, req.message[:80],
    )

    intent, confidence = await intent_classifier.classify(req.message)
    logger.debug("Intent: %s (confidence=%.2f)", intent, confidence)

    if intent == "command":
        return await _handle_command(req)
    if intent == "hotword":
        return await _handle_hotword(req)
    if intent == "list_commands":
        return await _handle_list_commands(req)
    if intent == "analysis":
        return await _handle_analysis(req)

    # "question" or unrecognised
    try:
        answer = await llm_service.answer_question(req.message)
    except Exception:
        logger.exception("answer_question failed")
        answer = "I'm here to help with trading commands and analysis. Could you rephrase?"
    return ChatResponse(status="answer", message=answer)
