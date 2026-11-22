"""
Strategy Practice (Phase 26, S13 onwards): practise a strategy by replaying the days marked in its Deep Dive.

A practice run is an ordinary replay (``sim``) session plus a ``practice`` marker on its ``Sessions`` record. The marker holds
the strategy, the day and a snapshot of what the user recorded for that day (side, chart marks, grade), so the review still
works if the Deep Dive day is edited or deleted later. The snapshot is server-side only: responses show the strategy and
never the side or the marks while the user practises.
"""
from __future__ import annotations

import json
import logging
import random
import time
from typing import Callable, Optional

logger = logging.getLogger(__name__)

GRADES = ("ideal", "average", "poor", "ungraded", "failed", "open")  # what a marked day can be filtered on
START_OFFSET_MIN, START_OFFSET_MAX = 5, 25  # minutes before the first recorded Entry the replay starts (whole minutes)
REPLAY_OPENS_SECONDS = 9 * 3600 + 15 * 60  # 09:15:00, the earliest a practice replay may start
REPLAY_CLOSES_SECONDS = 15 * 3600  # a replay starts before 15:00:00
STALE_RUN_HOURS = 12  # a run still 'running' after this long was left by a crash: it can be reviewed
NEGATIVE_SHARE = 0.25  # about one pick in four is a day the strategy was absent, when the user asks for them


def _seconds_of_day(clock: str) -> int:
    hours, minutes, *rest = (int(part) for part in clock.split(":"))
    return hours * 3600 + minutes * 60 + (rest[0] if rest else 0)


def recorded_day(user_id: str, category: str, strategy: str, symbol: str, date: str) -> list[dict]:
    """The user's own Deep Dive setups of one strategy on one day and symbol that have an Entry mark, Buy before Sell."""
    from app.services import deep_dive_service as dd

    key = dd.dive_key(category, strategy)
    return [s for s in dd._setup_rows(user_id, key)
            if s["date"] == date and s["symbol"] == symbol and s["timings"]["entry"] is not None]


def first_entry_seconds(setups: list[dict]) -> Optional[int]:
    """Seconds after midnight of the earliest Entry mark of the day (the start of its candle), or None."""
    times = [s["timings"]["entry"]["time"] % 86400 for s in setups if s["timings"]["entry"]]
    return min(times) if times else None


def negative_days_of(setups: list[dict]) -> dict[str, list[str]]:
    """Days the strategy was **absent**, per symbol, from the user's Deep Dive setups of one strategy.

    A symbol's reviewed range runs from its oldest marked day to its newest; a trading day inside it that carries no setup of
    that strategy and symbol is taken as reviewed and not marked, so the setup was not there. Days outside the range were
    never necessarily looked at, so they are not offered. A day marked without an Entry is a marked day, not an absent one.
    """
    from datetime import date as calendar_date, timedelta
    from app.utils import is_trading_day

    marked: dict[str, set[str]] = {}
    for setup in setups:
        marked.setdefault(setup["symbol"], set()).add(setup["date"])
    result: dict[str, list[str]] = {}
    for symbol, dates in marked.items():
        first, last = calendar_date.fromisoformat(min(dates)), calendar_date.fromisoformat(max(dates))
        days = [d.isoformat() for d in (first + timedelta(days=n) for n in range(1, (last - first).days)) if is_trading_day(d) and d.isoformat() not in dates]
        if days:
            result[symbol] = days
    return result


def negative_days(user_id: str, category: str, strategy: str) -> dict[str, list[str]]:
    from app.services import deep_dive_service as dd
    return negative_days_of(dd._setup_rows(user_id, dd.dive_key(category, strategy)))


def snap_start(start_time: str, interval_secs: int) -> str:
    """A Stepwise practice start snapped down to a bar boundary (never before 09:15:00), as ``HH:MM:SS``.

    Stepwise advances by whole bars, but plays from the start to the end of the bar that contains it: a start inside a bar gives a short
    first bar (and a chart candle that loses its real open). Snapping down keeps the start before the first Entry and makes the first
    bar a full one. 09:15 is a boundary for 180 and 300 second bars but not for 120 (its bar starts at 09:14), hence the floor at the open.
    """
    seconds = _seconds_of_day(start_time)
    snapped = max(REPLAY_OPENS_SECONDS, seconds - seconds % interval_secs) if interval_secs > 0 else seconds
    return f"{snapped // 3600:02d}:{snapped % 3600 // 60:02d}:{snapped % 60:02d}"


def build_marker(user_id: str, practice: dict, symbol: str, date: str, start_time: str) -> dict:
    """The marker stored on a practice session; ``ValueError`` (shown to the user) when the day cannot be practised.

    ``practice`` is ``{category, strategy, start_offset_min}``; the symbol and date are those of the session request. The day
    must be one of the user's own Deep Dive days with an Entry mark, and the replay must start before that Entry. The stored
    ``start_offset_min`` is worked out here from the start actually used (a Stepwise start is snapped), not taken from the client.
    """
    category, strategy = practice["category"].strip(), practice["strategy"].strip()
    setups = recorded_day(user_id, category, strategy, symbol, date)
    try:
        start_at = _seconds_of_day(start_time)
    except ValueError:
        raise ValueError("The start time is not a time of day")
    if not setups:
        if date not in negative_days(user_id, category, strategy).get(symbol, []):
            raise ValueError("That day has no Entry mark in your deep dive, so it cannot be practised")
        if not REPLAY_OPENS_SECONDS <= start_at < REPLAY_CLOSES_SECONDS:
            raise ValueError("The replay must start during market hours")
        # A day the strategy was absent: a negative test. Nothing was recorded, and the best trade is none.
        return {"category": category, "strategy": strategy, "symbol": symbol, "date": date, "start_time": start_time,
                "start_offset_min": int(practice.get("start_offset_min") or 0), "negative": True, "recorded": []}
    entry_at = first_entry_seconds(setups)
    if start_at >= entry_at:
        raise ValueError("The replay must start before the first recorded entry")
    return {
        "category": category, "strategy": strategy, "symbol": symbol, "date": date,
        "start_time": start_time, "start_offset_min": (entry_at - start_at) // 60,
        "recorded": [{
            "side": s["side"], "interval_minutes": s["interval_minutes"], "strike_ce": s["strike_ce"], "strike_pe": s["strike_pe"],
            "strike_mode": s["strike_mode"], "outcome": s["outcome"], "strength": s["strength"],
            "annotations": s["annotations"],
        } for s in setups],
    }


# ── Choosing a day ───────────────────────────────────────────────────────────

def grade_of(setup: dict) -> str:
    """The token a marked day is filtered on: ideal / average / poor, ungraded (an older success), failed, or open (no outcome)."""
    if setup["outcome"] == "failed":
        return "failed"
    if setup["outcome"] == "success":
        return setup.get("strength") or "ungraded"
    return "open"


def _entry_days(user_id: str, category: str, strategy: str) -> dict[tuple[str, str], list[dict]]:
    """The user's own Entry-marked setups of one strategy grouped by (date, symbol), oldest day first."""
    from app.services import deep_dive_service as dd

    days: dict[tuple[str, str], list[dict]] = {}
    for setup in dd._setup_rows(user_id, dd.dive_key(category, strategy)):
        if setup["timings"]["entry"] is not None:
            days.setdefault((setup["date"], setup["symbol"]), []).append(setup)
    return days


def list_strategies(user_id: str) -> list[dict]:
    """Every strategy of the user's Deep Dive with at least one Entry-marked day, for the Start screen."""
    from app.services import deep_dive_service as dd

    result = []
    for key, entry in dd._owner_dives(user_id).items():
        category, strategy = key.split("::", 1)
        days: dict[tuple[str, str], list[dict]] = {}
        for setup in entry["setups"]:
            if setup["timings"]["entry"] is not None:
                days.setdefault((setup["date"], setup["symbol"]), []).append(setup)
        if not days:
            continue
        symbols: dict[str, int] = {}
        grades = {grade: 0 for grade in GRADES}
        for (_, symbol), setups in days.items():
            symbols[symbol] = symbols.get(symbol, 0) + 1
            for grade in {grade_of(s) for s in setups}:
                grades[grade] += 1
        absent = negative_days_of(entry["setups"])
        result.append({"category": category, "strategy": strategy, "days": len(days), "grades": grades,
                       "symbols": [{"symbol": sym, "days": n} for sym, n in sorted(symbols.items())],
                       "negative_days": [{"symbol": sym, "days": len(found)} for sym, found in sorted(absent.items())]})
    return sorted(result, key=lambda r: (r["category"].casefold(), r["strategy"].casefold()))


def _practised(user_id: str, category: str, strategy: str) -> set[tuple[str, str]]:
    return {(m["date"], m["symbol"]) for _, m in _practice_sessions(user_id) if (m["category"], m["strategy"]) == (category, strategy)}


def start_offset_minutes(entry_at: int, rng: random.Random) -> int:
    """How many whole minutes before the first Entry candle (``entry_at``, seconds after midnight) the replay starts.

    A random 5 to 25, but never back past the open: an entry at 09:24 has only 9 minutes before 09:15, so the pick is 5 to 9
    (a start of 09:15 to 09:19), not a 25 that would land at 08:59 and, clamped, always start at 09:15 and give the entry away.
    An entry less than 5 minutes after the open starts at 09:15. The caller has excluded entries at or before the open.
    """
    room = (entry_at - REPLAY_OPENS_SECONDS) // 60
    return rng.randint(START_OFFSET_MIN, min(START_OFFSET_MAX, room)) if room >= START_OFFSET_MIN else room


def pick(user_id: str, category: str, strategy: str, symbol: Optional[str] = None, grades: Optional[list[str]] = None,
         rng: Optional[random.Random] = None, include_negatives: bool = False,
         exclude: Optional[set[tuple[str, str]]] = None) -> dict:
    """Choose a day and a replay start for a practice run.

    Only the user's own Entry-marked days that match the filters, and whose first Entry is after 09:15 (so there is a start
    before it). A day already practised is not repeated until every candidate was. The replay starts a random whole number of
    minutes (5 to 25) before the first Entry, never before 09:15. Nothing is stored. The answer carries no side and no marks.

    With ``include_negatives`` about one pick in four is a day the strategy was **absent** (see ``negative_days_of``), also not
    repeated until all were used. It starts at the time of a random recorded entry of the strategy, so a negative day cannot be
    told from the plan; the server recognises it again at the session start.
    """
    from app.services import options_service

    rng = rng or random.Random()
    wanted = {g for g in (grades or []) if g in GRADES}
    skipped = exclude or set()  # days the screen could not start (their data could not be loaded): not offered again
    candidates = {}
    for (date, sym), setups in _entry_days(user_id, category, strategy).items():
        if (symbol and sym != symbol) or (date, sym) in skipped:
            continue
        if wanted and not any(grade_of(s) in wanted for s in setups):
            continue
        entry_at = first_entry_seconds(setups)
        if entry_at is None or entry_at <= REPLAY_OPENS_SECONDS:
            continue  # nothing to start before
        candidates[(date, sym)] = (setups, entry_at)
    from app.services import deep_dive_service as dd

    used = _practised(user_id, category, strategy)
    absent = {}
    if include_negatives:
        absent = {(day, sym): None for sym, days in negative_days(user_id, category, strategy).items() if not symbol or sym == symbol
                  for day in days if (day, sym) not in used and (day, sym) not in skipped}
    if not candidates and not absent:
        raise ValueError("No day of this strategy with an Entry mark matches your choice")
    fresh = [k for k in candidates if k not in used]
    negative = bool(absent) and (not candidates or rng.random() < NEGATIVE_SHARE)
    if negative:
        date, sym = rng.choice(sorted(absent))
        marked = dd._setup_rows(user_id, dd.dive_key(category, strategy))
        entries = [e for e in (first_entry_seconds(g) for g in _entry_days(user_id, category, strategy).values()) if e]
        entry_at = rng.choice(entries) if entries else 10 * 3600  # when a recorded entry came, so the start looks like any other
        mine = [m for m in marked if m["symbol"] == sym] or marked
        # Nothing was recorded on this day: no strikes (they are picked at the start), the interval of the strategy's own days.
        setups = [{"interval_minutes": mine[0]["interval_minutes"], "strike_ce": None, "strike_pe": None}]
    else:
        pool = sorted(fresh or candidates)
        date, sym = rng.choice(pool)
        setups, entry_at = candidates[(date, sym)]
    offset = start_offset_minutes(entry_at, rng)
    start_at = entry_at - offset * 60
    strike_ce = next((s["strike_ce"] for s in setups if s["strike_ce"]), None)
    strike_pe = next((s["strike_pe"] for s in setups if s["strike_pe"]), None)
    optionable = sym in options_service.STRIKE_INTERVALS
    return {
        "symbol": sym, "date": date, "start_time": f"{start_at // 3600:02d}:{start_at % 3600 // 60:02d}:{start_at % 60:02d}",
        "interval_minutes": setups[0]["interval_minutes"], "instrument_type": "options" if optionable else "equity",
        "strike_ce": strike_ce, "strike_pe": strike_pe,
        "expiry": options_service.get_expiry_date(sym, date) if optionable else None,
        "practice": {"category": category, "strategy": strategy, "start_offset_min": offset},
        "days_available": len(candidates) + len(absent), "repeated": not negative and not fresh,
    }


# ── Practised runs ───────────────────────────────────────────────────────────

def _sessions_table():
    from app.services.db import get_dynamodb_resource
    return get_dynamodb_resource().Table("Sessions")


def _practice_sessions(user_id: str) -> list[tuple[dict, dict]]:
    """The user's practice runs as (Sessions item, marker), newest first."""
    from boto3.dynamodb.conditions import Key
    from app.services import simulation as sim_svc
    from app.services.performance_service import query_all

    rows = query_all(_sessions_table(), IndexName="UserIdIndex", KeyConditionExpression=Key("user_id").eq(user_id))
    runs = [(row, marker) for row in rows if (marker := sim_svc.load_practice(row))]
    return sorted(runs, key=lambda pair: int(pair[0].get("created_at") or 0), reverse=True)


def run_finished(row: dict) -> bool:
    """A run is finished when it ended, or when it was started so long ago that it cannot still be going (left 'running' by a crash).

    Only a plausible epoch-millisecond ``created_at`` counts, so a record without one is never taken for stale.
    """
    if row.get("state") == "ended":
        return True
    created = int(row.get("created_at") or 0)
    return created > 10**12 and time.time() * 1000 - created > STALE_RUN_HOURS * 3600 * 1000


def list_runs(user_id: str) -> list[dict]:
    """The user's practice runs for the History list. The recorded answer (a result) appears only once a run has ended."""
    runs = []
    for row, marker in _practice_sessions(user_id):
        ended = run_finished(row)
        result = None
        if ended and row.get("practice_result"):
            try:
                result = json.loads(row["practice_result"])
            except (TypeError, ValueError):
                result = None
        runs.append({"session_id": row["session_id"], "category": marker["category"], "strategy": marker["strategy"],
                     "symbol": marker["symbol"], "date": marker["date"], "start_time": marker["start_time"],
                     "start_offset_min": marker["start_offset_min"], "state": row.get("state"), "ended": ended,
                     "session_type": row.get("session_type") or "sim",
                     "created_at": row.get("created_at"), "result": result})
    return runs


# ── The review ───────────────────────────────────────────────────────────────

BarsLoader = Callable[..., dict]


def load_bars(symbol: str, date: str, interval_minutes: int, strike=None, expiry: Optional[str] = None,
              right: Optional[str] = None) -> dict[int, dict]:
    """Candles of the day keyed by their start time (the chart's own time), on the setup's interval."""
    from app.services import minute_ohlc

    records = minute_ohlc.candle_records(symbol, date, interval_minutes, 0, strike=strike, expiry=expiry, right=right)
    return {int(r["time"]): r for r in records}


def _best_pair(marks: list[dict], bars: dict[int, dict], sign: int) -> Optional[dict]:
    """The most profitable Entry / Exit pair of the marks: entry at the open of its bar, exit at the close of its bar."""
    best = None
    for e in (m for m in marks if m["type"] == "entry"):
        for x in (m for m in marks if m["type"] == "exit"):
            if x["time"] < e["time"] or e["time"] not in bars or x["time"] not in bars:
                continue
            entry_price, exit_price = float(bars[e["time"]]["open"]), float(bars[x["time"]]["close"])
            points = round((exit_price - entry_price) * sign, 2)
            if best is None or points > best["points"]:
                best = {"entry": {"time": e["time"], "clock": e["clock"], "price": round(entry_price, 2)},
                        "exit": {"time": x["time"], "clock": x["clock"], "price": round(exit_price, 2)},
                        "points": points, "pct": round(points / entry_price * 100, 2) if entry_price else None}
    return best


def _theoretical(setup: dict, instrument: dict, symbol: str, date: str, marks: list[dict], loader: BarsLoader, cache: dict) -> dict:
    """What the recorded marks would have made on one instrument; ``unavailable`` says why when they cannot be priced."""
    out = {"instrument": instrument["right"] or "underlying", "strike": instrument["strike"], "expiry": instrument["expiry"]}
    if not any(m["type"] == "entry" for m in marks) or not any(m["type"] == "exit" for m in marks):
        return {**out, "unavailable": "Needs both an Entry and an Exit mark"}
    key = (instrument["right"], instrument["strike"], instrument["expiry"], setup["interval_minutes"])
    if key not in cache:
        try:
            cache[key] = loader(symbol, date, setup["interval_minutes"], strike=instrument["strike"], expiry=instrument["expiry"],
                                right=instrument["right"])
        except Exception as exc:  # no data, a failed provider or an expired token: the rest of the review still works
            logger.warning("practice review: no bars for %s", key, exc_info=True)
            cache[key] = exc
    bars = cache[key]
    if isinstance(bars, Exception):
        return {**out, "unavailable": "No price data for this instrument on that day"}
    sign = -1 if (instrument["right"] is None and setup["side"] == "sell") else 1  # a short on the underlying; options are bought
    best = _best_pair(marks, bars, sign)
    return {**out, **best} if best else {**out, "unavailable": "The marked candles have no trades"}


def _user_trip(trip: dict) -> Optional[dict]:
    from app.services.traded_patterns_service import _volume_weighted, setup_side

    entries, exits = trip.get("entry_trades") or [], trip.get("exit_trades") or []
    if not entries:
        return None
    action = str(entries[0].get("side", "")).upper()
    entry_price, quantity = _volume_weighted(entries)
    right = trip.get("right") if trip.get("right") in ("CE", "PE") else None
    out = {"index": trip.get("index"), "instrument": right or "underlying", "right": right, "strike": trip.get("strike"),
           "expiry": trip.get("expiry"), "action": action, "side": setup_side(right, action), "state": trip.get("state", "closed"),
           "quantity": quantity, "pnl": float(trip.get("pnl") or 0), "pnl_pct": trip.get("pnl_pct"),
           "entry": {"time": int(entries[0]["timestamp"]), "price": round(entry_price, 2)}, "exit": None, "points": None}
    if exits:
        exit_price, _ = _volume_weighted(exits)
        out["exit"] = {"time": int(exits[-1]["timestamp"]), "price": round(exit_price, 2)}
        out["points"] = round((exit_price - entry_price) * (1 if action == "BUY" else -1), 2)
    return out


def _compare(trip: dict, setup: dict, recorded: dict, theory: list[dict]) -> dict:
    """One of the user's trades against the recorded day: minutes early or late, and how much of the theoretical move it kept."""
    bar = setup["interval_minutes"] * 60
    entry_bar = trip["entry"]["time"] - trip["entry"]["time"] % bar
    out = {**trip, "entry_delta_min": None, "exit_delta_min": None, "capture_pct": None, "theoretical_points": None, "theoretical_rupees": None}
    if recorded["entry"]:
        out["entry_delta_min"] = round((entry_bar - recorded["entry"]["time"]) / 60)
    if trip["exit"] and recorded["exit"]:
        exit_bar = trip["exit"]["time"] - trip["exit"]["time"] % bar
        out["exit_delta_min"] = round((exit_bar - recorded["exit"]["time"]) / 60)
    same = next((t for t in theory if t["instrument"] == trip["instrument"] and t["strike"] == trip.get("strike") and "points" in t), None)
    if same:
        out["theoretical_points"] = same["points"]
        out["theoretical_rupees"] = round(same["points"] * trip["quantity"], 2)
        if trip["points"] is not None and same["points"] > 0:
            out["capture_pct"] = round(trip["points"] / same["points"] * 100, 1)
    return out


def evaluate(user_id: str, session_id: str, loader: Optional[BarsLoader] = None) -> dict:
    """The review of an ended practice run: the recorded answer, the theoretical P&L, and the user's trades against them.

    Refused (``PermissionError``) while the session still runs, so the recorded side and marks cannot be read mid-practice.
    The theoretical P&L prices every Entry / Exit pair of the marks (entry at the open of its candle, exit at the close of its
    candle; a Sell setup on the underlying is a short, options are bought) and keeps the most profitable, for the underlying,
    for the setup side's option when its strike is known, and for any contract the user traded.
    """
    from app.services import deep_dive_service as dd
    from app.services import options_service
    from app.services import simulation as sim_svc
    from app.services import trade_label_service as labels

    loader = loader or load_bars
    row = _sessions_table().get_item(Key={"session_id": session_id}, ConsistentRead=True).get("Item")
    marker = sim_svc.load_practice(row) if row and row.get("user_id") == user_id else None
    if not marker:
        raise LookupError("Practice run not found")
    if not run_finished(row) or sim_svc.get_session(session_id):
        raise PermissionError("Stop the session first: the review shows the recorded answer")

    symbol, date = marker["symbol"], marker["date"]
    trips = []
    try:
        trips = [t for t in (_user_trip(trip) for trip in labels.compute_round_trips_for_session(session_id)) if t]
    except Exception:
        logger.warning("practice review: round trips unavailable for %s", session_id, exc_info=True)
    if marker.get("negative"):
        return _negative_review(session_id, marker, trips)
    optionable = symbol in options_service.STRIKE_INTERVALS
    cache: dict = {}
    setups = []
    for rec in marker["recorded"]:
        side, annotations = rec["side"], rec["annotations"]
        timings = dd.entry_exit_times(annotations)
        marks = [{"type": m["type"], "time": m["time"], "clock": m["clock"]} for m in timings["marks"]]
        right = "CE" if side == "buy" else "PE"
        strike = rec["strike_ce"] if side == "buy" else rec["strike_pe"]
        expiry = options_service.get_expiry_date(symbol, date) if optionable else None
        mine = [t for t in trips if t["side"] == side]
        wanted = [{"right": None, "strike": None, "expiry": None}]
        if optionable and strike:
            wanted.append({"right": right, "strike": strike, "expiry": expiry})
        for t in mine:
            if t["right"] and not any(w["right"] == t["right"] and w["strike"] == t.get("strike") for w in wanted):
                wanted.append({"right": t["right"], "strike": t.get("strike"), "expiry": t.get("expiry") or expiry})
        setup = {"side": side, "interval_minutes": rec["interval_minutes"]}
        theory = [_theoretical(setup, w, symbol, date, marks, loader, cache) for w in wanted]
        setups.append({
            "side": side, "interval_minutes": rec["interval_minutes"], "outcome": rec["outcome"], "strength": rec["strength"],
            "strike_ce": rec["strike_ce"], "strike_pe": rec["strike_pe"], "annotations": annotations, "recorded": timings,
            "theoretical": theory, "trades": [_compare(t, setup, timings, theory) for t in mine],
        })
    matched = {t["index"] for s in setups for t in s["trades"]}
    result = {
        "session_id": session_id, "category": marker["category"], "strategy": marker["strategy"], "symbol": symbol, "date": date,
        "start_time": marker["start_time"], "start_offset_min": marker["start_offset_min"], "setups": setups,
        "other_trades": [t for t in trips if t["index"] not in matched],
    }
    result["negative"] = False
    result["summary"] = _summary(setups)
    _remember(session_id, result["summary"])
    return result


def _negative_review(session_id: str, marker: dict, trips: list[dict]) -> dict:
    """A day the strategy was absent: staying out is the right call, and every trade is one that should not have been taken."""
    closed = [t["points"] for t in trips if t["points"] is not None]
    summary = {"traded": bool(trips), "negative": True, "correct": not trips, "points": round(sum(closed), 2) if closed else None}
    _remember(session_id, summary)
    return {"session_id": session_id, "category": marker["category"], "strategy": marker["strategy"], "symbol": marker["symbol"],
            "date": marker["date"], "start_time": marker["start_time"], "start_offset_min": marker["start_offset_min"],
            "negative": True, "setups": [], "other_trades": trips, "summary": summary}


def _summary(setups: list[dict]) -> dict:
    """The one line kept with the run for the History list: the user's first trade that matches a recorded side."""
    first = min((t for s in setups for t in s["trades"]), key=lambda t: t["entry"]["time"], default=None)
    if first is None:
        return {"traded": False}
    return {"traded": True, "side": first["side"], "entry_delta_min": first["entry_delta_min"], "exit_delta_min": first["exit_delta_min"],
            "capture_pct": first["capture_pct"], "points": first["points"], "theoretical_points": first["theoretical_points"]}


def _remember(session_id: str, summary: dict) -> None:
    """Keep the summary with the session (it can always be recomputed). Best effort: the review does not depend on it."""
    try:
        _sessions_table().update_item(Key={"session_id": session_id}, UpdateExpression="SET practice_result = :r",
                                      ExpressionAttributeValues={":r": json.dumps(summary)})
    except Exception:
        logger.warning("practice review: could not keep the summary of %s", session_id, exc_info=True)
