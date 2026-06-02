"""
LiteLLM wrapper — provider-agnostic async completion.
Model names are read from config (per role).
config.py sets the API key env vars before this module is imported.
"""
import json
import logging
from typing import Any

import litellm

from config import (
    MODEL_INTENT_CLASSIFIER, MODEL_COMMAND_EVALUATOR,
    MODEL_ANALYSIS, MODEL_FALLBACK,
)
from langfuse import get_client as _get_langfuse_client

from observability.tracing import observe, tracing_enabled

logger = logging.getLogger("aihelper.services.llm_service")

# Suppress verbose litellm success/failure logging
litellm.suppress_debug_info = True


@observe(name="llm_complete", as_type="generation")
async def _complete(
    model: str,
    messages: list[dict[str, str]],
    json_mode: bool = True,
    temperature: float = 0.0,
) -> dict[str, Any]:
    """
    Call LiteLLM async completion.
    Returns the parsed JSON body on success.
    Falls back to MODEL_FALLBACK on error.
    """
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}

    for attempt_model in (model, MODEL_FALLBACK):
        try:
            kwargs["model"] = attempt_model
            resp = await litellm.acompletion(**kwargs)
            content = resp.choices[0].message.content

            if tracing_enabled:
                try:
                    cost = litellm.completion_cost(completion_response=resp)
                    _get_langfuse_client().update_current_generation(
                        model=resp.model,
                        usage={
                            "input": resp.usage.prompt_tokens,
                            "output": resp.usage.completion_tokens,
                        },
                        metadata={"cost_usd": cost},
                    )
                except Exception:
                    pass  # tracing must never break inference

            if json_mode:
                return json.loads(content)
            return {"text": content}
        except Exception as exc:
            if attempt_model == MODEL_FALLBACK:
                logger.exception("LLM call failed on fallback model %s", attempt_model)
                raise
            logger.warning("LLM call failed on %s (%s), retrying with fallback", attempt_model, exc)

    raise RuntimeError("All LLM attempts failed")


@observe(name="classify_intent")
async def classify_intent(message: str) -> dict[str, Any]:
    """
    Classify user message intent.
    Returns {"intent": "entry_command|exit_command|analysis|question|hotword|list_commands|cancel_commands",
             "confidence": float}
    """
    system = (
        "You are a trading assistant for Indian markets (NSE/NFO). Classify the user's message "
        "into exactly one of these intents:\n"
        '- "entry_command"    : an instruction to enter a trade (buy/sell) when a bar condition is met\n'
        '- "exit_command"     : an instruction to exit a position, update a stoploss, or start a '
        'TakeProfit strategy when a bar condition is met\n'
        '- "analysis"         : a request to analyze past trades\n'
        '- "question"         : a general question about the platform or markets\n'
        '- "hotword"          : a reference to a saved strategy by name (e.g. "use pullback entry")\n'
        '- "list_commands"    : a request to see currently active commands or saved hotwords\n'
        '- "cancel_commands"  : a request to cancel one or more active watching commands '
        '(e.g. "cancel all", "cancel 1", "cancel CE commands", "stop all PE orders")\n'
        'Respond with JSON only: {"intent": "<type>", "confidence": 0.0–1.0}'
    )
    return await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
    )


@observe(name="extract_cancel_params")
async def extract_cancel_params(message: str) -> dict[str, Any]:
    """
    Extract cancel target from a cancel_commands intent message.
    Returns {"right": "CE"|"PE"|null, "index": int|null, "cancel_all": bool}
    - right: CE or PE if only that leg is mentioned; null means all
    - index: 1-based command index if user says "cancel 1" / "cancel command 2"; null otherwise
    - cancel_all: true when no specific index is given
    """
    system = (
        'Extract cancel parameters from this trading command cancellation message. '
        'Return JSON only: {"right": "CE" | "PE" | null, "index": integer | null, "cancel_all": boolean}\n'
        '- right: "CE" if only CE/call commands are mentioned, "PE" if only PE/put, null otherwise\n'
        '- index: 1-based integer if the user references a specific command by number; null otherwise\n'
        '- cancel_all: true when no specific index is referenced'
    )
    return await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
    )


@observe(name="llm_evaluate_command")
async def evaluate_command(
    parsed_trigger: str,
    parsed_price_expr: str,
    order_type: str,
    quantity_type: str,
    quantity_value: Any,
    bars: list[dict],
    position: dict | None,
    command_text: str = "",
) -> dict[str, Any]:
    """
    Evaluate whether the entry/exit condition is met for the current bar.
    Returns {"should_trade": bool, "side": "BUY"|"SELL", "reason": str, "computed_price": float|null}
    """
    if not bars:
        return {"should_trade": False, "side": "BUY", "reason": "No bars available", "computed_price": None}

    current = bars[-1]
    prev = bars[-2] if len(bars) >= 2 else {}
    bar_color = "bear" if current.get("close", 0) < current.get("open", 0) else "bull"
    position_json = json.dumps(position) if position else "null"

    system = (
        "You are a trading execution engine for Indian equity/options markets (NSE/NFO).\n"
        "Evaluate whether the condition is met by the bar that just closed, "
        "determine the trade side (BUY/SELL), and compute the order price.\n\n"
        "Evaluate ONLY the most recent bar (last in the list). Previous bars are context only.\n"
        "Do NOT fire on a condition already met in an earlier bar.\n\n"
        f"Current bar (just closed):\n"
        f"  open={current.get('open')}  high={current.get('high')}  "
        f"low={current.get('low')}  close={current.get('close')}\n"
        f"  bar_color={bar_color}\n\n"
        f"Previous bar:\n"
        f"  open={prev.get('open')}  high={prev.get('high')}  "
        f"low={prev.get('low')}  close={prev.get('close')}\n\n"
        f"Current position (null if none):\n{position_json}\n\n"
        f"All bars for additional context (oldest → newest):\n{json.dumps(bars)}\n\n"
        f"Command text (original natural language):\n{command_text}\n\n"
        f"Condition to evaluate:\n"
        f"  Trigger      : {parsed_trigger}\n"
        f"  Price expr   : {parsed_price_expr}\n"
        f"  Order type   : {order_type}\n"
        f"  Quantity     : {quantity_type}"
        + (f" {quantity_value}" if quantity_value is not None else "") + "\n\n"
        "Rules:\n"
        "- Respond with JSON only.\n"
        '- Schema: {"side": "BUY"|"SELL", "computed_price": <number|null>, '
        '"reason": "<full step-by-step arithmetic>", "should_trade": true|false}\n'
        "- IMPORTANT: write `reason` first with your complete arithmetic before setting `should_trade`.\n"
        "- side: infer BUY or SELL from the command text; entry → BUY, exit → SELL.\n"
        "- computed_price: required (non-null) when should_trade is true and order_type != market.\n"
        "- Price expression evaluation:\n"
        '    "market"           → computed_price = null\n'
        '    "(open+close)/2"   → computed_price = round((open+close)/2 to nearest 0.05)\n'
        '    "close+0.5"        → computed_price = round(close+0.5 to nearest 0.05)\n'
        '    "<fixed number>"   → computed_price = that number rounded to nearest 0.05\n'
        "- All prices must be rounded to nearest ₹0.05 (NSE minimum tick size).\n"
        "- If the trigger cannot be evaluated from available data, set should_trade=false."
    )
    return await _complete(
        MODEL_COMMAND_EVALUATOR,
        [
            {"role": "system", "content": system},
            {"role": "user", "content": "Evaluate the condition for this bar close."},
        ],
    )


@observe(name="extract_command_fields")
async def extract_command_fields(message: str) -> dict[str, Any]:
    """
    Extract trading command fields from natural language.
    Returns structured fields for command registration.

    Output schema:
      {order_type, quantity_type, quantity_value, right, trigger_right, trigger, price_expr, hotword, missing_fields}
    """
    system = (
        "You are parsing a natural language trading command for Indian markets (NSE/NFO).\n"
        "Extract these fields and return JSON only:\n\n"
        "{\n"
        '  "order_type":     "market" | "limit" | "target" | null,\n'
        '  "quantity_type":  "ratio_l" | "ratio_m" | "ratio_h" | "fixed" | null,\n'
        '  "quantity_value": <number or null — only for "fixed" type>,\n'
        '  "right":          "CE" | "PE" | null,\n'
        '  "trigger_right":  "CE" | "PE" | null,\n'
        '  "trigger":        "<normalized entry condition using bar params: '
        "low/high/close/open/bear/bull/prev_bar.X>\",\n"
        '  "price_expr":     "<price expression: market | (open+close)/2 | close+0.5 | '
        "89.5 | prev_bar.high | etc>\",\n"
        '  "hotword":        "<strategy name if user says save as X or call this X, else null>",\n'
        '  "missing_fields": ["<list of field names that are absent or ambiguous>"]\n'
        "}\n\n"
        "Rules:\n"
        "- quantity_type: L/low/small → ratio_l; M/medium → ratio_m; H/high/large → ratio_h\n"
        "- right: the OPTIONS LEG for the order — set to CE or PE only if explicitly mentioned; else null\n"
        "- trigger_right: which bar stream should trigger evaluation:\n"
        "    set to 'CE' if the trigger condition is explicitly about CE bar behaviour\n"
        "    set to 'PE' if the trigger condition is explicitly about PE bar behaviour\n"
        "    set to null if the trigger is about Nifty/underlying bars, or the stream is unspecified\n"
        "  Examples:\n"
        "    'when CE bar closes bull' → trigger_right='CE'\n"
        "    'when PE bar low breaks previous low' → trigger_right='PE'\n"
        "    'when Nifty crosses 25000' → trigger_right=null\n"
        "    'when bar closes green' (no stream specified) → trigger_right=null\n"
        "- price_expr: for market order_type → always 'market'; "
        "for target/limit → extract from message; null if unclear\n"
        "- trigger: normalize to bar-param expressions; null if entry condition not stated\n"
        "- missing_fields: include 'order_type' if absent, 'quantity_type' if absent,\n"
        "  'trigger' if entry condition not stated, 'price_expr' if not determinable\n"
        "- Do NOT include 'right' or 'trigger_right' in missing_fields — the caller handles these"
    )
    return await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
    )


@observe(name="extract_hotword_name")
async def extract_hotword_name(message: str) -> str | None:
    """Extract the strategy hotword name from a recall message like 'use pullback buy'."""
    system = (
        "Extract the strategy hotword name from the user's message.\n"
        "Examples:\n"
        '  "use pullback buy"           → {"hotword": "pullback buy"}\n'
        '  "activate my trend entry"    → {"hotword": "trend entry"}\n'
        '  "run the gap fill strategy"  → {"hotword": "gap fill strategy"}\n'
        'Respond with JSON only: {"hotword": "<name>" | null}'
    )
    result = await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
    )
    return result.get("hotword")


@observe(name="answer_question")
async def answer_question(message: str) -> str:
    """Answer a general trading or platform question. Returns plain text."""
    system = (
        "You are a helpful assistant for the Trade Matangi trading platform (Indian markets, NSE/NFO).\n"
        "Answer the user's question concisely. Focus on trading concepts, platform usage, "
        "and Indian market specifics.\n"
        "Respond with plain text only (no JSON)."
    )
    result = await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
        json_mode=False,
        temperature=0.3,
    )
    return result.get("text", "I'm here to help with trading commands and analysis. Could you rephrase?")


@observe(name="extract_date_range")
async def extract_date_range(message: str, today: str) -> dict[str, Any]:
    """
    Parse a date range from a user's analysis request.
    Returns {"from_date": "YYYY-MM-DD", "to_date": "YYYY-MM-DD", "period_description": str}
    Falls back to last 7 days on parse error.
    """
    system = (
        f"Today's date is {today}.\n"
        "Extract the date range the user wants to analyze. Return JSON only:\n"
        '{"from_date": "YYYY-MM-DD", "to_date": "YYYY-MM-DD", "period_description": "<short label>"}\n\n'
        "Rules:\n"
        '- "last 7 days" / "past week" → from = today − 7 days, to = today\n'
        '- "last month" / "past month" / "last 30 days" → from = today − 30 days, to = today\n'
        '- "last 3 days" → from = today − 3 days, to = today\n'
        '- "today" → from = today, to = today\n'
        '- "yesterday" → from = today − 1 day, to = today − 1 day\n'
        '- "from YYYY-MM-DD to YYYY-MM-DD" → use those dates literally\n'
        '- If no date range mentioned → default: last 7 days\n'
        '- period_description: human-readable label (e.g. "last 7 days", "May 2026")'
    )
    return await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
    )


@observe(name="extract_exit_command_fields")
async def extract_exit_command_fields(message: str) -> dict[str, Any]:
    """
    Extract exit command fields from natural language.
    Returns structured fields for exit command registration.

    Output schema:
      {right, trigger_right, exit_action, exit_price_expr, trigger, hotword, missing_fields}
    """
    system = (
        "You are parsing a natural language exit command for Indian markets (NSE/NFO).\n"
        "Extract these fields and return JSON only:\n\n"
        "{\n"
        '  "right":           "CE" | "PE" | null,\n'
        '  "trigger_right":   "CE" | "PE" | null,\n'
        '  "exit_action":     "update_stoploss" | "exit_position" | "start_takeprofit" | null,\n'
        '  "exit_price_expr": "<price expression or null>",\n'
        '  "trigger":         "<normalized exit condition using bar params: '
        "low/high/close/open/bear/bull/prev_bar.X>\",\n"
        '  "hotword":         "<strategy name if user says save as X or call this X, else null>",\n'
        '  "missing_fields":  ["<list of field names that are absent or ambiguous>"]\n'
        "}\n\n"
        "Rules:\n"
        "- exit_action inference:\n"
        "    'exit position' / 'exit immediately' / 'square off' / 'close position' → exit_position\n"
        "    'update stoploss' / 'move SL' / 'shift SL' / 'set SL to' → update_stoploss\n"
        "    'start take profit' / 'start TP strategy' / 'take profit at' → start_takeprofit\n"
        "    If ambiguous → null\n"
        "- exit_price_expr: required for update_stoploss (new SL price) and start_takeprofit (TP target);\n"
        "    null for exit_position; null if not determinable\n"
        "    Examples: 'prev_bar.low', 'close - 1', 'open of the current bar', '89.5'\n"
        "- right: the OPTIONS LEG affected — CE or PE if explicitly mentioned; null for equity\n"
        "- trigger_right: which bar stream triggers evaluation (same rules as entry commands):\n"
        "    'CE' if trigger condition is about CE bar behaviour\n"
        "    'PE' if trigger condition is about PE bar behaviour\n"
        "    null if trigger is about Nifty/underlying bars or stream is unspecified\n"
        "- trigger: normalize to bar-param expressions; null if exit condition not stated\n"
        "- missing_fields: include 'exit_action' if not determinable, 'trigger' if absent,\n"
        "    'exit_price_expr' if required but not determinable\n"
        "- Do NOT include 'right' or 'trigger_right' in missing_fields"
    )
    return await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
    )


@observe(name="evaluate_exit_command", as_type="generation")
async def evaluate_exit_command(
    parsed_trigger: str,
    exit_action: str,
    exit_price_expr: str | None,
    bars: list[dict],
    position: dict | None,
    command_text: str = "",
) -> dict[str, Any]:
    """
    Evaluate whether the exit condition is met for the current bar.
    Returns {"should_exit": bool, "exit_action": str, "computed_price": float|null, "reason": str}
    """
    if not bars:
        return {
            "should_exit": False,
            "exit_action": exit_action,
            "computed_price": None,
            "reason": "No bars available",
        }

    current = bars[-1]
    prev = bars[-2] if len(bars) >= 2 else {}
    bar_color = "bear" if current.get("close", 0) < current.get("open", 0) else "bull"
    position_json = json.dumps(position) if position else "null"

    system = (
        "You are a trading exit execution engine for Indian equity/options markets (NSE/NFO).\n"
        "Evaluate whether the exit condition is met by the bar that just closed, "
        "and compute the exit/stoploss/target price if required.\n\n"
        "Evaluate ONLY the most recent bar (last in the list). Previous bars are context only.\n"
        "Do NOT fire on a condition already met in an earlier bar.\n\n"
        f"Current bar (just closed):\n"
        f"  open={current.get('open')}  high={current.get('high')}  "
        f"low={current.get('low')}  close={current.get('close')}\n"
        f"  bar_color={bar_color}\n\n"
        f"Previous bar:\n"
        f"  open={prev.get('open')}  high={prev.get('high')}  "
        f"low={prev.get('low')}  close={prev.get('close')}\n\n"
        f"Current position (null if none):\n{position_json}\n\n"
        f"All bars for additional context (oldest → newest):\n{json.dumps(bars)}\n\n"
        f"Command text (original natural language):\n{command_text}\n\n"
        f"Exit condition to evaluate:\n"
        f"  Trigger      : {parsed_trigger}\n"
        f"  Exit action  : {exit_action}\n"
        f"  Price expr   : {exit_price_expr or 'N/A (exit_position needs no price)'}\n\n"
        "Rules:\n"
        "- Respond with JSON only.\n"
        '- Schema: {"exit_action": "<exit_action value>", "computed_price": <number|null>, '
        '"reason": "<full step-by-step arithmetic>", "should_exit": true|false}\n'
        "- IMPORTANT: write `reason` first with your complete arithmetic before setting `should_exit`.\n"
        "- should_exit: true only if the trigger condition is fully met by the CURRENT bar.\n"
        "- exit_action: echo the exit_action value from the condition above.\n"
        "- computed_price:\n"
        "    exit_position   → null (no price needed; market sell will be used)\n"
        "    update_stoploss → evaluate exit_price_expr against bar params\n"
        "    start_takeprofit→ evaluate exit_price_expr against bar params\n"
        "- Price expression evaluation examples:\n"
        '    "prev_bar.low"        → use the previous bar low value\n'
        '    "prev_bar.high"       → use the previous bar high value\n'
        '    "close - 1"           → current bar close minus 1\n'
        '    "open of current bar" → current bar open\n'
        '    "<fixed number>"      → that number\n'
        "- All computed prices must be rounded to nearest ₹0.05 (NSE minimum tick size).\n"
        "- If position is FLAT or null, set should_exit=false, "
        'reason="No open position to exit".\n'
        "- If the trigger cannot be evaluated from available data, set should_exit=false."
    )
    return await _complete(
        MODEL_COMMAND_EVALUATOR,
        [
            {"role": "system", "content": system},
            {"role": "user", "content": "Evaluate the exit condition for this bar close."},
        ],
    )


@observe(name="analyze_trades")
async def analyze_trades(trades: list[dict], date_range: str) -> dict[str, Any]:
    """
    Analyze trade history and return structured insights.
    """
    system = (
        "You are a trading performance coach analyzing trades from Indian equity/options markets.\n"
        "You will receive a list of trades with entry/exit prices, P&L, timestamps, and session metadata.\n\n"
        "Identify patterns — both positive and negative. Be specific and quantitative where possible.\n"
        "Respond with JSON only:\n"
        "{\n"
        '  "summary": "<2–3 sentence overall assessment>",\n'
        '  "patterns": [\n'
        '    {\n'
        '      "type": "negative" | "positive",\n'
        '      "title": "<short title>",\n'
        '      "detail": "<specific observation with numbers>",\n'
        '      "frequency": "<e.g. \'7 of 10 losing trades\'>"\n'
        '    }\n'
        '  ],\n'
        '  "suggestions": ["<actionable improvement 1>", "<actionable improvement 2>"],\n'
        '  "notable_stats": {\n'
        '    "win_rate": "<e.g. 42%>",\n'
        '    "avg_profit_pct": "<e.g. 1.8%>",\n'
        '    "avg_loss_pct": "<e.g. 3.2%>",\n'
        '    "best_time_of_day": "<e.g. \'09:15–10:30\'>",\n'
        '    "worst_time_of_day": "<e.g. \'13:00–14:00\'>"\n'
        '  }\n'
        "}\n\n"
        f"Date range: {date_range}\n"
        f"Trades data:\n{json.dumps(trades)}"
    )
    return await _complete(
        MODEL_ANALYSIS,
        [{"role": "system", "content": system}],
    )
