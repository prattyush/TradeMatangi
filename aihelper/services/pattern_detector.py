"""
Programmatic pattern detection for trade analysis.
All functions accept pre-fetched bar data and return structured finding dicts.
Aggregation helpers build session- and portfolio-level summaries.
"""
from __future__ import annotations

_BAR_SECONDS = 180  # 3-min candle — must match backend/frontend


# ---------------------------------------------------------------------------
# Trade grouping
# ---------------------------------------------------------------------------

def group_trades(trades: list[dict]) -> list[dict]:
    """
    Split a flat trade list into completed position groups (entry → exit).
    Each group: {direction, entries, exits, first_entry, last_exit, right, strike, expiry}
    Unclosed positions (open at end of session) are included with last_exit=None.
    """
    groups: list[dict] = []
    current: dict | None = None
    net_qty = 0

    for t in sorted(trades, key=lambda x: int(x.get("timestamp", 0))):
        side = t.get("side", "BUY")
        qty = int(t.get("quantity", 1))
        delta = qty if side == "BUY" else -qty

        if net_qty == 0:
            current = {
                "direction": "LONG" if side == "BUY" else "SHORT",
                "entries": [t],
                "exits": [],
                "first_entry": t,
                "last_exit": None,
                "right": t.get("right"),
                "strike": t.get("strike"),
                "expiry": t.get("expiry"),
            }
        else:
            adds_to = (net_qty > 0 and side == "BUY") or (net_qty < 0 and side == "SELL")
            if adds_to:
                current["entries"].append(t)
            else:
                current["exits"].append(t)

        net_qty += delta

        if net_qty == 0 and current is not None:
            current["last_exit"] = current["exits"][-1] if current["exits"] else t
            groups.append(current)
            current = None

    if current is not None:
        groups.append(current)

    return groups


def compute_group_pnl(group: dict) -> float:
    """Net P&L for a trade group: sell_proceeds − buy_cost − commissions."""
    all_trades = group["entries"] + group["exits"]
    sell = sum(float(t["price"]) * int(t["quantity"]) for t in all_trades if t.get("side") == "SELL")
    buy = sum(float(t["price"]) * int(t["quantity"]) for t in all_trades if t.get("side") == "BUY")
    comm = sum(float(t.get("commission", 0)) for t in all_trades)
    return sell - buy - comm


# ---------------------------------------------------------------------------
# Bar extraction helpers
# ---------------------------------------------------------------------------

def extract_labeled_bars(bars: list[dict]) -> dict[str, list[dict]]:
    """Group bars from ohlc-context response by their label field."""
    result: dict[str, list[dict]] = {
        "pre": [], "entry": [], "trade": [], "exit": [], "post": [], "entry_exit": [],
    }
    for b in bars:
        result.setdefault(b.get("label", "pre"), []).append(b)
    return result


def _bar_time(ts: int) -> int:
    return (ts // _BAR_SECONDS) * _BAR_SECONDS


# ---------------------------------------------------------------------------
# Pattern 1: Entry price deviation from bar open
# ---------------------------------------------------------------------------

def detect_entry_deviation(entry_trade: dict, entry_bar: dict | None) -> dict:
    """
    Compare entry price vs bar open.
    For LONG: positive deviation (entry > open) = chasing.
    For SHORT: negative deviation (entry < open) = chasing.
    """
    if entry_bar is None or float(entry_bar.get("open", 0)) == 0:
        return {"detected": False, "deviation_pct": 0.0, "description": "No bar data available"}

    price = float(entry_trade.get("price", 0))
    bar_open = float(entry_bar["open"])
    dev_pct = (price - bar_open) / bar_open * 100
    direction = "LONG" if entry_trade.get("side") == "BUY" else "SHORT"
    chasing = (direction == "LONG" and dev_pct > 0.5) or (direction == "SHORT" and dev_pct < -0.5)

    return {
        "detected": chasing,
        "deviation_pct": round(dev_pct, 2),
        "direction": direction,
        "description": (
            f"Entry {price} is {abs(dev_pct):.2f}% "
            f"{'above' if dev_pct > 0 else 'below'} bar open {bar_open}"
        ),
    }


# ---------------------------------------------------------------------------
# Pattern 2: Early exit
# ---------------------------------------------------------------------------

def detect_early_exit(exit_bar: dict | None, post_bars: list[dict], direction: str) -> dict:
    """Price continued in trade direction after exit (early exit)."""
    if not post_bars or exit_bar is None:
        return {"detected": False, "move_pct": 0.0, "description": "Insufficient post-exit data"}

    exit_close = float(exit_bar.get("close", 0))
    check = post_bars[:2]

    if direction == "LONG":
        continued = any(float(b.get("close", 0)) > exit_close for b in check)
        furthest = max((float(b.get("close", 0)) for b in check), default=exit_close)
    else:
        continued = any(float(b.get("close", 0)) < exit_close for b in check)
        furthest = min((float(b.get("close", 0)) for b in check), default=exit_close)

    move_pct = abs(furthest - exit_close) / exit_close * 100 if exit_close else 0.0

    return {
        "detected": continued,
        "move_pct": round(move_pct, 2),
        "description": (
            f"Price moved {move_pct:.2f}% "
            f"{'further in trade direction after exit (early exit)' if continued else 'against trade direction after exit'}"
        ),
    }


# ---------------------------------------------------------------------------
# Pattern 3: Scared exit
# ---------------------------------------------------------------------------

def detect_scared_exit(
    pnl: float,
    exit_bar: dict | None,
    post_bars: list[dict],
    direction: str,
) -> dict:
    """Exited at a loss, then price reversed within 1-2 bars."""
    if pnl >= 0:
        return {"detected": False, "pnl": round(pnl, 2), "description": "Profitable trade — not a scared exit"}
    if not post_bars or exit_bar is None:
        return {"detected": False, "pnl": round(pnl, 2), "description": "Insufficient post-exit data"}

    exit_close = float(exit_bar.get("close", 0))
    check = post_bars[:2]

    if direction == "LONG":
        reversed_ = any(float(b.get("close", 0)) > exit_close for b in check)
    else:
        reversed_ = any(float(b.get("close", 0)) < exit_close for b in check)

    return {
        "detected": reversed_,
        "pnl": round(pnl, 2),
        "description": (
            f"Loss exit (P&L={pnl:.2f}): price "
            f"{'reversed in trade direction within 1-2 bars (scared exit)' if reversed_ else 'did not reverse (valid stop)'}"
        ),
    }


# ---------------------------------------------------------------------------
# Pattern 4: Panic buying / panic entries
# ---------------------------------------------------------------------------

def detect_panic_buying(trades: list[dict], direction: str) -> dict:
    """Quick re-entries (<60s apart) or same-bar entry+exit+re-entry."""
    sorted_t = sorted(trades, key=lambda t: int(t.get("timestamp", 0)))
    entry_side = "BUY" if direction == "LONG" else "SELL"
    exit_side = "SELL" if direction == "LONG" else "BUY"

    # Same-bar reversals: bar has ≥2 entry-side + ≥1 exit-side trade
    bar_buckets: dict[int, list[str]] = {}
    for t in sorted_t:
        bt = _bar_time(int(t.get("timestamp", 0)))
        bar_buckets.setdefault(bt, []).append(t.get("side", ""))

    same_bar_reversals = sum(
        1 for sides in bar_buckets.values()
        if sides.count(entry_side) >= 2 and sides.count(exit_side) >= 1
    )

    # Quick re-entries: consecutive entry-side trades < 60s apart
    quick_entries = 0
    prev_ts: int | None = None
    for t in sorted_t:
        if t.get("side") == entry_side:
            ts = int(t.get("timestamp", 0))
            if prev_ts is not None and (ts - prev_ts) < 60:
                quick_entries += 1
            prev_ts = ts

    detected = quick_entries > 0 or same_bar_reversals > 0
    return {
        "detected": detected,
        "quick_entries": quick_entries,
        "same_bar_reversals": same_bar_reversals,
        "description": (
            f"{quick_entries} quick re-entr{'ies' if quick_entries != 1 else 'y'} (<60s), "
            f"{same_bar_reversals} same-bar entry+exit+re-entry"
        ),
    }


# ---------------------------------------------------------------------------
# Pattern 5: Buying on top / selling on bottom
# ---------------------------------------------------------------------------

def detect_buying_on_top(
    entry_bar: dict | None,
    bars_after_entry: list[dict],
    direction: str,
) -> dict:
    """Price immediately reversed against position in the bar after entry."""
    if not bars_after_entry or entry_bar is None:
        return {"detected": False, "move_pct": 0.0, "description": "Insufficient data after entry"}

    entry_close = float(entry_bar.get("close", 0))
    if entry_close == 0:
        return {"detected": False, "move_pct": 0.0, "description": "Invalid entry bar"}

    next_close = float(bars_after_entry[0].get("close", 0))
    move_pct = (next_close - entry_close) / entry_close * 100

    if direction == "LONG":
        reversal = next_close < entry_close
    else:
        reversal = next_close > entry_close

    return {
        "detected": reversal,
        "move_pct": round(abs(move_pct), 2),
        "description": (
            f"Price moved {abs(move_pct):.2f}% "
            f"{'against position immediately after entry (buying on top/selling on bottom)' if reversal else 'with position after entry'}"
        ),
    }


# ---------------------------------------------------------------------------
# Pattern 6: Trade direction
# ---------------------------------------------------------------------------

def find_trade_direction(trades: list[dict]) -> str:
    """Return 'LONG' or 'SHORT' based on the first trade's side."""
    if not trades:
        return "LONG"
    first = min(trades, key=lambda t: int(t.get("timestamp", 0)))
    return "LONG" if first.get("side", "BUY") == "BUY" else "SHORT"


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def aggregate_findings(group_findings: list[dict]) -> dict:
    """
    Roll up per-group findings into portfolio-level summary for the LLM.
    Each item in group_findings: {group_id, direction, pnl, has_ohlc, patterns: {...}}
    """
    total = len(group_findings)
    with_ohlc = sum(1 for g in group_findings if g.get("has_ohlc"))

    def _count(key: str, field: str = "detected") -> int:
        return sum(1 for g in group_findings if g.get("patterns", {}).get(key, {}).get(field))

    def _avg(key: str, field: str) -> float:
        vals = [
            g["patterns"][key][field]
            for g in group_findings
            if g.get("patterns", {}).get(key, {}).get(field) is not None
            and isinstance(g["patterns"][key][field], (int, float))
        ]
        return round(sum(vals) / len(vals), 2) if vals else 0.0

    losses = [g for g in group_findings if g.get("pnl", 0) < 0]
    wins = [g for g in group_findings if g.get("pnl", 0) > 0]

    return {
        "total_trade_groups": total,
        "groups_with_ohlc_data": with_ohlc,
        "win_count": len(wins),
        "loss_count": len(losses),
        "entry_deviation": {
            "chasing_count": _count("entry_deviation"),
            "total_checked": with_ohlc,
            "avg_deviation_pct": _avg("entry_deviation", "deviation_pct"),
            "instances": [
                {
                    "group_id": g.get("group_id"),
                    "direction": g.get("direction"),
                    "pct": g["patterns"]["entry_deviation"].get("deviation_pct", 0),
                }
                for g in group_findings
                if g.get("has_ohlc") and "entry_deviation" in g.get("patterns", {})
            ][:10],  # cap at 10 instances to keep payload manageable
        },
        "early_exits": {
            "count": _count("early_exit"),
            "total_with_exits": sum(1 for g in group_findings if g.get("has_exit")),
            "avg_missed_move_pct": _avg("early_exit", "move_pct"),
        },
        "scared_exits": {
            "count": _count("scared_exit"),
            "total_losses": len(losses),
        },
        "panic_entries": {
            "groups_detected": _count("panic_buying"),
            "total_quick_entries": sum(
                g["patterns"].get("panic_buying", {}).get("quick_entries", 0)
                for g in group_findings
            ),
            "total_same_bar_reversals": sum(
                g["patterns"].get("panic_buying", {}).get("same_bar_reversals", 0)
                for g in group_findings
            ),
        },
        "buying_on_top": {
            "count": _count("buying_on_top"),
            "total_entries": with_ohlc,
            "avg_adverse_pct": _avg("buying_on_top", "move_pct"),
        },
    }
