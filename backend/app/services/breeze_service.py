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
from datetime import datetime

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
        self._tick_count: int = 0
        self._logged_ticks: int = 0
        self._equity_stock_name: str | None = None
        self._equity_exchange: str | None = None
        # Map of Breeze ScripCode (raw token id from WS tick "symbol" field)
        # → (strike_price, right_label). Populated at subscribe time by
        # parsing the Breeze Security Master file because Breeze WS payloads
        # omit right/strike_price on BFO option ticks (the production
        # wrapper cannot rely on those fields being present). get_quotes()
        # is unreliable for BFO so we fall back to the master file.
        self._option_scrip_map: dict[str, tuple[int, str]] = {}

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

        logger.info("BreezeStreamManager subscribing to %d instruments:", len(instruments))
        for inst in instruments:
            # Track the equity instrument's stock name so we can filter out
            # non-target equity ticks. Breeze broadcasts ALL subscribed stocks;
            # we only want ticks from our session's symbol (e.g. "NIFTY 50").
            right_val = inst.get("right", "")
            if not right_val and self._equity_stock_name is None:
                self._equity_stock_name = inst.get("stock_code", "")
                self._equity_exchange = inst.get("exchange_code", "")
            # Convert expiry from Kite format ("2026-06-30T06:00:00.000Z") to
            # Breeze format ("30-Jun-2026") at the API call only.
            expiry_raw = inst.get("expiry_date", "")
            if expiry_raw:
                from datetime import datetime as _dt
                try:
                    expiry_raw = _dt.strptime(
                        expiry_raw.split("T")[0], "%Y-%m-%d"
                    ).strftime("%d-%b-%Y")
                except ValueError:
                    pass
            logger.info(
                "  Breeze feed: exchange=%s stock=%s product=%s expiry=%s strike=%s right=%s",
                inst.get("exchange_code"), inst.get("stock_code"),
                inst.get("product_type", "cash"), expiry_raw,
                inst.get("strike_price", ""), inst.get("right", ""),
            )
            breeze.subscribe_feeds(
                exchange_code=inst["exchange_code"],
                stock_code=inst["stock_code"],
                product_type=inst.get("product_type", "cash"),
                expiry_date=expiry_raw,
                strike_price=inst.get("strike_price", ""),
                right=inst.get("right", ""),
                get_exchange_quotes=True,
                get_market_depth=False,
            )
            # Resolve the ScripCode for option instruments. Breeze's WS
            # payload uses raw symbols like "8.1!855562" where 855562 is the
            # ScripCode; the tick does NOT carry right/strike_price on BFO
            # option streams, so we build a ScripCode → (strike, right) map
            # here for the tick handler to look up. We use the Breeze
            # Security Master file (FOBSEScripMaster.txt / FONSEScripMaster.txt)
            # rather than get_quotes() because get_quotes() is unreliable
            # for BFO options (returns empty/non-JSON for BSE F&O).
            if inst.get("product_type") == "options" and inst.get("right"):
                try:
                    right_label = (
                        "CE" if inst["right"].lower() in ("call", "ce") else "PE"
                    )
                    scrip_map = self._build_scrip_map(
                        inst["stock_code"],
                        inst["exchange_code"],
                        int(inst["strike_price"]),
                        right_label,
                        expiry_raw,
                    )
                    for scrip_code, (m_strike, m_right) in scrip_map.items():
                        self._option_scrip_map[scrip_code] = (m_strike, m_right)
                        logger.info(
                            "BreezeStreamManager: mapped option ScripCode=%s → strike=%s right=%s",
                            scrip_code, m_strike, m_right,
                        )
                except Exception as exc:
                    logger.debug(
                        "BreezeStreamManager: scrip-code lookup failed for %s %s %s: %s",
                        inst.get("exchange_code"), inst.get("strike_price"),
                        inst.get("right"), exc,
                    )
        self._breeze = breeze
        logger.info("BreezeStreamManager started for %d instruments", len(instruments))

    def _build_scrip_map(
        self,
        stock_code: str,
        exchange_code: str,
        strike: int,
        right: str,
        expiry_breeze: str,
    ) -> dict[str, tuple[int, str]]:
        """
        Parse Breeze security master to map ScripCode → (strike, right) for
        a single subscribed option. Uses load_breeze_security_master() to
        fetch the master file (cached daily, downloaded from Breeze once per
        day). Returns an empty dict on failure — caller continues without
        ScripCode tagging.
        """
        from app.services.breeze_master import load_breeze_security_master

        scrip_map = load_breeze_security_master(
            stock_code=stock_code,
            exchange_code=exchange_code,
            strike=strike,
            right=right,
            expiry_breeze=expiry_breeze,
        )
        return scrip_map

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
        if self._queue is None or self._loop is None:
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
                self._tick_count += 1
                price = float(tick.get("last", tick.get("ltp", 0.0)))
                if price == 0.0:
                    continue
                right_raw = tick.get("right", "").upper()
                _right_map = {"CALL": "CE", "PUT": "PE", "CE": "CE", "PE": "PE", "C": "CE", "P": "PE"}
                right = _right_map.get(right_raw) if right_raw else None

                # Breeze option ticks (especially BFO / SENSEX) omit
                # right/strike_price; identify options by the presence of
                # open-interest fields (OI/CHNGOI) and look up identity
                # from the ScripCode (the part of "symbol" after "!").
                # Note: Breeze index ticks ALSO carry quotes: "Quotes Data"
                # but lack OI/CHNGOI — using OI/CHNGOI as the option
                # discriminator avoids misclassifying the index tick.
                is_option_tick = "OI" in tick or "CHNGOI" in tick
                if is_option_tick and not right:
                    raw_symbol = str(tick.get("symbol", ""))
                    scrip_code = (
                        raw_symbol.rsplit("!", 1)[-1].strip()
                        if "!" in raw_symbol else raw_symbol
                    )
                    if scrip_code in self._option_scrip_map:
                        _, right = self._option_scrip_map[scrip_code]

                name = tick.get("stock_name", tick.get("stock_code", tick.get("symbol", "")))
                exchange = tick.get("exchange", "")

                # Filter out equity ticks from non-target stocks. Breeze
                # broadcasts market data for ALL instruments; we only want
                # equity ticks matching our session's subscribed symbol.
                # Combine exchange prefix + stock name matching to avoid
                # picking up other stocks on the same exchange.
                if not right and self._equity_stock_name:
                    tick_exch = tick.get("exchange", "")
                    # Must be on the right exchange segment
                    if self._equity_exchange and tick_exch:
                        if self._equity_exchange not in tick_exch:
                            continue
                    # Must match the subscribed equity — check both stock_code
                    # and stock_name since Breeze sometimes omits stock_code.
                    tick_stock = tick.get("stock_code", "")
                    if tick_stock and tick_stock != self._equity_stock_name:
                        continue
                    if not tick_stock:
                        # Breeze sends empty stock_code for indices; match by
                        # known index display names
                        eq_lower = self._equity_stock_name.lower()
                        name_lower = str(name).lower()
                        if eq_lower not in name_lower and eq_lower.replace("bsesen", "sensex") not in name_lower:
                            continue

                key = f"{name}_{right or 'EQ'}"

                ts_second = int(_time.time()) + 19800

                candle = self._accumulators[key].update(price, ts_second)
                if candle is None:
                    continue

                # Throttled logging: first 6 candles, then every 60th after that,
                # then stop entirely after 300 candles (~5 min).
                self._logged_ticks += 1
                if self._logged_ticks <= 6 or (self._logged_ticks % 60 == 0 and self._logged_ticks <= 300):
                    logger.info(
                        "Breeze tick #%d: %s ltp=%.2f O=%.2f H=%.2f L=%.2f C=%.2f",
                        self._logged_ticks, key, price,
                        candle["open"], candle["high"], candle["low"], candle["close"],
                    )

                payload = {**candle}
                if right:
                    payload["right"] = right
                try:
                    self._loop.call_soon_threadsafe(self._queue.put_nowait, payload)
                except Exception as exc:
                    logger.warning("Breeze tick push failed: %s", exc)
            except Exception as exc:
                logger.warning("BreezeStreamManager tick error: %s", exc)
