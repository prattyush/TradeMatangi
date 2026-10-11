"""Portfolio funding rules; no broker writes or inferred historical executions."""

from copy import deepcopy
from math import isfinite

MODES = ("swing", "intraday")


def money(value):
    value = round(float(value), 2)
    if not isfinite(value):
        raise ValueError("Funding amount must be finite")
    return value


def create(reference):
    reference = money(reference)
    if reference <= 0:
        raise ValueError("Starting account capital must be positive")
    return {
        "starting_capital": reference,
        "allocation_reference": reference,
        "unallocated_balance": reference,
        "modes": {},
        "corrections": [],
    }


def allocate(state, mode, fraction):
    if mode not in MODES:
        raise ValueError("Unknown trading mode")
    fraction = float(fraction)
    if not isfinite(fraction) or not 0 < fraction <= 1:
        raise ValueError("Allocation must be between zero and 100%")
    result = deepcopy(state)
    capital = money(result["starting_capital"] * fraction)
    if mode in result["modes"]:
        raise ValueError("Mode already has an allocation in this account period")
    if (
        capital <= 0
        or money(sum(m["capital"] for m in result["modes"].values()) + capital)
        > result["allocation_reference"]
    ):
        raise ValueError("Combined allocations exceed the account reference")
    result["unallocated_balance"] = money(result["unallocated_balance"] - capital)
    result["modes"][mode] = {
        "capital": capital,
        "allocation_pct": fraction,
        "expected_balance": capital,
        "realized_pnl": 0.0,
        "ignored_profit": 0.0,
        "guardrail_epoch": 0,
        "guardrail_start_equity": capital,
    }
    return result


def movement(state, mode, cash_change, realized_pnl=0):
    """Apply confirmed cash/commitment changes exactly once at the persistence layer.

    A buy uses a negative cash change. Selling releases principal plus its P&L.
    Positive P&L remains recorded but does not increase the funding expectation.
    Importing opening inventory has no cash change. Reservations must be released
    or consumed by the caller, not charged a second time on their fills.
    """
    result = deepcopy(state)
    item = result["modes"][mode]
    cash_change, pnl = money(cash_change), money(realized_pnl)
    profit = max(pnl, 0)
    item["expected_balance"] = money(item["expected_balance"] + cash_change - profit)
    item["realized_pnl"] = money(item["realized_pnl"] + pnl)
    item["ignored_profit"] = money(item["ignored_profit"] + profit)
    return result


def expected_balance(state):
    return money(
        state["unallocated_balance"]
        + sum(m["expected_balance"] for m in state["modes"].values())
    )


def status(state, available, *, coherent=True, tolerance=0.01):
    available = money(available)
    expected = expected_balance(state)
    gap = money(max(0, expected - available))
    confirmed = coherent and gap > tolerance
    return {
        "state": "pending"
        if not coherent
        else "shortfall"
        if confirmed
        else "verified",
        "available": available,
        "expected_balance": expected,
        "shortfall": gap if coherent else None,
        "entries_allowed": coherent and not confirmed,
        "modes": deepcopy(state["modes"]),
    }


def correct(state, mode, capital, adjustment, reason, equity):
    """Explicit selected-mode correction; reference edits alone never erase a gap."""
    capital, adjustment, equity = money(capital), money(adjustment), money(equity)
    if capital <= 0 or not str(reason).strip():
        raise ValueError("Positive capital and a correction reason are required")
    result = deepcopy(state)
    item = result["modes"][mode]
    old = item["capital"]
    allocation_reference = money(result["allocation_reference"] + adjustment)
    total = money(
        sum(m["capital"] for k, m in result["modes"].items() if k != mode) + capital
    )
    if allocation_reference <= 0 or total > allocation_reference:
        raise ValueError("Corrected allocations exceed acknowledged account funding")
    item["capital"] = capital
    capital_delta = money(capital - old)
    item["expected_balance"] = money(item["expected_balance"] + capital_delta)
    result["unallocated_balance"] = money(
        result["unallocated_balance"] + adjustment - capital_delta
    )
    result["allocation_reference"] = allocation_reference
    # A reference edit redistributes attribution, not actual broker cash.
    item["guardrail_epoch"] += 1
    item["guardrail_start_equity"] = equity
    result["corrections"].append(
        {
            "mode": mode,
            "old_capital": old,
            "capital": capital,
            "funding_adjustment": adjustment,
            "reason": str(reason).strip(),
        }
    )
    return result


def loss_limit_reached(state, mode, equity, loss_fraction):
    item = state["modes"][mode]
    fraction = float(loss_fraction)
    if not isfinite(fraction) or not 0 < fraction <= 1:
        raise ValueError("Loss limit must be between zero and 100%")
    return money(equity) - item["guardrail_start_equity"] <= -item["capital"] * fraction
