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
        "reservations": {},
    }


def allocate(state, mode, fraction):
    if mode not in MODES:
        raise ValueError("Unknown trading mode")
    fraction = float(fraction)
    if not isfinite(fraction) or not 0 < fraction <= 1:
        raise ValueError("Allocation must be between zero and 100%")
    result = deepcopy(state)
    capital = money(result["allocation_reference"] * fraction)
    if mode in result["modes"]:
        raise ValueError("Mode already has an allocation in this account period")
    if (
        capital <= 0
        or money(
            sum(
                m.get("funding_allocation", m["capital"])
                for m in result["modes"].values()
            )
            + capital
        )
        > result["allocation_reference"]
    ):
        raise ValueError("Combined allocations exceed the account reference")
    result["unallocated_balance"] = money(result["unallocated_balance"] - capital)
    result["modes"][mode] = {
        "capital": capital,
        "funding_allocation": capital,
        "acknowledged_profit": 0,
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
        - sum(
            t.get("expected_amount", t["amount"])
            for t in state.get("reservations", {}).values()
            if t["owner"] == "broker"
        )
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
    old_allocation = item.get("funding_allocation", old)
    new_allocation = money(old_allocation + adjustment) if adjustment else capital
    total = money(
        sum(
            m.get("funding_allocation", m["capital"])
            for k, m in result["modes"].items()
            if k != mode
        )
        + new_allocation
    )
    if allocation_reference <= 0 or new_allocation <= 0 or total > allocation_reference:
        raise ValueError("Corrected allocations exceed acknowledged account funding")
    item["capital"] = capital
    item["funding_allocation"] = new_allocation
    if adjustment:
        item["expected_balance"] = money(item["expected_balance"] + adjustment)
        remaining = max(0, adjustment)
        sources = {}
        for key in [mode] + [k for k in result["modes"] if k != mode]:
            source = result["modes"][key]
            amount = min(
                remaining,
                max(
                    0,
                    money(
                        source["ignored_profit"] - source.get("acknowledged_profit", 0)
                    ),
                ),
            )
            if amount:
                source["acknowledged_profit"] = money(
                    source.get("acknowledged_profit", 0) + amount
                )
                remaining = money(remaining - amount)
                sources[key] = amount
    else:
        delta = money(new_allocation - old_allocation)
        item["expected_balance"] = money(item["expected_balance"] + delta)
        result["unallocated_balance"] = money(result["unallocated_balance"] - delta)
        sources = {}
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
            "acknowledged_profit_sources": sources,
        }
    )
    return result


def loss_limit_reached(state, mode, equity, loss_fraction):
    item = state["modes"][mode]
    fraction = float(loss_fraction)
    if not isfinite(fraction) or not 0 < fraction <= 1:
        raise ValueError("Loss limit must be between zero and 100%")
    return money(equity) - item["guardrail_start_equity"] <= -item["capital"] * fraction


def reset_reference(state, mode, capital, equity):
    """Reset sizing/guardrails without moving cash or erasing funding differences."""
    capital, equity = money(capital), money(equity)
    if capital <= 0:
        raise ValueError("Capital must be positive")
    result = deepcopy(state)
    item = result["modes"][mode]
    item["capital"] = capital
    item["guardrail_epoch"] += 1
    item["guardrail_start_equity"] = equity
    return result


def adopt_opening_inventory(state, mode, cost):
    """Recognize funded assets in this mode's allocation, not a broker cash debit."""
    cost = money(cost)
    if cost < 0:
        raise ValueError("Opening inventory cost cannot be negative")
    result = deepcopy(state)
    item = result["modes"][mode]
    item["expected_balance"] = money(item["expected_balance"] - cost)
    result["unallocated_balance"] = money(result["unallocated_balance"] + cost)
    result["allocation_reference"] = money(result["allocation_reference"] + cost)
    return result


def mode_available(state, mode):
    item = state["modes"][mode]
    income = max(0, money(item["ignored_profit"] - item.get("acknowledged_profit", 0)))
    return money(
        item["expected_balance"]
        + income
        - sum(
            t["amount"]
            for t in state.get("reservations", {}).values()
            if t["mode"] == mode
        )
    )


def reserve(state, mode, operation, amount, *, owner="local", expected_amount=None):
    if owner not in ("local", "broker") or not operation:
        raise ValueError("A reservation requires an identity and owner")
    amount = money(amount)
    expected = amount if expected_amount is None else money(expected_amount)
    if amount < 0 or not 0 <= expected <= amount:
        raise ValueError("Invalid reservation amount")
    result = deepcopy(state)
    previous = result["reservations"].get(operation)
    if previous and previous["mode"] != mode:
        raise ValueError("Reservation belongs to another mode")
    if amount == 0:
        result["reservations"].pop(operation, None)
        return result
    available = mode_available(result, mode) + (previous["amount"] if previous else 0)
    if amount > available:
        raise ValueError("Selected mode has insufficient available funds")
    if amount:
        result["reservations"][operation] = {
            "mode": mode,
            "owner": owner,
            "amount": amount,
            "expected_amount": expected,
        }
    else:
        result["reservations"].pop(operation, None)
    return result


def release(state, mode, operation):
    result = deepcopy(state)
    previous = result["reservations"].get(operation)
    if previous and previous["mode"] != mode:
        raise ValueError("Reservation belongs to another mode")
    result["reservations"].pop(operation, None)
    return result
