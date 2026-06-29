"""
Breeze (ICICI Direct) live streaming service for paper and real trading.

Architecture:
  BreezeStreamManager is a per-session wrapper around the BreezeConnect WebSocket.
  Each session creates its own Breeze WebSocket connection via ws_connect().
  Incoming LTP ticks are aggregated into 1-second OHLC dicts and pushed
  to session.paper_tick_queue via call_soon_threadsafe.

  Unlike KiteBroadcaster/KotakBroadcaster (singletons shared by all sessions),
  BreezeStreamManager is created per session. This keeps the implementation
  simple while the Breeze SDK's callback list (breeze.on_ticks) supports
  multiple subscribers natively.

Usage (primary stream source — paper/real sessions):
  from app.services.breeze_service import BreezeStreamManager
  manager = BreezeStreamManager()
  manager.start(session.paper_tick_queue, loop, instruments)
  session.stream_manager = manager
"""
from __future__ import annotations

import asyncio
import logging
import time as _time
from collections import defaultdict
from dataclasses import dataclass

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 1-second OHLC accumulator
# ---------------------------------------------------------------------------

@dataclass
class _OHLCAccumulator:
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    current_second: int = 0

    def update(self, price: float, ts_second: int) -> dict | None:
        """
        Feed a price. Returns a completed candle dict when a new second begins,
        otherwise returns None. Completed candle covers the previous second.
        """
        if self.current_second == 0:
            self.current_second = ts_second
            self.open = self.high = self.low = self.close = price
            return None

        if ts_second == self.current_second:
            self.high = max(self.high, price)
            self.low = min(self.low, price)
            self.close = price
            return None

        completed = {
            "type": "tick",
            "time": self.current_second,
            "open": round(self.open, 2),
            "high": round(self.high, 2),
            "low": round(self.low, 2),
            "close": round(self.close, 2),
        }
        self.current_second = ts_second
        self.open = self.high = self.low = self.close = price
        return completed


# ---------------------------------------------------------------------------
# BreezeStreamManager — per-session live streaming via ICICI Direct WebSocket
# ---------------------------------------------------------------------------

class BreezeStreamManager:
    """
    Live feed via ICICI Direct (Breeze) WebSocket.
    One instance per paper/real session. Aggregates LTP events → 1-second OHLC
    dicts and pushes them to session.paper_tick_queue via call_soon_threadsafe.
    """

    def __init__(self) -> None:
        self._breeze = None
        self._accumulators: dict[str, _OHLCAccumulator] = defaultdict(_OHLCAccumulator)
        self._queue: asyncio.Queue | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._instruments: list[dict] = []

    def start(
        self,
        queue: asyncio.Queue,
        loop: asyncio.AbstractEventLoop,
        instruments: list[dict],
    ) -> None:
        """
        instruments: list of dicts with keys:
          exchange_code, stock_code, product_type, right (optional),
          expiry_date (optional), strike_price (optional)
        """
        from app.services.broker_service import _get_breeze
        self._queue = queue
        self._loop = loop
        self._instruments = instruments

        breeze = _get_breeze()
        breeze.on_ticks = self._on_ticks
        breeze.ws_connect()
        print(instruments);

        for inst in instruments:
            breeze.subscribe_feeds(
                exchange_code=inst["exchange_code"],
                stock_code=inst["stock_code"],
                product_type=inst.get("product_type", "cash"),
                expiry_date=inst.get("expiry_date", ""),
                strike_price=inst.get("strike_price", ""),
                right=inst.get("right", ""),
                get_exchange_quotes=True,
                get_market_depth=False,
            )
        self._breeze = breeze
        logger.info("BreezeStreamManager started for %d instruments", len(instruments))

    def stop(self) -> None:
        if not self._breeze:
            return
        try:
            for inst in self._instruments:
                self._breeze.unsubscribe_feeds(
                    exchange_code=inst["exchange_code"],
                    stock_code=inst["stock_code"],
                    product_type=inst.get("product_type", "cash"),
                    expiry_date=inst.get("expiry_date", ""),
                    strike_price=inst.get("strike_price", ""),
                    right=inst.get("right", ""),
                )
            self._breeze.ws_disconnect()
        except Exception as exc:
            logger.warning("BreezeStreamManager stop error: %s", exc)
        finally:
            self._breeze = None

    def _on_ticks(self, ticks) -> None:
        if not self._queue or not self._loop:
            return
        # Breeze SDK passes data in varied formats: string, dict, or list
        if isinstance(ticks, str):
            import json as _json
            try:
                ticks = _json.loads(ticks)
            except Exception:
                return
        if isinstance(ticks, dict):
            ticks = [ticks]
        if not isinstance(ticks, list):
            return
        for tick in ticks:
            try:
                if isinstance(tick, str):
                    continue
                if not isinstance(tick, dict):
                    continue
                # Breeze tick fields: last, stock_name, symbol, exchange, right
                price = float(tick.get("last", tick.get("ltp", 0.0)))
                if price == 0.0:
                    continue
                right_raw = tick.get("right", "")
                right = right_raw.upper() if right_raw and right_raw.upper() in ("CE", "PE") else None
                # Use stock_name from tick (e.g. "NIFTY 50") as the key base
                name = tick.get("stock_name", tick.get("stock_code", tick.get("symbol", "")))
                key = f"{name}_{right or 'EQ'}"
                ts_second = int(_time.time())

                candle = self._accumulators[key].update(price, ts_second)
                if candle is None:
                    continue

                payload = {**candle}
                if right:
                    payload["right"] = right
                try:
                    self._loop.call_soon_threadsafe(self._queue.put_nowait, payload)
                except Exception as exc:
                    logger.warning("Breeze tick push failed: %s", exc)
            except Exception as exc:
                logger.warning("BreezeStreamManager tick error: %s", exc)
