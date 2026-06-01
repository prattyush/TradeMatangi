"""
Rule-based guardrails — applied before LLM call (input) and before order execution (output).
Pluggable: swap this implementation with NeMo Guardrails without changing callers.
"""
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Any

from config import MARKET_OPEN_IST, MARKET_CLOSE_IST

logger = logging.getLogger("aihelper.guardrails.validator")

_ALLOWED_SIDES = {"BUY", "SELL"}
_ALLOWED_QUANTITY_TYPES = {"ratio_l", "ratio_m", "ratio_h", "pct_position", "fixed"}

# IST is UTC+5:30
_IST_OFFSET = timedelta(hours=5, minutes=30)


def _now_ist_time_str() -> str:
    now_utc = datetime.now(timezone.utc)
    now_ist = now_utc + _IST_OFFSET
    return now_ist.strftime("%H:%M:%S")


def sanitize_command_text(text: str) -> str:
    """Strip characters that could cause prompt injection."""
    sanitized = re.sub(r"[^\w\s\.,;:()/+\-*=<>@#%!?'\"\[\]{}]", "", text)
    return sanitized.strip()


def check_market_hours() -> tuple[bool, str]:
    """
    Return (ok, reason). ok=True during NSE market hours (09:15–15:30 IST).
    Simulation sessions can bypass this — callers decide.
    """
    now = _now_ist_time_str()
    if now < MARKET_OPEN_IST or now > MARKET_CLOSE_IST:
        return False, f"Outside market hours ({now} IST; market 09:15–15:30)"
    return True, ""


def validate_action(action: dict[str, Any], position: dict | None) -> tuple[bool, str]:
    """
    Validate the LLM-produced action dict before placing an order.
    Returns (ok, rejection_reason).
    """
    side = action.get("side", "").upper()
    if side not in _ALLOWED_SIDES:
        return False, f"Invalid side '{side}' — must be BUY or SELL"

    qty_type = action.get("quantity_type", "")
    if qty_type not in _ALLOWED_QUANTITY_TYPES:
        return False, f"Invalid quantity_type '{qty_type}'"

    # Block BUY when already long in the same direction
    if side == "BUY" and position and position.get("side") == "BUY" and position.get("qty", 0) > 0:
        return False, "BUY blocked — long position already exists (no averaging)"

    # Block SELL when no position
    if side == "SELL" and (not position or position.get("qty", 0) == 0):
        return False, "SELL blocked — no open position"

    return True, ""


_ALLOWED_EXIT_ACTIONS = {"update_stoploss", "exit_position", "start_takeprofit"}


def validate_exit_action(action: dict[str, Any], position: dict | None) -> tuple[bool, str]:
    """
    Validate the LLM-produced exit action dict before dispatching to backend.
    Returns (ok, rejection_reason).
    """
    exit_action = action.get("exit_action", "")
    if exit_action not in _ALLOWED_EXIT_ACTIONS:
        return False, f"Unknown exit_action '{exit_action}'"

    if exit_action in ("update_stoploss", "start_takeprofit"):
        price = action.get("computed_price")
        if price is None or float(price) <= 0:
            return False, f"{exit_action} requires a positive computed_price"

    if not position or int(position.get("qty", 0)) == 0:
        return False, "No open position to exit"

    return True, ""
