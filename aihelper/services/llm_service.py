"""
LiteLLM wrapper — provider-agnostic async completion.
Model names are read from config (per role).
config.py sets the API key env vars before this module is imported.
"""
import json
import logging
from typing import Any

import litellm

from config import MODEL_INTENT_CLASSIFIER, MODEL_COMMAND_EVALUATOR, MODEL_ANALYSIS, MODEL_FALLBACK

logger = logging.getLogger("aihelper.services.llm_service")

# Suppress verbose litellm success/failure logging
litellm.suppress_debug_info = True


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
            if json_mode:
                return json.loads(content)
            return {"text": content}
        except Exception as exc:
            if attempt_model == MODEL_FALLBACK:
                logger.exception("LLM call failed on fallback model %s", attempt_model)
                raise
            logger.warning("LLM call failed on %s (%s), retrying with fallback", attempt_model, exc)

    raise RuntimeError("All LLM attempts failed")


async def classify_intent(message: str) -> dict[str, Any]:
    """
    Classify user message intent.
    Returns {"intent": "command|analysis|question|hotword|list_commands", "confidence": float}
    """
    system = (
        "You are a trading assistant for Indian markets (NSE/NFO). Classify the user's message "
        "into exactly one of these intents:\n"
        '- "command"       : an entry, exit, or partial-exit instruction tied to market conditions\n'
        '- "analysis"      : a request to analyze past trades\n'
        '- "question"      : a general question about the platform or markets\n'
        '- "hotword"       : a reference to a saved strategy by name (e.g. "use pullback entry")\n'
        '- "list_commands" : a request to see currently active commands or saved hotwords\n'
        'Respond with JSON only: {"intent": "<type>", "confidence": 0.0–1.0}'
    )
    return await _complete(
        MODEL_INTENT_CLASSIFIER,
        [{"role": "system", "content": system}, {"role": "user", "content": message}],
    )


async def evaluate_command(
    parsed_trigger: str,
    parsed_price_expr: str,
    order_type: str,
    quantity_type: str,
    quantity_value: Any,
    bars: list[dict],
    position: dict | None,
) -> dict[str, Any]:
    """
    Evaluate whether the entry condition is met for the current bar.
    Returns {"should_trade": bool, "reason": str, "computed_price": float | null}
    """
    if not bars:
        return {"should_trade": False, "reason": "No bars available", "computed_price": None}

    current = bars[-1]
    prev = bars[-2] if len(bars) >= 2 else {}
    bar_color = "bear" if current.get("close", 0) < current.get("open", 0) else "bull"
    position_json = json.dumps(position) if position else "null"

    system = (
        "You are a trading execution engine for Indian equity/options markets (NSE/NFO).\n"
        "Evaluate whether the entry condition is met by the bar that just closed, "
        "and compute the order price from the price expression.\n\n"
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
        f"Entry condition to evaluate:\n"
        f"  Trigger      : {parsed_trigger}\n"
        f"  Price expr   : {parsed_price_expr}\n"
        f"  Order type   : {order_type}\n"
        f"  Quantity     : {quantity_type}"
        + (f" {quantity_value}" if quantity_value is not None else "") + "\n\n"
        "Rules:\n"
        "- Respond with JSON only.\n"
        '- Schema: {"should_trade": true|false, "reason": "<1-2 sentences>", "computed_price": <number|null>}\n'
        "- computed_price is required (non-null) when should_trade is true.\n"
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
        [{"role": "system", "content": system}],
    )


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
