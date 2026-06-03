"""
POST /ai/chat — primary user-facing endpoint.
Classifies intent then dispatches to: command registration, hotword recall,
list active commands, trade analysis (stub — Step 8), or general Q&A.
"""
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from db import commands_store, strategies_store
from services import backend_client, intent_classifier, llm_service, analysis_service
from guardrails.validator import sanitize_command_text
from observability.tracing import observe

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

EXIT_VALIDATION_PROMPT = """\
For adding an exit command, please mention:

1) Symbol — CE or PE (required for options sessions)
2) Action — one of:
   • "exit position" — exit immediately at market
   • "update stoploss to <price>" — update/create SL order
   • "start take profit at <price>" — start TakeProfit strategy
3) Exit Criteria — defined using bar parameters: low, high, close, open, bear, bull

Examples:
• "Exit CE position when the first bear body bar appears."
• "Start Take Profit strategy in CE at the previous bar's high when CE closes above 90."
• "Update stoploss to the low of the current bar minus 1, when the bar is bull in CE.\""""

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

def _build_summary(
    extracted: dict[str, Any],
    symbol: str | None,
    strike: int | None,
    funds_ratios: dict[str, float] | None = None,
) -> str:
    ratios = funds_ratios or {"ratio_l": 0.03, "ratio_m": 0.06, "ratio_h": 0.12}
    qty_type = extracted.get("quantity_type", "")
    if qty_type in ratios:
        label_name = qty_type.replace("ratio_", "").upper()
        qty_label = f"ratio {label_name} ({ratios[qty_type] * 100:.0f}% of wallet)"
    else:
        qty_label = f"qty {extracted.get('quantity_value')}"
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
    if extracted.get("trigger_right"):
        item["trigger_right"] = extracted["trigger_right"]
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

    funds_ratios = await backend_client.get_user_funds_ratios(req.user_id)

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
            "description": _build_summary(extracted, req.symbol, _strike_for(extracted, req.strike_ce, req.strike_pe), funds_ratios),
            "created_at": now,
            "last_used_at": now,
            "use_count": 0,
        })

    command_id = await _persist_command(
        req.user_id, req.session_id, req.symbol,
        req.strike_ce, req.strike_pe, extracted, sanitized,
    )
    strike = _strike_for(extracted, req.strike_ce, req.strike_pe)
    summary = _build_summary(extracted, req.symbol, strike, funds_ratios)

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

    funds_ratios = await backend_client.get_user_funds_ratios(req.user_id)
    strike = _strike_for(extracted, req.strike_ce, req.strike_pe)
    summary = f"Recalled '{hotword}': {_build_summary(extracted, req.symbol, strike, funds_ratios)}"

    return ChatResponse(
        status="watching",
        message=summary,
        command_id=command_id,
        hotword=hotword,
    )


async def _handle_analysis(req: ChatRequest) -> ChatResponse:
    from_date, to_date, period_desc, symbol, session_type = (
        await analysis_service.parse_analysis_request(req.message)
    )
    logger.info(
        "Analysis: user=%s period=%s (%s → %s) symbol=%s session_type=%s",
        req.user_id, period_desc, from_date, to_date, symbol, session_type,
    )
    try:
        result = await analysis_service.run_analysis(
            req.user_id, from_date, to_date, period_desc,
            symbol=symbol, session_type=session_type,
        )
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


async def _handle_cancel(req: ChatRequest) -> ChatResponse:
    active_cmds = commands_store.get_active_commands_for_session(req.session_id)
    if not active_cmds:
        return ChatResponse(status="answer", message="No active commands to cancel.")

    params = await llm_service.extract_cancel_params(req.message)
    right = (params.get("right") or "").upper() or None
    index = params.get("index")  # 1-based, or None

    to_cancel = active_cmds
    if right:
        to_cancel = [c for c in active_cmds if (c.get("right") or "").upper() == right]
    if index is not None:
        if 1 <= index <= len(to_cancel):
            to_cancel = [to_cancel[index - 1]]
        else:
            total = len(to_cancel)
            label = f"{right} " if right else ""
            return ChatResponse(
                status="error",
                message=f"Command {index} not found — you have {total} active {label}command{'s' if total != 1 else ''}.",
            )

    cancelled = 0
    for cmd in to_cancel:
        try:
            commands_store.cancel_command(cmd["user_id"], cmd["command_id"], reason="user_cancelled_via_chat")
            cancelled += 1
        except Exception:
            logger.exception("Failed to cancel command %s", cmd.get("command_id"))

    label = f"{right} " if right else ""
    return ChatResponse(
        status="cancelled",
        message=f"Cancelled {cancelled} {label}command{'s' if cancelled != 1 else ''}.",
    )


def _validate_exit_extracted(
    extracted: dict[str, Any],
    is_options: bool,
) -> set[str]:
    """Return set of missing field names for exit commands; empty = valid."""
    missing = set(extracted.get("missing_fields") or [])
    for field in ("exit_action", "trigger"):
        if not extracted.get(field):
            missing.add(field)
    # price expression required for SL update and TP start
    if extracted.get("exit_action") in ("update_stoploss", "start_takeprofit"):
        if not extracted.get("exit_price_expr"):
            missing.add("exit_price_expr")
    if is_options and not extracted.get("right"):
        missing.add("right")
    return missing


def _build_exit_summary(
    extracted: dict[str, Any],
    symbol: str | None,
    strike: int | None,
) -> str:
    right = extracted.get("right") or ""
    if strike:
        symbol_str = f"{symbol or ''} {right} ({strike})".strip()
    else:
        symbol_str = (f"{symbol or ''} {right}".strip()) if right else (symbol or "")
    action = extracted.get("exit_action", "exit_position")
    price_expr = extracted.get("exit_price_expr")
    trigger = extracted.get("trigger", "condition met")
    if price_expr:
        return f"Watching {symbol_str}: {action} at {price_expr} — fires when {trigger}"
    return f"Watching {symbol_str}: {action} — fires when {trigger}"


async def _persist_exit_command(
    user_id: str,
    session_id: str,
    symbol: str | None,
    strike_ce: int | None,
    strike_pe: int | None,
    extracted: dict[str, Any],
    original_text: str,
) -> str:
    """Write exit AICommand to DynamoDB, notify backend, return command_id."""
    strike = _strike_for(extracted, strike_ce, strike_pe)
    command_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    item: dict[str, Any] = {
        "user_id": user_id,
        "command_id": command_id,
        "session_id": session_id,
        "symbol": symbol or "",
        "command_type": "exit",
        "exit_action": extracted["exit_action"],
        "parsed_trigger": extracted.get("trigger", ""),
        "command_text": original_text,
        "status": "active",
        "one_shot": True,
        "created_at": now,
    }
    if extracted.get("right"):
        item["right"] = extracted["right"]
    if extracted.get("trigger_right"):
        item["trigger_right"] = extracted["trigger_right"]
    if strike is not None:
        item["strike"] = strike
    if extracted.get("exit_price_expr"):
        item["exit_price_expr"] = extracted["exit_price_expr"]
    if extracted.get("hotword"):
        item["hotword"] = extracted["hotword"]

    commands_store.put_command(item)
    await backend_client.notify_ai_commands_active(session_id)
    logger.info("Registered exit command %s session=%s user=%s", command_id, session_id, user_id)
    return command_id


async def _handle_exit_command(req: ChatRequest) -> ChatResponse:
    sanitized = sanitize_command_text(req.message)
    extracted = await llm_service.extract_exit_command_fields(sanitized)

    is_options = req.strike_ce is not None or req.strike_pe is not None
    missing = _validate_exit_extracted(extracted, is_options)
    if missing:
        logger.info("Exit command validation failed — missing: %s", missing)
        return ChatResponse(status="validation_required", message=EXIT_VALIDATION_PROMPT)

    # Advisory position check — warn user if no open position, but still save the command
    position_warning: str | None = None
    try:
        right = extracted.get("right")
        pos = await backend_client.get_position(req.session_id, right)
        if pos.get("side") == "FLAT":
            sym_label = right or "equity"
            position_warning = (
                f"Note: No open {sym_label} position found. "
                "Command saved but will auto-cancel at bar close if still no position."
            )
    except Exception:
        pass  # non-fatal — position check is advisory only

    command_id = await _persist_exit_command(
        req.user_id, req.session_id, req.symbol,
        req.strike_ce, req.strike_pe, extracted, sanitized,
    )
    strike = _strike_for(extracted, req.strike_ce, req.strike_pe)
    summary = _build_exit_summary(extracted, req.symbol, strike)
    if position_warning:
        summary = f"{summary}\n\n{position_warning}"

    return ChatResponse(status="watching", message=summary, command_id=command_id)


_PH_RE = re.compile(r'\$\{([^}]+)\}')


def _fill_template(template_text: str, values_csv: str | None) -> tuple[str, list[str]]:
    """Fill ${placeholders} positionally from comma-separated values.
    Returns (filled_text, list_of_remaining_placeholder_names).
    """
    placeholders = _PH_RE.findall(template_text)
    values = [v.strip() for v in values_csv.split(',')] if values_csv else []
    filled = template_text
    for i, ph in enumerate(placeholders):
        if i < len(values) and values[i]:
            filled = filled.replace(f'${{{ph}}}', values[i], 1)
    return filled, _PH_RE.findall(filled)


async def _handle_save_template(req: ChatRequest) -> ChatResponse:
    extracted = await llm_service.extract_template_fields(req.message)
    missing = set(extracted.get("missing_fields") or [])

    if not extracted.get("hotword"):
        missing.add("hotword")
    template_text = extracted.get("template_text", "")
    if not template_text:
        missing.add("template_text")
    elif "${" not in template_text:
        return ChatResponse(
            status="validation_required",
            message=(
                "Template must contain at least one placeholder like ${symbol}, ${ratio}, ${price}.\n\n"
                "Example: 'entry template: Buy in ${symbol} with ratio ${ratio} when bar closes "
                "above ${price}. Use hotword bbwp'"
            ),
        )

    if missing:
        return ChatResponse(
            status="validation_required",
            message=(
                "To save a template, please include:\n"
                "1) A hotword to recall it (e.g. 'use hotword bbwp')\n"
                "2) The template text with ${placeholder} variables\n\n"
                "Example:\n"
                "'entry template: Buy ${symbol} with ratio ${ratio} when bar closes above ${price}. "
                "Use hotword bbwp'"
            ),
        )

    hotword = extracted["hotword"]
    template_type = extracted.get("template_type") or "entry"
    existing = strategies_store.get_strategy(req.user_id, hotword)
    if existing:
        kind = "template" if existing.get("is_template") else "hotword"
        return ChatResponse(
            status="error",
            message=f"'{hotword}' is already in use as a {kind}. Choose a different name.",
        )

    ph_names = _PH_RE.findall(template_text)
    now = datetime.now(timezone.utc).isoformat()
    strategies_store.put_strategy({
        "user_id": req.user_id,
        "hotword": hotword,
        "strategy_text": template_text,
        "template_text": template_text,
        "template_type": template_type,
        "is_template": True,
        "description": f"{template_type.title()} template — placeholders: {', '.join(ph_names)}",
        "created_at": now,
        "last_used_at": now,
        "use_count": 0,
    })

    ph_display = ", ".join(f"${{{p}}}" for p in ph_names)
    return ChatResponse(
        status="saved",
        message=(
            f"Template '{hotword}' saved ({template_type}).\n"
            f"Placeholders (in order): {ph_display}\n\n"
            f"To use it: 'start template {hotword} with values - value1,value2,...'"
        ),
        hotword=hotword,
    )


async def _handle_use_template(req: ChatRequest) -> ChatResponse:
    extracted = await llm_service.extract_template_use(req.message)
    hotword = extracted.get("hotword")
    values_csv = extracted.get("values_csv")

    if not hotword:
        return ChatResponse(
            status="error",
            message="Could not identify the template name. Try: 'start template <name> with values - value1,value2'",
        )

    template = strategies_store.get_template_by_hotword(req.user_id, hotword)
    if not template:
        all_templates = strategies_store.list_templates(req.user_id)
        names = [t["hotword"] for t in all_templates]
        hint = f" Saved templates: {', '.join(names)}." if names else " You have no saved templates yet."
        return ChatResponse(
            status="error",
            message=f"Template '{hotword}' not found.{hint}",
        )

    template_text = template["template_text"]
    filled_text, remaining = _fill_template(template_text, values_csv)

    if remaining:
        ph_names = _PH_RE.findall(template_text)
        return ChatResponse(
            status="validation_required",
            message=(
                f"Template '{hotword}' needs {len(ph_names)} value(s): {', '.join(ph_names)}.\n"
                f"Still unfilled: {', '.join(remaining)}.\n\n"
                f"Try: 'start template {hotword} with values - value1,value2,...'"
            ),
        )

    strategies_store.increment_use_count(req.user_id, hotword, datetime.now(timezone.utc).isoformat())

    filled_req = ChatRequest(
        message=filled_text,
        session_id=req.session_id,
        user_id=req.user_id,
        symbol=req.symbol,
        strike_ce=req.strike_ce,
        strike_pe=req.strike_pe,
    )

    template_type = template.get("template_type", "entry")
    if template_type == "exit":
        result = await _handle_exit_command(filled_req)
    else:
        result = await _handle_command(filled_req)

    expanded_prefix = f"Expanded '{hotword}':\n{filled_text}\n\n"
    return ChatResponse(
        status=result.status,
        message=expanded_prefix + result.message,
        command_id=result.command_id,
        hotword=hotword,
    )


async def _handle_list_templates(req: ChatRequest) -> ChatResponse:
    templates = strategies_store.list_templates(req.user_id)
    if not templates:
        return ChatResponse(
            status="list",
            message=(
                "No saved templates yet.\n"
                "Save one with: 'entry template: Buy ${symbol} with ratio ${ratio} "
                "when bar closes above ${price}. Use hotword bbwp'"
            ),
        )

    lines = [f"Saved templates ({len(templates)}):"]
    for t in templates:
        ph_names = _PH_RE.findall(t.get("template_text", ""))
        ph_display = ", ".join(ph_names) if ph_names else "none"
        t_type = t.get("template_type", "entry")
        lines.append(f"  '{t['hotword']}' [{t_type}] — placeholders: {ph_display}")

    return ChatResponse(status="list", message="\n".join(lines))


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

@observe(name="chat")
async def _chat_observed(req: ChatRequest) -> ChatResponse:
    """Business logic — wrapped with LangFuse tracing. Called by the route handler."""
    intent, confidence = await intent_classifier.classify(req.message)
    logger.debug("Intent: %s (confidence=%.2f)", intent, confidence)

    if intent == "entry_command":
        return await _handle_command(req)
    if intent == "exit_command":
        return await _handle_exit_command(req)
    if intent == "hotword":
        return await _handle_hotword(req)
    if intent == "list_commands":
        return await _handle_list_commands(req)
    if intent == "cancel_commands":
        return await _handle_cancel(req)
    if intent == "save_template":
        return await _handle_save_template(req)
    if intent == "use_template":
        return await _handle_use_template(req)
    if intent == "list_templates":
        return await _handle_list_templates(req)
    if intent == "analysis":
        return await _handle_analysis(req)

    # "question" or unrecognised
    try:
        answer = await llm_service.answer_question(req.message)
    except Exception:
        logger.exception("answer_question failed")
        answer = "I'm here to help with trading commands and analysis. Could you rephrase?"
    return ChatResponse(status="answer", message=answer)


@router.post("/ai/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    logger.info(
        "chat(): session=%s user=%s message=%r",
        req.session_id, req.user_id, req.message[:80],
    )
    return await _chat_observed(req)
