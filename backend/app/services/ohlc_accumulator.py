"""One-second OHLC (and volume) accumulator shared by the live broker adapters (Phase 24, Track C).

Feed it prices with the volume traded since the previous update (from ``volume_delta.VolumeDelta``, when the feed has a
volume); it returns the completed candle when a new second begins. ``volume_seen`` stays False for an instrument that
never reports volume (an index), so its candles carry no ``volume`` key at all rather than a misleading 0.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class OHLCAccumulator:
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    current_second: int = 0
    # Volume traded inside the current second. ``volume_seen`` stays False for an instrument that never reports volume
    # (an index), so its candles carry no ``volume`` key at all rather than a misleading 0.
    volume: int = 0
    volume_seen: bool = False

    def candle(self) -> dict:
        """The candle of the current second as the stream publishes it."""
        candle = {
            "type": "tick",
            "time": self.current_second,
            "open": round(self.open, 2),
            "high": round(self.high, 2),
            "low": round(self.low, 2),
            "close": round(self.close, 2),
        }
        if self.volume_seen:
            candle["volume"] = self.volume
        return candle

    def update(self, price: float, ts_second: int, volume: int | None = None) -> dict | None:
        """
        Feed a price (and the volume traded since the previous update, when the feed has one). Returns a completed
        candle dict when a new second begins, otherwise returns None. Completed candle covers the previous second.
        """
        if self.current_second == 0:
            self.current_second = ts_second
            self.open = self.high = self.low = self.close = price
            self.volume, self.volume_seen = volume or 0, volume is not None
            return None

        if ts_second == self.current_second:
            self.high = max(self.high, price)
            self.low = min(self.low, price)
            self.close = price
            if volume is not None:
                self.volume += volume
                self.volume_seen = True
            return None

        completed = self.candle()
        self.current_second = ts_second
        self.open = self.high = self.low = self.close = price
        self.volume, self.volume_seen = volume or 0, volume is not None
        return completed
