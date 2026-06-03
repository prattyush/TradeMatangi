"""
In-memory per-session bar accumulation for pattern detection.

PatternBarStore accumulates bar history across multiple bar-close hooks for
a (session_id, right) pair, deduplicating by bar time so that re-sent bars
(the backend resends up to 15 historical bars on every hook) don't bloat the
buffer.

Cooldown tracking prevents re-firing the same pattern every bar during a
persistent regime (e.g. "Strong Bull Trend" should not alert every 3 minutes).
"""
from __future__ import annotations

import time
from collections import deque
from typing import Any

from processors.base import OHLCBar

_MAX_BARS = 50  # rolling history per (session, right)

# Cooldown in bar-close events before the same pattern fires again
COOLDOWN_BARS: dict[str, int] = {
    "strong_bull_trend":   6,
    "strong_bear_trend":   6,
    "trading_range":       8,
    "bull_trend_reversal": 3,
    "bear_trend_reversal": 3,
    "range_breakout_bull": 3,
    "range_breakout_bear": 3,
    "opening_reversal":    5,
    "ema_crossover_bull":  5,
    "ema_crossover_bear":  5,
    "support_zone":        4,
    "resistance_zone":     4,
    "panic_behavior":      3,
    "overtrading":         3,
}

_DEFAULT_COOLDOWN = 5


class PatternBarStore:
    """Thread-safe-enough for asyncio single-threaded event loop."""

    def __init__(self, maxlen: int = _MAX_BARS) -> None:
        self._maxlen = maxlen
        # (session_id, right) → deque of OHLCBar
        self._bars: dict[tuple[str, str | None], deque[OHLCBar]] = {}
        # (session_id, right) → bar count (incremented on each new bar appended)
        self._bar_counts: dict[tuple[str, str | None], int] = {}
        # (session_id, right, pattern) → bar_count at last fire
        self._cooldowns: dict[tuple[str, str | None, str], int] = {}

    def append_bars(self, session_id: str, right: str | None, new_bars: list[OHLCBar]) -> None:
        """Merge new_bars into the session buffer, skipping already-stored bars."""
        key: tuple[str, str | None] = (session_id, right)
        if not new_bars:
            return

        if key not in self._bars:
            buf: deque[OHLCBar] = deque(maxlen=self._maxlen)
            for bar in new_bars:
                buf.append(bar)
            self._bars[key] = buf
            self._bar_counts[key] = len(buf)
            return

        buf = self._bars[key]
        last_time = buf[-1].time if buf else ""
        added = 0
        for bar in new_bars:
            if bar.time > last_time:
                buf.append(bar)
                last_time = bar.time
                added += 1
        self._bar_counts[key] = self._bar_counts.get(key, 0) + added

    def get_bars(self, session_id: str, right: str | None) -> list[dict[str, Any]]:
        """Return accumulated bars as plain dicts (oldest → newest)."""
        key: tuple[str, str | None] = (session_id, right)
        buf = self._bars.get(key)
        if not buf:
            return []
        return [b.model_dump() for b in buf]

    def bar_count(self, session_id: str, right: str | None) -> int:
        key: tuple[str, str | None] = (session_id, right)
        return self._bar_counts.get(key, 0)

    def is_cooled_down(self, session_id: str, right: str | None, pattern: str) -> bool:
        """Return True if enough bars have passed since this pattern last fired."""
        key: tuple[str, str | None] = (session_id, right)
        cd_key = (session_id, right, pattern)
        cooldown = COOLDOWN_BARS.get(pattern, _DEFAULT_COOLDOWN)
        current = self._bar_counts.get(key, 0)
        last_fired = self._cooldowns.get(cd_key, -(cooldown + 1))
        return (current - last_fired) >= cooldown

    def mark_fired(self, session_id: str, right: str | None, pattern: str) -> None:
        """Record that this pattern fired at the current bar count."""
        key: tuple[str, str | None] = (session_id, right)
        cd_key = (session_id, right, pattern)
        self._cooldowns[cd_key] = self._bar_counts.get(key, 0)

    def clear_session(self, session_id: str) -> None:
        """Remove all state for a session (called on session-stop)."""
        keys_to_delete = [k for k in self._bars if k[0] == session_id]
        for k in keys_to_delete:
            del self._bars[k]
        cnt_keys = [k for k in self._bar_counts if k[0] == session_id]
        for k in cnt_keys:
            del self._bar_counts[k]
        cd_keys = [k for k in self._cooldowns if k[0] == session_id]
        for k in cd_keys:
            del self._cooldowns[k]
