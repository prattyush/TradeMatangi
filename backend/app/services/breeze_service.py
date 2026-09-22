"""
Breeze (ICICI Direct) live streaming service for paper and real trading.

Architecture:
  BreezeStreamManager is a per-session consumer of a process-wide
  BreezeConnect WebSocket multiplexer. Each manager owns its contract identity
  map and queue while the multiplexer shares the provider connection.
  Incoming LTP ticks are aggregated into 1-second OHLC dicts and pushed
  to session.paper_tick_queue via call_soon_threadsafe.

  Each manager is still created per session. The shared callback deliberately
  fans out raw ticks, so option routing must be exact and fail-closed.

Usage (primary stream source — paper/real sessions):
  from app.services.breeze_service import BreezeStreamManager
  manager = BreezeStreamManager()
  manager.start(session.paper_tick_queue, loop, instruments)
  session.stream_manager = manager
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time as _time
import uuid
import weakref
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

logger = logging.getLogger(__name__)

_multiplexer_lock = threading.RLock()
_multiplexer_managers: weakref.WeakSet = weakref.WeakSet()
_multiplexer_feed_refs: dict[str, int] = {}
_multiplexer_feed_specs: dict[str, dict] = {}
_multiplexer_breeze = None
_multiplexer_connected = False


def _normalise_right(value: object) -> str:
    value = str(value or "").strip().upper()
    return {"CALL": "CE", "PUT": "PE", "CE": "CE", "PE": "PE", "C": "CE", "P": "PE"}.get(value, value)


def _scrip_code(tick: dict) -> str:
    raw_symbol = str(tick.get("symbol", ""))
    return raw_symbol.rsplit("!", 1)[-1].strip() if "!" in raw_symbol else raw_symbol.strip()


def _dispatch_multiplexed_ticks(ticks) -> None:
    """Fan one Breeze callback out to isolated per-consumer managers."""
    with _multiplexer_lock:
        managers = list(_multiplexer_managers)
    for manager in managers:
        manager._on_ticks(ticks)


def _feed_spec(instrument: dict) -> dict:
    expiry = instrument.get("expiry_date", "")
    if expiry:
        try:
            expiry = datetime.strptime(expiry.split("T")[0], "%Y-%m-%d").strftime("%d-%b-%Y")
        except ValueError:
            pass
    return {
        "exchange_code": instrument.get("exchange_code", ""),
        "stock_code": instrument.get("stock_code", ""),
        "product_type": instrument.get("product_type", "cash"),
        "expiry_date": expiry,
        "strike_price": instrument.get("strike_price", ""),
        "right": instrument.get("right", ""),
    }


def _feed_key(instrument: dict) -> str:
    spec = _feed_spec(instrument)
    return "|".join(str(spec[key]).lower() for key in (
        "exchange_code", "stock_code", "product_type", "expiry_date", "strike_price", "right"
    ))


def _subscribe_feed(breeze, spec: dict) -> None:
    breeze.subscribe_feeds(
        exchange_code=spec["exchange_code"],
        stock_code=spec["stock_code"],
        product_type=spec["product_type"],
        expiry_date=spec["expiry_date"],
        strike_price=spec["strike_price"],
        right=spec["right"],
        get_exchange_quotes=True,
        get_market_depth=False,
    )


def _unsubscribe_feed(breeze, spec: dict) -> None:
    breeze.unsubscribe_feeds(
        exchange_code=spec["exchange_code"],
        stock_code=spec["stock_code"],
        product_type=spec["product_type"],
        expiry_date=spec["expiry_date"],
        strike_price=spec["strike_price"],
        right=spec["right"],
    )


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
        self._manager_id = uuid.uuid4().hex[:12]
        self._session_id: str | None = None
        self._breeze = None
        self._accumulators: dict[str, _OHLCAccumulator] = defaultdict(_OHLCAccumulator)
        self._queue: asyncio.Queue | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._instruments: list[dict] = []
        self._tick_count: int = 0
        self._logged_ticks: int = 0
        self._identity_warning_count: int = 0
        self._raw_tick_count: int = 0
        self._accepted_tick_count: int = 0
        self._first_accepted_logged: bool = False
        self._equity_stock_name: str | None = None
        self._equity_exchange: str | None = None
        self._registered = False
        # Map of Breeze ScripCode (raw token id from WS tick "symbol" field)
        # → (strike_price, right_label). Populated before subscription by
        # parsing the Breeze Security Master file because Breeze WS payloads
        # omit right/strike_price on BFO option ticks (the production
        # wrapper cannot rely on those fields being present). get_quotes()
        # is unreliable for BFO so we fall back to the master file.
        self._option_scrip_map: dict[str, tuple[int, str]] = {}
        # ScripCode → the exact desktop/paper route owned by this manager.
        self._option_scrip_routes: dict[str, str] = {}
        # A provider instrument can be used by multiple desktop tiles (for
        # example NIFTY 3m and NIFTY 5m). Keep every destination for a route.
        self._route_queues: dict[str, list[asyncio.Queue]] = {}

    def start(
        self,
        queue: asyncio.Queue,
        loop: asyncio.AbstractEventLoop,
        instruments: list[dict],
        routes: dict[str, asyncio.Queue | list[asyncio.Queue]] | None = None,
        session_id: str | None = None,
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
        self._session_id = session_id
        logger.info(
            "breeze_manager_starting manager_id=%s session_id=%s instruments=%d routed=%s",
            self._manager_id, self._session_id or "-", len(instruments), bool(routes),
        )
        self._route_queues = {
            key: value if isinstance(value, list) else [value]
            for key, value in (routes or {}).items()
        }

        # Resolve contract identity before registering this manager with the
        # shared callback. Other managers' ticks are deliberately broadcast to
        # us; only these exact ScripCodes may be accepted below.
        self._option_scrip_map.clear()
        self._option_scrip_routes.clear()
        for inst in instruments:
            if inst.get("product_type") != "options" or not inst.get("right"):
                continue
            expiry_raw = _feed_spec(inst)["expiry_date"]
            right_label = _normalise_right(inst.get("right"))
            try:
                scrip_map = self._build_scrip_map(
                    inst["stock_code"],
                    inst["exchange_code"],
                    int(float(inst["strike_price"])),
                    right_label,
                    expiry_raw,
                )
            except Exception as exc:
                scrip_map = {}
                logger.warning(
                    "BreezeStreamManager: option identity lookup failed "
                    "exchange=%s stock=%s expiry=%s strike=%s right=%s: %s",
                    inst.get("exchange_code"), inst.get("stock_code"), expiry_raw,
                    inst.get("strike_price"), right_label, exc,
                )
            route_key = self.instrument_route_key(inst)
            if not scrip_map:
                logger.debug(
                    "breeze_contract_mapping_empty manager_id=%s session_id=%s "
                    "exchange=%s stock=%s expiry=%s strike=%s right=%s reason=no_contract_match_or_master_unavailable",
                    self._manager_id, self._session_id or "-", inst.get("exchange_code"),
                    inst.get("stock_code"), expiry_raw, inst.get("strike_price"), right_label,
                )
                logger.debug(
                    "BreezeStreamManager: no ScripCode mapping for option "
                    "exchange=%s stock=%s expiry=%s strike=%s right=%s; "
                    "unresolved ticks will be dropped",
                    inst.get("exchange_code"), inst.get("stock_code"), expiry_raw,
                    inst.get("strike_price"), right_label,
                )
            for scrip_code, (m_strike, m_right) in scrip_map.items():
                existing = self._option_scrip_routes.get(scrip_code)
                if existing and existing != route_key:
                    logger.warning(
                        "BreezeStreamManager: ScripCode=%s resolved to multiple "
                        "routes (%s, %s); ignoring duplicate",
                        scrip_code, existing, route_key,
                    )
                    continue
                self._option_scrip_map[scrip_code] = (m_strike, _normalise_right(m_right))
                self._option_scrip_routes[scrip_code] = route_key
                logger.info(
                    "BreezeStreamManager: mapped option ScripCode=%s → %s",
                    scrip_code, route_key,
                )
            if scrip_map:
                logger.debug(
                    "breeze_contract_mapping_succeeded manager_id=%s session_id=%s "
                    "exchange=%s stock=%s expiry=%s strike=%s right=%s mapped_count=%d",
                    self._manager_id, self._session_id or "-", inst.get("exchange_code"),
                    inst.get("stock_code"), expiry_raw, inst.get("strike_price"),
                    right_label, len(scrip_map),
                )

        breeze = _get_breeze()
        global _multiplexer_breeze, _multiplexer_connected
        with _multiplexer_lock:
            # A credential refresh can replace the SDK object. Do not carry
            # subscriptions from the old connection into the new one.
            if _multiplexer_breeze is not None and _multiplexer_breeze is not breeze:
                logger.warning(
                    "breeze_client_changed manager_id=%s session_id=%s old_client=%s new_client=%s "
                    "clearing_managers=%d",
                    self._manager_id, self._session_id or "-", id(_multiplexer_breeze),
                    id(breeze), len(_multiplexer_managers),
                )
                _multiplexer_managers.clear()
                _multiplexer_feed_refs.clear()
                _multiplexer_feed_specs.clear()
                _multiplexer_connected = False
            _multiplexer_breeze = breeze
            breeze.on_ticks = _dispatch_multiplexed_ticks
            first_consumer = not _multiplexer_managers
            _multiplexer_managers.add(self)
            self._registered = True
            if first_consumer and not _multiplexer_connected:
                logger.info(
                    "breeze_ws_connecting manager_id=%s session_id=%s",
                    self._manager_id, self._session_id or "-",
                )
                breeze.ws_connect()
                _multiplexer_connected = True
                logger.info(
                    "breeze_ws_connected manager_id=%s session_id=%s managers=%d",
                    self._manager_id, self._session_id or "-", len(_multiplexer_managers),
                )

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
            spec = _feed_spec(inst)
            feed_key = _feed_key(inst)
            with _multiplexer_lock:
                if _multiplexer_feed_refs.get(feed_key, 0) == 0:
                    logger.info(
                        "breeze_feed_subscribe_started manager_id=%s session_id=%s feed=%s",
                        self._manager_id, self._session_id or "-", feed_key,
                    )
                    _subscribe_feed(breeze, spec)
                    _multiplexer_feed_specs[feed_key] = spec
                    logger.info(
                        "breeze_feed_subscribed manager_id=%s session_id=%s feed=%s",
                        self._manager_id, self._session_id or "-", feed_key,
                    )
                _multiplexer_feed_refs[feed_key] = _multiplexer_feed_refs.get(feed_key, 0) + 1
        self._breeze = breeze
        logger.info(
            "breeze_manager_started manager_id=%s session_id=%s instruments=%d mapped_options=%d feeds=%d managers=%d",
            self._manager_id, self._session_id or "-", len(instruments),
            len(self._option_scrip_map), len(_multiplexer_feed_refs), len(_multiplexer_managers),
        )

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
        if not self._breeze and not self._registered:
            return
        global _multiplexer_connected, _multiplexer_breeze
        try:
            with _multiplexer_lock:
                breeze = self._breeze or _multiplexer_breeze
                if self._registered:
                    _multiplexer_managers.discard(self)
                    self._registered = False
                if breeze:
                    for inst in self._instruments:
                        feed_key = _feed_key(inst)
                        refs = _multiplexer_feed_refs.get(feed_key, 0) - 1
                        if refs <= 0:
                            spec = _multiplexer_feed_specs.pop(feed_key, _feed_spec(inst))
                            try:
                                _unsubscribe_feed(breeze, spec)
                            except Exception as exc:
                                logger.warning("Breeze multiplexer unsubscribe error: %s", exc)
                            _multiplexer_feed_refs.pop(feed_key, None)
                        else:
                            _multiplexer_feed_refs[feed_key] = refs
                    if not _multiplexer_managers and _multiplexer_connected:
                        breeze.ws_disconnect()
                        _multiplexer_connected = False
                        _multiplexer_breeze = None
        except Exception as exc:
            logger.warning("BreezeStreamManager stop error: %s", exc)
        finally:
            self._breeze = None
            self._route_queues = {}

    @staticmethod
    def instrument_route_key(instrument: dict) -> str:
        if instrument.get("product_type") == "options":
            spec = _feed_spec(instrument)
            right = _normalise_right(spec["right"])
            return (
                f"option:{spec['exchange_code']}:{spec['stock_code']}:"
                f"{spec['expiry_date']}:{spec['strike_price']}:{right}"
            )
        return f"equity:{instrument.get('exchange_code')}:{instrument.get('stock_code')}"

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
                self._raw_tick_count += 1
                price = float(tick.get("last", tick.get("ltp", 0.0)))
                if price == 0.0:
                    continue
                right = _normalise_right(tick.get("right")) or None
                scrip_code = _scrip_code(tick)
                mapped = self._option_scrip_map.get(scrip_code)

                # Breeze option ticks (especially BFO / SENSEX) omit
                # right/strike_price; identify options by the presence of
                # open-interest fields (OI/CHNGOI) and look up identity
                # from the ScripCode (the part of "symbol" after "!").
                # Note: Breeze index ticks ALSO carry quotes: "Quotes Data"
                # but lack OI/CHNGOI — using OI/CHNGOI as the option
                # discriminator avoids misclassifying the index tick.
                is_option_tick = (
                    "OI" in tick
                    or "CHNGOI" in tick
                    or bool(right)
                    or mapped is not None
                )
                if is_option_tick:
                    # The shared Breeze callback delivers other consumers'
                    # option ticks here too. A right label alone is not
                    # identity; accept only a ScripCode owned by this manager.
                    if mapped is None:
                        self._identity_warning_count += 1
                        if (
                            self._identity_warning_count <= 5
                            or self._identity_warning_count % 100 == 0
                        ):
                            logger.debug(
                                "breeze_option_tick_dropped manager_id=%s session_id=%s reason=unmatched_scrip "
                                "scrip=%s raw_right=%s symbol=%s count=%d mapped_options=%d",
                                self._manager_id, self._session_id or "-", scrip_code, right,
                                tick.get("symbol", ""), self._identity_warning_count,
                                len(self._option_scrip_map),
                            )
                        continue
                    _, mapped_right = mapped
                    if right and right != mapped_right:
                        self._identity_warning_count += 1
                        if (
                            self._identity_warning_count <= 5
                            or self._identity_warning_count % 100 == 0
                        ):
                            logger.debug(
                                "breeze_option_tick_dropped manager_id=%s session_id=%s reason=contradictory_right "
                                "scrip=%s raw_right=%s mapped_right=%s count=%d",
                                self._manager_id, self._session_id or "-", scrip_code, right,
                                mapped_right, self._identity_warning_count,
                            )
                        continue
                    right = mapped_right

                name = tick.get("stock_name", tick.get("stock_code", tick.get("symbol", "")))
                exchange = tick.get("exchange", "")
                equity_route_key = None

                # Filter out equity ticks from non-target stocks. Breeze
                # broadcasts all subscribed stocks, so match every equity tile
                # instead of only the first tile in the screen.
                equity_instruments = [
                    instrument for instrument in self._instruments
                    if instrument.get("product_type") != "options"
                ]
                if not right and equity_instruments:
                    tick_exch = str(tick.get("exchange", ""))
                    tick_stock = str(tick.get("stock_code", ""))
                    name_lower = str(name).lower()
                    matching = []
                    for instrument in equity_instruments:
                        exchange_code = str(instrument.get("exchange_code", ""))
                        stock_code = str(instrument.get("stock_code", ""))
                        if exchange_code and tick_exch and exchange_code not in tick_exch:
                            continue
                        if tick_stock and tick_stock != stock_code:
                            continue
                        if not tick_stock and stock_code.lower() not in name_lower and stock_code.lower().replace("bsesen", "sensex") not in name_lower:
                            continue
                        matching.append(instrument)
                    if not matching:
                        continue
                    equity_route_key = self.instrument_route_key(matching[0])

                key = f"{name}_{right or 'EQ'}"

                route_key = None
                if right:
                    route_key = self._option_scrip_routes.get(scrip_code)
                else:
                    route_key = equity_route_key

                # Keep OHLC accumulators independent for different tiles,
                # especially options with the same underlying and right but
                # different strikes.
                key = route_key or key
                ts_second = int(_time.time()) + 19800

                candle = self._accumulators[key].update(price, ts_second)
                self._accepted_tick_count += 1
                if not self._first_accepted_logged:
                    self._first_accepted_logged = True
                    logger.info(
                        "breeze_tick_first_accepted manager_id=%s session_id=%s route=%s "
                        "scrip=%s right=%s raw_ticks=%d",
                        self._manager_id, self._session_id or "-", key, scrip_code,
                        right or "EQ", self._raw_tick_count,
                    )
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
                if self._route_queues:
                    # Desktop streams are explicitly routed. A tick that
                    # cannot be identified must not fill a shared fallback
                    # queue and starve all other tiles.
                    target_queues = self._route_queues.get(route_key) if route_key else None
                    if not target_queues:
                        continue
                else:
                    target_queues = [self._queue] if self._queue is not None else []
                try:
                    for target_queue in target_queues:
                        self._loop.call_soon_threadsafe(target_queue.put_nowait, payload)
                except Exception as exc:
                    logger.warning("Breeze tick push failed: %s", exc)
            except Exception as exc:
                logger.warning("BreezeStreamManager tick error: %s", exc)
