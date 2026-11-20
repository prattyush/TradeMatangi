"""
Day score — a 0 to 100 score of how a trading day was traded (Phase 27, S6).

The score is built from five rules, all read from the day's cycles (``performance_service``: one cycle per contract and direction, with
its entries, matches, exits and label). Penalties grow with repetition and bonuses are larger for a cleaner day, so the score is not a
straight line. Every number lives in ``CONFIG`` below, in one place, so it can be tuned after a look at real days.

  1. Drawdown against the guardrail limit: the day's total P&L (closed trades plus the open positions marked to the cached candles)
     touched 50 / 75 / 100 / 150 % of the capital-loss limit, even if it recovered. The limit is the one the session was created with
     (``guardrail_limit_snapshot`` on the Sessions row); an older session has none and uses the fixed ``LEGACY_GUARDRAIL_LIMIT_PCT``
     (marked "estimated"). Candles are read from the cache only; a contract without them makes the rule "partial" (the closed trades
     still count, so it is a lower bound).
  2. Repeat entry: a new trade on the same contract, same direction (and the same expected strategy where both are labelled), started
     within ``REPEAT_WINDOW_BARS`` bars of the previous one closing after a loss, that also loses. Each one in a chain costs more.
  3. Adding to a loser: an entry added while the position was losing, where that entry and the one it was added to both end in a loss.
  4. A clean day: the running P&L of the closed trades never went below zero (with at least ``CLEAN_DAY_TIERS`` trades).
  5. One bad trade wiping out the profit of the three or more winning trades just before it.

The result is stored per user and date (``DayScores``, created lazily) with a fingerprint of the trades and labels it was computed from,
so it is recomputed when a fill, a label or a setting of the score changes, and served from the table otherwise. Nothing here changes a
trade, an order, a label or the broker. Own intraday sessions only (like the Habits ledger); Strategy Practice runs are left out.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

TABLE = "DayScores"
CONFIG_VERSION = 1

#: The limit used for a session that was created before the limit was saved (the owner's earlier setting).
LEGACY_GUARDRAIL_LIMIT_PCT = 12.0

CONFIG = {
    "base": 60,                       # a plain day
    # (share of the limit touched, points), highest tier reached applies
    "drawdown_tiers": ((0.5, -8), (0.75, -14), (1.0, -25), (1.5, -35)),
    "repeat_window_bars": 3,          # re-entry within this many bars of the last close
    "default_bar_seconds": 180,
    "repeat_points": (6, 10, 16, 24),    # 1st, 2nd, 3rd, 4th+ repeat loss in a chain
    "add_points": (6, 10, 16, 24),       # 1st, 2nd, ... add-to-a-loser that lost on both entries
    # (closed trades, bonus): the highest tier reached applies
    "clean_day_tiers": ((3, 15), (6, 20)),
    "wipe_min_wins": 3,
    # (loss as a multiple of the wins it wiped, points): the highest tier reached applies
    "wipe_tiers": ((1.0, -10), (2.0, -16), (3.0, -22)),
}

RULES = ("drawdown", "repeat_entry", "add_to_loser", "clean_day", "big_loss_wipes_gains")
TITLES = {
    "drawdown": "Drawdown against the guardrail limit",
    "repeat_entry": "Repeat entries after a loss",
    "add_to_loser": "Adding to a loser",
    "clean_day": "Closed P&L never negative",
    "big_loss_wipes_gains": "One loss wiped out three or more wins",
}
SYSTEM_HABITS = {"repeat_entry": "sys:repeat_entry", "add_to_loser": "sys:add_to_loser", "big_loss_wipes_gains": "sys:big_loss_wipes_gains"}

#: The three system habits as Habits-ledger questions (kind ``system``): they are calculated, never marked, never archived, and are not in the
#: question manager (it reads the user's own questions only). Each is shown next to the user's own habits in the scorecard, trends and compare.
SYSTEM_QUESTIONS = (
    {"question_id": "sys:repeat_entry", "kind": "system", "status": "active", "sort_order": -3, "created_at": "", "archived_at": None, "system": True,
     "text": "Re-entered within 3 bars of a loss and lost again"},
    {"question_id": "sys:add_to_loser", "kind": "system", "status": "active", "sort_order": -2, "created_at": "", "archived_at": None, "system": True,
     "text": "Added to a losing position and both entries lost"},
    {"question_id": "sys:big_loss_wipes_gains", "kind": "system", "status": "active", "sort_order": -1, "created_at": "", "archived_at": None, "system": True,
     "text": "One loss wiped out three or more winning trades"},
)
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_RANGE_COMPUTE = 31

_ENSURED = False


# ── Table ────────────────────────────────────────────────────────────────────

def _resource():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource()


def ensure_table() -> None:
    global _ENSURED
    if _ENSURED:
        return
    try:
        from app.services.db import get_dynamodb_client
        if TABLE not in set(_resource().meta.client.list_tables()["TableNames"]):
            client = get_dynamodb_client()
            client.create_table(
                TableName=TABLE, BillingMode="PAY_PER_REQUEST",
                KeySchema=[{"AttributeName": "user_id", "KeyType": "HASH"}, {"AttributeName": "date", "KeyType": "RANGE"}],
                AttributeDefinitions=[{"AttributeName": "user_id", "AttributeType": "S"}, {"AttributeName": "date", "AttributeType": "S"}],
            )
            client.get_waiter("table_exists").wait(TableName=TABLE)
            logger.info("Created %s table", TABLE)
        _ENSURED = True
    except Exception:
        logger.exception("Failed to ensure %s table", TABLE)


def _table():
    ensure_table()
    return _resource().Table(TABLE)


def clean_date(value) -> str:
    text = str(value or "").strip()
    if not _DATE.match(text):
        raise ValueError("The date must be YYYY-MM-DD")
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        raise ValueError("The date must be a real calendar date") from None
    return text


# ── Small helpers ────────────────────────────────────────────────────────────

def _tier(value: float, tiers) -> float:
    """The points of the highest tier whose threshold ``value`` reaches, or 0."""
    points = 0
    for threshold, pts in tiers:
        if value >= threshold:
            points = pts
    return points


def _escalating(count: int, table) -> int:
    """Total points of the first ``count`` events when the nth event costs ``table[min(n, len)-1]``."""
    return sum(table[min(n, len(table)) - 1] for n in range(1, count + 1))


def _bar_seconds(cycle) -> int:
    for entry in cycle.get("entries", []):
        value = int((entry.get("analytics") or {}).get("strategy_interval_seconds") or 0)
        if value:
            return value
    return CONFIG["default_bar_seconds"]


def _contract(cycle) -> tuple:
    return (cycle.get("symbol"), cycle.get("exchange"), cycle.get("right"), cycle.get("strike"), cycle.get("expiry"), cycle.get("direction"))


def _strategy(cycle) -> str | None:
    label = cycle.get("label") or {}
    return (label.get("expected_strategy") or "").strip() or None


def closed_in_order(cycles) -> list[dict]:
    """The closed cycles in the order they closed."""
    return sorted((c for c in cycles if c.get("state") == "closed"), key=lambda c: (c.get("exit_time") or 0, c.get("entry_time") or 0, c.get("cycle_id", "")))


def _pct(amount: float, capital: float) -> float | None:
    return round(100.0 * amount / capital, 2) if capital else None


# ── Rules 2, 3, 4 and 5 (pure) ───────────────────────────────────────────────

def repeat_entry_events(cycles) -> list[dict]:
    """Repeat losses: a closed cycle that lost, entered within the window of the previous cycle on the same contract closing at a loss.

    The same expected strategy is required only when both cycles are labelled with one. ``position`` counts the repeat in its chain
    (1 = the first repeat loss after the original loss).
    """
    events: list[dict] = []
    by_contract: dict[tuple, list[dict]] = {}
    for cycle in sorted(closed_in_order(cycles), key=lambda c: (c.get("entry_time") or 0, c.get("cycle_id", ""))):
        by_contract.setdefault(_contract(cycle), []).append(cycle)
    for rows in by_contract.values():
        chain = 0
        for previous, cycle in zip(rows, rows[1:]):
            gap = (cycle["entry_time"] or 0) - (previous["exit_time"] or 0)
            window = CONFIG["repeat_window_bars"] * _bar_seconds(cycle)
            a, b = _strategy(previous), _strategy(cycle)
            quick_after_loss = previous["net_pnl"] < 0 and 0 <= gap <= window and (a is None or b is None or a == b)
            if quick_after_loss and cycle["net_pnl"] < 0:
                chain += 1
                events.append({"cycle_id": cycle["cycle_id"], "time": cycle["entry_time"], "position": chain, "previous_cycle_id": previous["cycle_id"]})
            else:
                chain = 0  # a win, a slow re-entry or another strategy ends the chain
    return sorted(events, key=lambda e: e["time"])


def add_to_loser_events(cycles) -> list[dict]:
    """An entry added while the position was losing ("adding while losing"), where that entry and the entry before it both ended in a loss."""
    events = []
    for cycle in closed_in_order(cycles):
        entries = sorted(cycle.get("entries", []), key=lambda e: e["timestamp"])
        for index, entry in enumerate(entries):
            if index == 0 or entry.get("addition_context") != "adding while losing" or entry.get("open_quantity", 0):
                continue
            if entry["net_pnl"] < 0 and entries[index - 1]["net_pnl"] < 0:
                events.append({"cycle_id": cycle["cycle_id"], "time": entry["timestamp"], "entry_id": entry["entry_id"]})
    return sorted(events, key=lambda e: e["time"])


def clean_day(cycles, capital: float) -> dict:
    """Whether the running P&L of the closed trades stayed at or above zero, and the lowest point it reached."""
    running, lowest = 0.0, 0.0
    ordered = closed_in_order(cycles)
    for cycle in ordered:
        running += cycle["net_pnl"]
        lowest = min(lowest, running)
    return {"trades": len(ordered), "clean": bool(ordered) and lowest >= 0, "lowest": round(lowest, 2), "lowest_pct": _pct(lowest, capital), "final": round(running, 2)}


def big_loss_events(cycles) -> list[dict]:
    """A losing trade that gave back at least the profit of the winning trades just before it (``wipe_min_wins`` or more in a row)."""
    events = []
    ordered = closed_in_order(cycles)
    for index, cycle in enumerate(ordered):
        if cycle["net_pnl"] >= 0:
            continue
        wins = 0.0
        count = 0
        for before in reversed(ordered[:index]):
            if before["net_pnl"] <= 0:
                break
            wins += before["net_pnl"]
            count += 1
        if count >= CONFIG["wipe_min_wins"] and wins > 0 and -cycle["net_pnl"] >= wins:
            events.append({"cycle_id": cycle["cycle_id"], "time": cycle["exit_time"], "loss": round(-cycle["net_pnl"], 2), "wins": round(wins, 2), "wins_count": count,
                           "multiple": round(-cycle["net_pnl"] / wins, 2)})
    return events


def system_flags(cycles) -> dict[str, list[str]]:
    """The system habits (``sys:*``) each cycle showed, by cycle id: the rows the Habits ledger adds to the user's own.

    A cycle with missing fields never breaks the ledger: a rule that cannot read the cycles gives no flags (it is logged).
    """
    flags: dict[str, list[str]] = {}
    for key, rule in (("repeat_entry", repeat_entry_events), ("add_to_loser", add_to_loser_events), ("big_loss_wipes_gains", big_loss_events)):
        try:
            events = rule(cycles)
        except (KeyError, TypeError, ValueError):
            logger.warning("Day score: the %s habit could not be read from these cycles", key, exc_info=True)
            continue
        for event in events:
            flags.setdefault(event["cycle_id"], [])
            if SYSTEM_HABITS[key] not in flags[event["cycle_id"]]:
                flags[event["cycle_id"]].append(SYSTEM_HABITS[key])
    return flags


# ── Rule 1: drawdown from the candles ────────────────────────────────────────

def worst_total(cycles, load_frame=None) -> dict:
    """The lowest total P&L of the day: closed trades plus every open lot marked at its worst price in each minute.

    ``load_frame(cycle)`` returns ``(frame, provider, resolution)`` of the cycle's cached candles (default: ``excursion_service``), or a
    frame of None. A long lot is marked at the bar's low and a short lot at its high (the worst it could have been in that minute);
    prices are carried forward between observed bars. Returns ``{worst, at, missing, contracts, open_cycles}``; ``missing`` counts the
    cycles that hold a position for a while but have no candles (their open drawdown is not counted, so the result is a lower bound).
    """
    import numpy as np
    if load_frame is None:
        from app.services.excursion_service import load_contract_frame as load_frame
    matches = []
    for cycle in cycles:
        for match in cycle.get("matches", []):
            matches.append({**match, "direction": cycle["direction"], "key": (cycle["symbol"], cycle["strike"], cycle["expiry"], cycle["right"], cycle["date"], cycle.get("mode"))})
    open_cycles = sum(1 for c in cycles if c.get("state") != "closed")
    if not matches:
        return {"worst": 0.0, "at": None, "missing": 0, "contracts": 0, "open_cycles": open_cycles}
    # Closed P&L alone: the lowest running total after each exit (needs no candles).
    ordered = sorted(matches, key=lambda m: m["exit_time"])
    running, worst, at = 0.0, 0.0, None
    for match in ordered:
        running += match["net_pnl"]
        if running < worst:
            worst, at = running, match["exit_time"]
    # Open lots marked to the candles.
    frames, missing = {}, 0
    for cycle in cycles:
        key = (cycle["symbol"], cycle["strike"], cycle["expiry"], cycle["right"], cycle["date"], cycle.get("mode"))
        if key in frames or not cycle.get("matches"):
            continue
        try:
            frame, _provider, _resolution = load_frame(cycle)
        except Exception:
            logger.exception("Day score: candles could not be read for %s", cycle.get("cycle_id"))
            frame = None
        if frame is None:
            frames[key] = None
            missing += 1
            continue
        observed = frame[frame["observed"].astype(bool)] if "observed" in frame else frame
        if observed.empty:
            frames[key] = None
            missing += 1
            continue
        seconds = (observed.index.astype("int64") // 1_000_000_000).to_numpy()
        minutes = seconds // 60 * 60
        import pandas as pd
        grouped = pd.DataFrame({"minute": minutes, "low": observed["low"].to_numpy(dtype=float), "high": observed["high"].to_numpy(dtype=float)}).groupby("minute").agg(low=("low", "min"), high=("high", "max"))
        frames[key] = grouped
    usable = [m for m in matches if frames.get(m["key"]) is not None]
    if usable:
        start = min(m["entry_time"] for m in usable) // 60 * 60
        end = max(m["exit_time"] for m in usable) // 60 * 60
        grid = np.arange(start, end + 60, 60)
        total = np.zeros(len(grid))
        realised = np.zeros(len(grid))
        for m in matches:  # realised: matches that closed before the minute began (all matches, with or without candles)
            realised += np.where(grid >= m["exit_time"], m["net_pnl"], 0.0)
        total += realised
        for m in usable:
            frame = frames[m["key"]].reindex(grid, method=None)
            price = (frame["low"] if m["direction"] == "LONG" else frame["high"]).ffill().to_numpy(dtype=float)
            price = np.where(np.isnan(price), m["entry_price"], price)
            sign = 1 if m["direction"] == "LONG" else -1
            open_now = (grid + 59 >= m["entry_time"]) & (grid < m["exit_time"])
            total += np.where(open_now, sign * m["quantity"] * (price - m["entry_price"]), 0.0)
        low = int(np.argmin(total))
        if total[low] < worst:
            worst, at = float(total[low]), int(grid[low])
    return {"worst": round(worst, 2), "at": at, "missing": missing, "contracts": len(frames), "open_cycles": open_cycles}


# ── The score ────────────────────────────────────────────────────────────────

def score_day(cycles, *, capital: float, limit_pct: float, limit_source: str, load_frame=None) -> dict:
    """Scores one day from its cycles. ``cycles`` all belong to the same date. Pure apart from reading cached candles."""
    closed = closed_in_order(cycles)
    items = []
    # Rule 1
    drawdown = worst_total(cycles, load_frame)
    dd_pct = round(max(0.0, -drawdown["worst"]) / capital * 100, 2) if capital else 0.0
    ratio = round(dd_pct / limit_pct, 3) if limit_pct else 0.0
    partial = drawdown["missing"] > 0 or drawdown["open_cycles"] > 0
    items.append({"key": "drawdown", "title": TITLES["drawdown"], "points": _tier(ratio, CONFIG["drawdown_tiers"]),
                  "detail": f"The day's total P&L reached -{dd_pct}% of capital, {round(ratio * 100)}% of the {limit_pct:g}% limit"
                            + (" (the limit is estimated: the session did not save one)" if limit_source == "estimated" else "")
                            + (" (candles missing for some contracts: the real drawdown may be larger)" if partial else ""),
                  "count": None})
    # Rule 2
    repeats = repeat_entry_events(cycles)
    items.append({"key": "repeat_entry", "title": TITLES["repeat_entry"], "points": -_escalating(len(repeats), CONFIG["repeat_points"]) if repeats else 0,
                  "detail": f"{len(repeats)} repeat {'entry' if len(repeats) == 1 else 'entries'} within {CONFIG['repeat_window_bars']} bars of a loss, losing again" if repeats else "None", "count": len(repeats)})
    # Rule 3
    adds = add_to_loser_events(cycles)
    items.append({"key": "add_to_loser", "title": TITLES["add_to_loser"], "points": -_escalating(len(adds), CONFIG["add_points"]) if adds else 0,
                  "detail": f"{len(adds)} add{'s' if len(adds) != 1 else ''} to a losing position where both entries lost" if adds else "None", "count": len(adds)})
    # Rule 4
    clean = clean_day(cycles, capital)
    bonus = _tier(clean["trades"], CONFIG["clean_day_tiers"]) if clean["clean"] else 0
    if not clean["trades"]:
        clean_detail = "No closed trades"
    elif not clean["clean"]:
        clean_detail = "The running closed P&L went negative" + (f" (lowest {clean['lowest_pct']}% of capital)" if clean["lowest_pct"] is not None else "")
    elif bonus:
        clean_detail = f"The running closed P&L never went below zero over {clean['trades']} trades"
    else:
        clean_detail = f"Never negative, but only {clean['trades']} closed {'trade' if clean['trades'] == 1 else 'trades'}: too few to count"
    items.append({"key": "clean_day", "title": TITLES["clean_day"], "points": bonus, "detail": clean_detail, "count": None})
    # Rule 5
    wipes = big_loss_events(cycles)
    wipe_points = sum(_tier(e["multiple"], CONFIG["wipe_tiers"]) for e in wipes)
    items.append({"key": "big_loss_wipes_gains", "title": TITLES["big_loss_wipes_gains"], "points": wipe_points,
                  "detail": f"{len(wipes)} loss{'es' if len(wipes) != 1 else ''} gave back {CONFIG['wipe_min_wins']} or more wins in a row" if wipes else "None", "count": len(wipes)})
    score = max(0, min(100, int(round(CONFIG["base"] + sum(i["points"] for i in items)))))
    return {
        "score": score, "base": CONFIG["base"], "items": items,
        "limit_pct": limit_pct, "limit_source": limit_source,
        "drawdown": {"worst": drawdown["worst"], "worst_pct": dd_pct, "limit_ratio": ratio, "at": drawdown["at"], "missing_contracts": drawdown["missing"], "open_cycles": drawdown["open_cycles"], "partial": partial},
        "events": {"repeat_entry": repeats, "add_to_loser": adds, "big_loss_wipes_gains": wipes},
        "capital": capital, "closed": len(closed),
    }


# ── Loading a day ────────────────────────────────────────────────────────────

def _day_sessions(user_id: str, date: str) -> list[dict]:
    """The user's own intraday sessions of a market date (no swing, no practice, one per broker projection)."""
    from boto3.dynamodb.conditions import Key
    from app.services.performance_service import query_all
    rows = query_all(_resource().Table("Sessions"), IndexName="UserIdIndex", KeyConditionExpression=Key("user_id").eq(user_id))
    owners, kept = set(), []
    for session in rows:
        if (session.get("user_id") != user_id or session.get("date") != date or session.get("trading_style") == "swing" or session.get("record_type") == "swing_portfolio"
                or ":archive:" in session["session_id"] or session.get("practice")
                or session.get("broker_projection_owner", session["session_id"]) != session["session_id"]):
            continue
        owner = session.get("broker_projection_id") or session["session_id"]
        if owner in owners:
            continue
        owners.add(owner)
        kept.append(session)
    return sorted(kept, key=lambda s: (s.get("created_at") or 0, s["session_id"]))


def session_limit(session: dict) -> tuple[float, str]:
    """The capital-loss limit (percent) a session is scored against, and where it came from: ``saved`` or ``estimated``."""
    saved = session.get("guardrail_limit_snapshot")
    if isinstance(saved, dict) and saved.get("ban_capital_pct") is not None:
        value = float(saved["ban_capital_pct"])
        if value > 0:
            return value, "saved"
    return LEGACY_GUARDRAIL_LIMIT_PCT, "estimated"


def _fingerprint(date: str, sessions: list[dict], cycles: list[dict]) -> str:
    parts = [CONFIG_VERSION, json.dumps(CONFIG, sort_keys=True, default=str), date, LEGACY_GUARDRAIL_LIMIT_PCT]
    parts += [(s["session_id"], str(session_limit(s))) for s in sessions]
    for c in sorted(cycles, key=lambda c: c["cycle_id"]):
        label = c.get("label") or {}
        parts.append((c["cycle_id"], c.get("state"), round(float(c.get("net_pnl", 0)), 4), c.get("entry_time"), c.get("exit_time"), len(c.get("entries", [])),
                      label.get("expected_strategy"), bool(label)))
    return hashlib.sha256(repr(parts).encode()).hexdigest()[:32]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def compute_day(user_id: str, date: str, *, load_frame=None) -> dict:
    """Scores a market date from scratch (no cache): ``status`` is ``no_trades``, ``pending_labels`` (some closed trade has no label yet) or ``scored``."""
    from app.services import performance_service
    day = clean_date(date)
    sessions = _day_sessions(user_id, day)
    cycles: list[dict] = []
    for session in sessions:
        cycles.extend(performance_service.load_session_cycles(session))
    closed = closed_in_order(cycles)
    base = {"date": day, "sessions": len(sessions), "closed": len(closed), "labelled": sum(1 for c in closed if c.get("label")), "config_version": CONFIG_VERSION}
    fingerprint = _fingerprint(day, sessions, cycles)
    if not closed:
        return {**base, "status": "no_trades", "score": None, "fingerprint": fingerprint}
    if base["labelled"] < len(closed):
        return {**base, "status": "pending_labels", "score": None, "fingerprint": fingerprint}
    limits = [session_limit(s) for s in sessions]
    limit_pct = min(pct for pct, _ in limits)
    source = "saved" if all(src == "saved" for _, src in limits) else "estimated"
    capital = max([float(s.get("session_capital") or 0) for s in sessions] + [float(c.get("starting_capital") or 0) for c in cycles])
    return {**base, "status": "scored", "fingerprint": fingerprint,
            **score_day(cycles, capital=capital, limit_pct=limit_pct, limit_source=source, load_frame=load_frame)}


def day_cycles_flags(user_id: str, date: str) -> dict[str, list[str]]:
    """System-habit flags (``sys:*``) by cycle id for a date: used by the Habits ledger."""
    from app.services import performance_service
    cycles: list[dict] = []
    for session in _day_sessions(user_id, clean_date(date)):
        cycles.extend(performance_service.load_session_cycles(session))
    return system_flags(cycles)


# ── Stored scores ────────────────────────────────────────────────────────────

def _stored(user_id: str, date: str) -> dict | None:
    row = _table().get_item(Key={"user_id": user_id, "date": date}).get("Item")
    if not row:
        return None
    try:
        return {**json.loads(row["payload"]), "computed_at": row.get("computed_at")}
    except (KeyError, ValueError):
        return None


def get_day_score(user_id: str, date: str, *, load_frame=None) -> dict:
    """The score of a market date: the stored one when the trades, labels and score settings have not changed since, else recomputed and stored.

    A day that cannot be scored yet (no trades, or labels still missing) is returned, not stored.
    """
    day = clean_date(date)
    from app.services import performance_service
    sessions = _day_sessions(user_id, day)
    cycles = [c for s in sessions for c in performance_service.load_session_cycles(s)]
    fingerprint = _fingerprint(day, sessions, cycles)
    stored = _stored(user_id, day)
    if stored and stored.get("fingerprint") == fingerprint:
        return stored
    result = compute_day(user_id, day, load_frame=load_frame)
    result["computed_at"] = _now()
    if result["status"] == "scored":
        _table().put_item(Item={"user_id": user_id, "date": day, "payload": json.dumps(result, default=str), "score": int(result["score"]), "computed_at": result["computed_at"]})
    elif stored:
        _table().delete_item(Key={"user_id": user_id, "date": day})  # the day is no longer scorable (a label was removed): drop the old score
    return result


def list_scores(user_id: str, start: str | None = None, end: str | None = None) -> list[dict]:
    """The stored scores in a date range, oldest first, as ``{date, score, limit_source, partial, computed_at}`` (no recompute)."""
    from boto3.dynamodb.conditions import Key
    from app.services.performance_service import query_all
    lo, hi = (clean_date(start) if start else "0000-00-00"), (clean_date(end) if end else "9999-99-99")
    rows = query_all(_table(), KeyConditionExpression=Key("user_id").eq(user_id) & Key("date").between(lo, hi))
    out = []
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except (KeyError, ValueError):
            continue
        out.append({"date": row["date"], "score": int(row["score"]), "limit_source": payload.get("limit_source"), "partial": bool(payload.get("drawdown", {}).get("partial")),
                    "computed_at": row.get("computed_at")})
    return sorted(out, key=lambda r: r["date"])


def session_dates(user_id: str, start: str | None = None, end: str | None = None) -> list[str]:
    """The market dates on which the user has an intraday session (no swing, no practice) in a range, oldest first."""
    from boto3.dynamodb.conditions import Key
    from app.services.performance_service import query_all
    lo, hi = (clean_date(start) if start else "0000-00-00"), (clean_date(end) if end else "9999-99-99")
    rows = query_all(_resource().Table("Sessions"), IndexName="UserIdIndex", KeyConditionExpression=Key("user_id").eq(user_id))
    dates = {r["date"] for r in rows if r.get("date") and lo <= r["date"] <= hi and r.get("trading_style") != "swing" and r.get("record_type") != "swing_portfolio"
             and ":archive:" not in r["session_id"] and not r.get("practice") and r.get("user_id") == user_id}
    return sorted(dates)


def scores_in_range(user_id: str, start: str | None = None, end: str | None = None, *, compute: bool = False, load_frame=None) -> dict:
    """Scores over a date range for the Stats trend: the stored ones, and with ``compute`` also the days that have none yet.

    At most ``MAX_RANGE_COMPUTE`` of the newest days are computed in one call (each reads candles); ``pending`` counts the days
    that are left, so the caller can ask again.
    """
    stored = {row["date"]: row for row in list_scores(user_id, start, end)}
    pending = 0
    if compute:
        missing = [d for d in session_dates(user_id, start, end) if d not in stored]
        todo, pending = missing[-MAX_RANGE_COMPUTE:], max(0, len(missing) - MAX_RANGE_COMPUTE)
        for date in todo:
            result = get_day_score(user_id, date, load_frame=load_frame)
            if result["status"] == "scored":
                stored[date] = {"date": date, "score": int(result["score"]), "limit_source": result.get("limit_source"), "partial": bool(result["drawdown"]["partial"]), "computed_at": result.get("computed_at")}
    return {"scores": [stored[d] for d in sorted(stored)], "pending": pending}
