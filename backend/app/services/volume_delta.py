"""Per-second volume from a broker's cumulative day total (Phase 24, live volume, Track C).

The live feeds report volume as a running total for the day (Kite ``volume_traded``, Breeze ``ttq``; the 2026-11-16
probe saw it only ever rise). The volume of a second is the difference between two totals. This guard keeps the
previous total of one instrument and turns the next one into that difference, and it is the one place that decides
what a bad value means, so the four broker adapters cannot disagree:

* the first usable total after a subscribe or a reconnect is a **baseline** only: it contributes 0, because the volume
  traded before this subscription is not part of any bar;
* a total **lower** than the previous one is a reset (a new session, a re-listed contract, a bad tick): it becomes the
  new baseline and contributes 0, never a negative volume;
* a value that is missing, not a number, not finite or negative is **ignored**: it contributes nothing and the baseline
  is kept, so one bad packet does not turn the next good one into a huge difference.

Never use a per-trade quantity (Kite ``last_traded_quantity``, Breeze ``ltq``) for this: the feed is a snapshot stream,
not every trade, so summing those undercounts. Indices carry no volume at all; for them the caller never calls
``delta`` and the candle has no ``volume`` key (never 0).
"""
from __future__ import annotations

from math import isfinite


def clean_total(value) -> int | None:
    """A cumulative total as a whole number, or None when it is not a usable number."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(number) or number < 0:
        return None
    return int(number)


class VolumeDelta:
    """Turns one instrument's cumulative totals into per-update volumes."""

    __slots__ = ("_last",)

    def __init__(self) -> None:
        self._last: int | None = None

    def reset(self) -> None:
        """Forget the baseline (a new connection, subscription, strike or provider)."""
        self._last = None

    @property
    def baseline(self) -> int | None:
        return self._last

    def delta(self, total) -> int | None:
        """Volume since the previous total; 0 for a baseline or a reset; None when ``total`` is unusable (nothing changes)."""
        value = clean_total(total)
        if value is None:
            return None
        previous, self._last = self._last, value
        if previous is None or value < previous:
            return 0
        return value - previous
