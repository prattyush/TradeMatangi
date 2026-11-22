"""
Day summary — one card per market date for the Analysis Summary (Phase 27, S10).

Read only. It reads the same cycles the Stats screen reads (``performance_service.load_cycles``, so the same filters mean the same
thing), keeps the user's own intraday cycles (no swing, no Strategy Practice, nothing shared) and, per market date, returns what a
day card needs without any candle read:

  * ``symbols``    the symbols traded (with the modes and the session ids, so the client can fetch the trades and charts when a card opens)
  * ``totals``     closed trades, wins and losses, win %, net P&L (rupees and the sum of the trades' % of their capital), fees
  * ``strategies`` the closed trades grouped by their expected strategy: trades, win %, net P&L, P&L % of capital, mean % per trade
  * ``labels``     how many closed trades are labelled, and how many followed the plan (expected equals actual strategy)
  * ``best`` / ``worst``  the trade with the largest win and the largest loss (by P&L %), only when there is a win or a loss
  * ``journeys``   the Day P&L Journey, one per mode (``day_journey.journeys``)
  * ``score``      the stored day score (no recompute here; ``null`` when the day has none yet)
  * ``note``       the day's note, only when something is written

Nothing here changes a trade, an order, a label or the broker.
"""
from __future__ import annotations

from collections import defaultdict

MAX_DAYS = 62
UNLABELLED = "Unlabelled"
NO_STRATEGY = "No strategy named"
_NOTE_FIELDS = ("went_well", "to_improve", "specific_points", "context")


def _number(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _strategy(cycle) -> str:
    label = cycle.get("label")
    if not label:
        return UNLABELLED
    return (label.get("expected_strategy") or "").strip() or NO_STRATEGY


def _rank(cycle) -> float:
    """What best and worst are ordered by: the trade's % of its capital (the rupee amount only when it has none)."""
    pct = cycle.get("pnl_pct")
    return float(pct) if pct is not None else _number(cycle.get("net_pnl"))


def _pct_sum(cycles) -> float | None:
    values = [c["pnl_pct"] for c in cycles if c.get("pnl_pct") is not None]
    return sum(values) if values else None


def _trade(cycle) -> dict:
    label = cycle.get("label") or {}
    return {
        "cycle_id": cycle["cycle_id"], "session_id": cycle["session_id"], "mode": cycle.get("mode"), "symbol": cycle.get("symbol"),
        "right": cycle.get("right"), "strike": cycle.get("strike"), "direction": cycle.get("direction"),
        "entry_time": cycle.get("entry_time"), "exit_time": cycle.get("exit_time"),
        "net_pnl": _number(cycle.get("net_pnl")), "pnl_pct": cycle.get("pnl_pct"),
        "strategy": _strategy(cycle) if label else None,
    }


def _stats(cycles) -> dict:
    from app.services.performance_service import outcome_stats
    stats = outcome_stats(cycles)
    return {"trades": stats["count"], "wins": stats["wins"], "losses": stats["losses"], "win_pct": stats["win_pct"],
            "net_pnl": stats["net_pnl"], "pnl_pct": _pct_sum(cycles), "mean_pnl_pct": stats["mean_pnl_pct"], "fees": stats["fees"]}


def _strategies(closed) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for cycle in closed:
        groups[_strategy(cycle)].append(cycle)
    rows = [{"strategy": name, **_stats(items)} for name, items in groups.items()]
    special = {UNLABELLED: 1, NO_STRATEGY: 0}
    # the named strategies first (largest net P&L first), then the trades without a strategy name, then the unlabelled ones
    return sorted(rows, key=lambda r: (r["strategy"] in special, special.get(r["strategy"], 0), -r["net_pnl"], r["strategy"]))


def _labels(closed) -> dict:
    labelled = [c for c in closed if c.get("label")]
    followed = unfollowed = 0
    for cycle in labelled:
        label = cycle["label"]
        expected, actual = (label.get("expected_strategy") or "").strip(), (label.get("actual_strategy") or "").strip()
        if expected and actual:
            followed += expected == actual
            unfollowed += expected != actual
    return {"closed": len(closed), "labelled": len(labelled), "plan_followed": followed, "plan_not_followed": unfollowed,
            "plan_unknown": len(labelled) - followed - unfollowed}


def _symbols(cycles) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for cycle in cycles:
        groups[cycle.get("symbol") or ""].append(cycle)
    rows = []
    for symbol, items in groups.items():
        closed = [c for c in items if c.get("state") == "closed"]
        rows.append({"symbol": symbol, "instrument_type": items[0].get("instrument_type"), "trades": len(closed),
                     "net_pnl": sum(_number(c.get("net_pnl")) for c in closed),
                     "modes": sorted({c.get("mode") or "sim" for c in items}), "session_ids": sorted({c["session_id"] for c in items})})
    return sorted(rows, key=lambda r: (-r["trades"], r["symbol"]))


def _journey(row) -> dict:
    """A Day P&L Journey as the chart draws it, without the entry-sizing block (the Stats screen's)."""
    return {key: value for key, value in row.items() if key not in ("sizing", "sizing_ratio")}


def _note(row) -> dict | None:
    if not row or not any((row.get(field) or "").strip() for field in _NOTE_FIELDS):
        return None
    return {"date": row.get("date"), **{field: row.get(field) or "" for field in _NOTE_FIELDS}, "updated_at": row.get("updated_at")}


def build_days(cycles, scores: dict | None = None, notes: dict | None = None, *, max_days: int = MAX_DAYS) -> dict:
    """The cards for the dates of ``cycles``, newest first, at most ``max_days`` of them (``truncated`` says older ones were left out).

    ``scores`` and ``notes`` are the stored day scores and notes by date (``None`` is the same as nothing stored).
    """
    from app.services.day_journey import journeys
    by_date: dict[str, list[dict]] = defaultdict(list)
    for cycle in cycles:
        if cycle.get("date"):
            by_date[cycle["date"]].append(cycle)
    dates = sorted(by_date, reverse=True)
    kept = dates[:max_days]
    paths: dict[str, list[dict]] = defaultdict(list)
    for path in journeys([c for d in kept for c in by_date[d]]):
        paths[path["date"]].append(_journey(path))
    days = []
    for date in kept:
        items = by_date[date]
        closed = sorted((c for c in items if c.get("state") == "closed"), key=lambda c: (c.get("exit_time") or 0, c["cycle_id"]))
        stored = (scores or {}).get(date)
        ranked = sorted(closed, key=lambda c: (_rank(c), c["cycle_id"]))
        best = ranked[-1] if ranked and _number(ranked[-1].get("net_pnl")) > 0 else None
        worst = ranked[0] if ranked and _number(ranked[0].get("net_pnl")) < 0 else None
        days.append({
            "date": date, "symbols": _symbols(items), "open_trades": sum(c.get("state") != "closed" for c in items),
            "totals": _stats(closed), "strategies": _strategies(closed), "labels": _labels(closed),
            "best": _trade(best) if best else None, "worst": _trade(worst) if worst else None,
            "journeys": sorted(paths.get(date, []), key=lambda p: (p.get("mode") or "", p.get("id") or "")),
            "score": ({"score": stored["score"], "limit_source": stored.get("limit_source"), "partial": bool(stored.get("partial"))}
                      if stored else None),
            "note": _note((notes or {}).get(date)),
        })
    return {"days": days, "total_days": len(dates), "truncated": len(dates) > len(kept)}


def day_summary(user_id: str, criteria: dict) -> dict:
    """The Summary for the Stats filters in ``criteria``: own intraday sessions only, Strategy Practice left out."""
    from app.services import day_notes_service, day_score_service, performance_service
    cycles = performance_service.load_cycles(user_id, **{**criteria, "trading_style": "intraday", "include_shared": False, "include_practice": False})
    cycles = [c for c in cycles if not c.get("shared") and c.get("user_id") == user_id]
    result = build_days(cycles)
    if not result["days"]:
        return result
    first, last = result["days"][-1]["date"], result["days"][0]["date"]
    scores = {row["date"]: row for row in day_score_service.list_scores(user_id, first, last)}
    notes = day_notes_service.notes_between(user_id, first, last)
    # the scores and notes are looked up for the kept range only, so build again with them (the cards are cheap to build)
    return build_days(cycles, scores, notes)
