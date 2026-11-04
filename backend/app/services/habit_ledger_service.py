"""
Habit ledger — Phase 23 Sprint 7a.

One compact row per closed, own, intraday trade (cycle) with the user's behavior marks ("habits") attached.
The Habits view (Stats → Habits) computes every statistic from these rows in the browser/desktop, so a number
shown for a habit always reconciles with the same trades the Stats overview counts.

Joining a mark to a trade: a mark is ``(session_id, round_trip_index)`` and ``round_trip_index`` equals the
cycle's ``index`` (``build_cycles`` numbers a cycle when it opens — the number labels use). Real-day aliases
share one book; marks written under an alias session are mapped to the owner session the cycles belong to, and
duplicate marks of the same trade collapse. Marks that cannot be matched are counted, never dropped silently.
Swing portfolios are out of scope (they are keyed by ``label_index``).

The pure functions here take plain dicts so they can be tested without a database; ``load_ledger`` does the I/O.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict

logger = logging.getLogger(__name__)

MAX_ROWS = 20_000
DEFAULT_INTERVAL_SECONDS = 180


def _finite(value) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def interval_seconds(cycle: dict) -> int:
    """Candle size used for "bars held": the entry's strategy interval, else 180 s."""
    for entry in cycle.get("entries") or []:
        value = _finite((entry.get("analytics") or {}).get("strategy_interval_seconds"))
        if value and value > 0:
            return int(value)
    return DEFAULT_INTERVAL_SECONDS


def bars_held(entry_time, exit_time, interval: int) -> int | None:
    """Candles touched by the trade; entering and exiting inside the same candle is 1 bar."""
    start, end = _finite(entry_time), _finite(exit_time)
    if start is None or end is None or end < start or interval <= 0:
        return None
    return int(end // interval - start // interval) + 1


def _entry_total(cycle: dict, field: str) -> float | None:
    """Sum of an analytics field over the entries; unavailable when any entry lacks it (older or broker-imported rows)."""
    entries = cycle.get("entries") or []
    if not entries:
        return None
    total = 0.0
    for entry in entries:
        value = _finite((entry.get("analytics") or {}).get(field))
        if value is None:
            return None
        total += value
    return total


def capital_pct(cycle: dict) -> float | None:
    """Total capital deployed on the trade, as % of the session capital (sum of the entries' effective allocation)."""
    return _entry_total(cycle, "effective_allocation_pct")


def risk_pct(cycle: dict) -> float | None:
    """Total capital at risk at entry, as % of the session capital (sum of the entries' effective risk)."""
    return _entry_total(cycle, "effective_risk_pct")


def _round(value, places):
    return None if value is None else round(value, places)


def trade_row(cycle: dict, habits: list[str] | None = None) -> dict:
    interval = interval_seconds(cycle)
    first_entry = (cycle.get("entries") or [{}])[0]
    r_multiples = [_finite(e.get("r_multiple")) for e in cycle.get("entries") or []]
    r_values = [r for r in r_multiples if r is not None]
    return {
        "cycle_id": cycle["cycle_id"],
        "session_id": cycle["session_id"],
        "date": cycle.get("date", ""),
        "entry_time": int(cycle["entry_time"]),
        "exit_time": int(cycle["exit_time"]) if cycle.get("exit_time") is not None else None,
        "symbol": cycle.get("symbol", ""),
        "right": cycle.get("right"),
        "strike": _finite(cycle.get("strike")),
        "direction": cycle.get("direction", ""),
        "net_pnl": _round(_finite(cycle.get("net_pnl")) or 0.0, 2),
        "pnl_pct": _round(_finite(cycle.get("pnl_pct")), 4),
        "capital_pct": _round(capital_pct(cycle), 4),
        "risk_pct": _round(risk_pct(cycle), 4),
        "entries": int(cycle.get("entry_count") or len(cycle.get("entries") or [])),
        "exits": int(cycle.get("exit_count") or len(cycle.get("exits") or [])),
        "holding_seconds": int(cycle["holding_seconds"]) if cycle.get("holding_seconds") is not None else None,
        "bars": bars_held(cycle.get("entry_time"), cycle.get("exit_time"), interval),
        "r_multiple": _round(sum(r_values) / len(r_values), 4) if r_values else None,
        "entry_method": first_entry.get("entry_method"),
        "habits": sorted(set(habits or [])),
    }


def owner_session_id(session: dict | None, session_id: str) -> str:
    """Linked real-day aliases belong to the owner session; every other session is its own owner."""
    return (session or {}).get("broker_projection_owner") or session_id


def build_ledger(cycles: list[dict], marks: list[dict], sessions: dict[str, dict], questions: list[dict], max_rows: int = MAX_ROWS) -> dict:
    """Closed own intraday trades with their habits, plus coverage counts.

    ``cycles`` come from ``performance_service.load_cycles`` (already scoped by the dashboard filters); ``marks`` are
    BehaviorMarks rows; ``sessions`` maps a mark's session id to its Sessions row (for the alias → owner mapping).
    """
    own = [c for c in cycles if not c.get("shared") and c.get("trading_style", "intraday") != "swing"]
    by_trip = {(c["session_id"], int(c["index"])): c for c in own}
    habits: dict[tuple[str, int], set[str]] = defaultdict(set)
    seen: set[tuple[str, int, str]] = set()
    unmatched = 0
    open_marked: set[tuple[str, int]] = set()
    marks_used = 0
    for mark in marks:
        sid = str(mark["session_id"])
        owner = owner_session_id(sessions.get(sid), sid)
        trip = int(mark["round_trip_index"])
        identity = (owner, trip, str(mark["question_id"]))
        if identity in seen:  # the same mark written under two aliases of one real day
            continue
        seen.add(identity)
        cycle = by_trip.get((owner, trip))
        if cycle is None:
            unmatched += 1
        elif cycle.get("state") != "closed":
            open_marked.add((owner, trip))
        else:
            habits[(owner, trip)].add(str(mark["question_id"]))
            marks_used += 1
    closed = sorted((c for c in own if c.get("state") == "closed"), key=lambda c: (c.get("date", ""), c["entry_time"], c["cycle_id"]))
    rows = [trade_row(c, list(habits.get((c["session_id"], int(c["index"])), ()))) for c in closed]
    truncated = len(rows) > max_rows
    if truncated:
        rows = rows[-max_rows:]  # keep the most recent trades
    return {
        "questions": questions,
        "trades": rows,
        "coverage": {
            "closed_trades": len(closed),
            "marked_trades": len(habits),
            "marks": marks_used,
            "unmatched_marks": unmatched,
            "open_marked_trades": len(open_marked),
            "trades_without_capital": sum(1 for r in rows if r["capital_pct"] is None),
            "trades_without_bars": sum(1 for r in rows if r["bars"] is None),
            "truncated": truncated,
        },
    }


def _fetch_sessions(session_ids: set[str]) -> dict[str, dict]:
    from app.services.db import get_dynamodb_resource

    table = get_dynamodb_resource().Table("Sessions")
    rows: dict[str, dict] = {}
    for sid in session_ids:
        item = table.get_item(Key={"session_id": sid}, ConsistentRead=True).get("Item")
        if item:
            rows[sid] = item
    return rows


def load_ledger(user_id: str, criteria: dict) -> dict:
    """Read the user's cycles (scoped by the dashboard filters) and marks, and build the ledger."""
    from app.services import behavior_service, performance_service

    scope = {**criteria, "include_shared": False}  # own sessions only: a viewer has none of the owner's marks
    cycles = performance_service.load_cycles(user_id, **scope)
    marks = [
        row for row in behavior_service._user_marks(user_id, criteria.get("start_date"), criteria.get("end_date"))
        if behavior_service._matches(row, criteria.get("symbol"), criteria.get("session_type"), criteria.get("instrument_type"))
    ]
    sessions = _fetch_sessions({str(row["session_id"]) for row in marks})
    questions = behavior_service.list_questions(user_id, include_archived=True)
    return build_ledger(cycles, marks, sessions, questions)
