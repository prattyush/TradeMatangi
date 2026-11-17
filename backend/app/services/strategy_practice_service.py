"""
Strategy Practice (Phase 26, S13 onwards): practise a strategy by replaying the days marked in its Deep Dive.

A practice run is an ordinary replay (``sim``) session plus a ``practice`` marker on its ``Sessions`` record. The marker holds
the strategy, the day and a snapshot of what the user recorded for that day (side, chart marks, grade), so the review still
works if the Deep Dive day is edited or deleted later. The snapshot is server-side only: responses show the strategy and
never the side or the marks while the user practises.
"""
from __future__ import annotations

from typing import Optional

REPLAY_OPENS_SECONDS = 9 * 3600 + 15 * 60  # 09:15:00, the earliest a practice replay may start


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


def build_marker(user_id: str, practice: dict, symbol: str, date: str, start_time: str) -> dict:
    """The marker stored on a practice session; ``ValueError`` (shown to the user) when the day cannot be practised.

    ``practice`` is ``{category, strategy, start_offset_min}``; the symbol and date are those of the session request. The day
    must be one of the user's own Deep Dive days with an Entry mark, and the replay must start before that Entry.
    """
    category, strategy = practice["category"].strip(), practice["strategy"].strip()
    setups = recorded_day(user_id, category, strategy, symbol, date)
    if not setups:
        raise ValueError("That day has no Entry mark in your deep dive, so it cannot be practised")
    entry_at = first_entry_seconds(setups)
    try:
        start_at = _seconds_of_day(start_time)
    except ValueError:
        raise ValueError("The start time is not a time of day")
    if start_at >= entry_at:
        raise ValueError("The replay must start before the first recorded entry")
    return {
        "category": category, "strategy": strategy, "symbol": symbol, "date": date,
        "start_time": start_time, "start_offset_min": int(practice.get("start_offset_min") or 0),
        "recorded": [{
            "side": s["side"], "interval_minutes": s["interval_minutes"], "strike_ce": s["strike_ce"], "strike_pe": s["strike_pe"],
            "strike_mode": s["strike_mode"], "outcome": s["outcome"], "strength": s["strength"],
            "annotations": s["annotations"],
        } for s in setups],
    }
