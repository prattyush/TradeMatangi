"""
Kite (Zerodha) live streaming service for paper trading.

Architecture:
  KiteBroadcaster (singleton) manages one KiteTicker WebSocket connection.
  Multiple paper-trading sessions register their paper_tick_queue; incoming
  LTP ticks are aggregated into 1-second OHLC dicts and fan-out to each queue.
  The paper session loop reads from paper_tick_queue, calls
  _emit_tick_and_check_orders (which writes to session.queue for SSE), so the
  same order/strategy evaluation path as sim mode is reused unchanged.

Fallback: if Kite credentials are invalid/expired, BreezeStreamManager provides
  the same tick feed via the existing ICICI Direct (Breeze) WebSocket.
"""
from __future__ import annotations

import asyncio
import configparser
import csv
import logging
import threading
import time as _time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------

class KiteTokenError(Exception):
    """Kite access token is missing, invalid, or expired."""


class KiteConnectionError(Exception):
    """Kite WebSocket failed to connect."""


# ---------------------------------------------------------------------------
# Kite client factory
# ---------------------------------------------------------------------------

def _get_kite():
    """Return an authenticated KiteConnect instance. Raises KiteTokenError on bad token."""
    try:
        from kiteconnect import KiteConnect
    except ImportError as exc:
        raise KiteConnectionError(
            "kiteconnect package not installed. Run: pip install kiteconnect"
        ) from exc

    from app.config import DATA_DIR
    cfg = configparser.ConfigParser()
    cfg.read(str(DATA_DIR / "accesskeys.ini"))
    if "kite" not in cfg:
        raise KiteTokenError("No [kite] section in data/accesskeys.ini")
    api_key = cfg["kite"].get("api_key", "").strip()

    # DDB token takes precedence over accesskeys.ini (admin sets it daily via UI)
    try:
        from app.services.token_service import get_token as _get_ddb_token
        access_token = _get_ddb_token("kite_access") or cfg["kite"].get("access_token", "").strip()
    except Exception:
        access_token = cfg["kite"].get("access_token", "").strip()

    if not api_key or not access_token:
        raise KiteTokenError("Kite api_key or access_token missing — set via Admin panel or data/accesskeys.ini")

    kite = KiteConnect(api_key=api_key)
    kite.set_access_token(access_token)
    try:
        kite.profile()
    except Exception as exc:
        raise KiteTokenError(f"Kite token invalid or expired: {exc}") from exc
    return kite


# ---------------------------------------------------------------------------
# Instrument token lookup
# ---------------------------------------------------------------------------

# Hardcoded equity index tokens (stable, avoid a network call on startup)
_EQUITY_TOKENS: dict[str, tuple[str, int]] = {
    "NIFTY":  ("NSE", 256265),
    "BSESEN": ("BSE", 265),
}

# Mapping from our symbol keys to Kite instrument "name" field
_KITE_NAMES: dict[str, str] = {
    "NIFTY":  "NIFTY",
    "BSESEN": "SENSEX",
    "TATPOW": "TATPOWER",
    "TATMOT": "TATAMOTORS",
    "RELIND": "RELIANCE",
}


def fetch_equity_instrument_token(symbol: str) -> tuple[str, int]:
    """
    Return (exchange, instrument_token) for an equity symbol.
    Indices use hardcoded tokens. Stocks look up from cached NSE instruments CSV.
    """
    if symbol in _EQUITY_TOKENS:
        return _EQUITY_TOKENS[symbol]

    from app.config import DATA_DIR
    cache_path = DATA_DIR / "kite_instruments_NSE.csv"
    if not cache_path.exists():
        _refresh_instruments_cache("NSE", cache_path)

    stock_code = _KITE_NAMES.get(symbol, symbol)
    with open(cache_path, newline="") as f:
        for row in csv.DictReader(f):
            if row.get("tradingsymbol") == stock_code and row.get("exchange") == "NSE":
                return ("NSE", int(row["instrument_token"]))

    raise ValueError(f"Instrument token not found for {symbol} on NSE")


def fetch_options_instrument_token(symbol: str, expiry: str, strike: int, right: str) -> int:
    """
    Return the Kite instrument_token for an options contract.
    expiry: YYYY-MM-DD  |  right: "CE" or "PE"
    Downloads and caches the NFO/BFO instruments list as needed.
    """
    from app.config import DATA_DIR, SUPPORTED_SYMBOLS
    sym_info = SUPPORTED_SYMBOLS.get(symbol, {})
    exchange = "BFO" if sym_info.get("options_exchange_code") == "BFO" else "NFO"
    cache_path = DATA_DIR / f"kite_instruments_{exchange}.csv"

    token = _lookup_options_token(cache_path, symbol, expiry, strike, right)
    if token is not None:
        return token

    # Cache miss — refresh once and retry
    _refresh_instruments_cache(exchange, cache_path)
    token = _lookup_options_token(cache_path, symbol, expiry, strike, right)
    if token is not None:
        return token

    raise ValueError(
        f"Options instrument token not found: {symbol} {right.upper()} {strike} {expiry}"
    )


def _lookup_options_token(cache_path: Path, symbol: str, expiry: str, strike: int, right: str) -> int | None:
    if not cache_path.exists():
        return None
    right_upper = right.upper()
    try:
        expiry_dt = datetime.strptime(expiry, "%Y-%m-%d")
    except ValueError:
        return None
    kite_name = _KITE_NAMES.get(symbol, symbol).upper()
    with open(cache_path, newline="") as f:
        for row in csv.DictReader(f):
            if row.get("instrument_type") != right_upper:
                continue
            try:
                row_strike = float(row.get("strike", 0))
                row_expiry = datetime.strptime(row.get("expiry", "1900-01-01"), "%Y-%m-%d")
            except (ValueError, TypeError):
                continue
            if (
                row.get("name", "").upper() == kite_name
                and row_expiry == expiry_dt
                and abs(row_strike - strike) < 0.5
            ):
                return int(row["instrument_token"])
    return None


def _refresh_instruments_cache(exchange: str, cache_path: Path) -> None:
    """Fetch instruments from Kite API and write to CSV cache."""
    try:
        kite = _get_kite()
        instruments = kite.instruments(exchange)
    except KiteTokenError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Failed to fetch {exchange} instruments: {exc}") from exc

    if not instruments:
        raise RuntimeError(f"Kite returned empty instruments list for {exchange}")

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(instruments[0].keys())
    with open(cache_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(instruments)
    logger.info("Cached %d %s instruments to %s", len(instruments), exchange, cache_path)


# ---------------------------------------------------------------------------
# Kite 1-minute historical data (paper-session gap-fill only)
# ---------------------------------------------------------------------------

def _kite_1min_df_from_records(records: list[dict]) -> "pd.DataFrame":
    """Convert kite.historical_data() response to tz-naive IST DataFrame."""
    import pandas as pd
    rows = []
    for r in records:
        dt = r.get("date")
        if dt is None:
            continue
        # Kite returns IST datetimes; strip tz to keep tz-naive IST convention
        if hasattr(dt, "tzinfo") and dt.tzinfo is not None:
            dt = dt.replace(tzinfo=None)
        rows.append({
            "datetime": pd.Timestamp(dt),
            "open":   float(r.get("open",   0)),
            "high":   float(r.get("high",   0)),
            "low":    float(r.get("low",    0)),
            "close":  float(r.get("close",  0)),
            "volume": float(r.get("volume", 0)),
        })
    if not rows:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
    df = pd.DataFrame(rows).set_index("datetime").sort_index()
    return df[~df.index.duplicated(keep="first")]


def fetch_kite_1min(symbol: str, date: str) -> "pd.DataFrame":
    """
    Fetch Kite 1-minute equity OHLC for paper-session gap-filling.
    NOT used for simulation replay — simulation always uses Breeze 1-second data.

    Cache: data/ohlcdata/{SYMBOL}-{DD-MM-YYYY}-kite1m.parquet
      - Past days: cached permanently (complete day, no re-fetch).
      - Today: always re-fetches (near real-time data).

    Returns a DataFrame with tz-naive IST DatetimeIndex (same convention as
    Breeze data so tz_localize("UTC") yields correct IST-as-UTC timestamps).
    """
    import os
    import pandas as pd
    from datetime import date as _date
    from app.config import OHLCDATA_DIR, MARKET_OPEN, MARKET_CLOSE

    is_today = date == _date.today().strftime("%Y-%m-%d")
    y, m, d = date.split("-")
    OHLCDATA_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = OHLCDATA_DIR / f"{symbol}-{d}-{m}-{y}-kite1m.parquet"
    empty = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    if not is_today and cache_path.exists():
        try:
            df = pd.read_parquet(cache_path)
            if not df.empty:
                return df
        except Exception as exc:
            logger.warning("Kite 1-min equity cache unreadable for %s %s: %s", symbol, date, exc)

    try:
        kite = _get_kite()
        _, token = fetch_equity_instrument_token(symbol)
    except Exception as exc:
        logger.warning("Kite 1-min equity: cannot init for %s %s: %s", symbol, date, exc)
        return empty

    from_ts = pd.Timestamp(f"{date} {MARKET_OPEN}")
    to_ts = (
        pd.Timestamp.utcnow() + pd.Timedelta(hours=5, minutes=30)  # current IST
        if is_today else
        pd.Timestamp(f"{date} {MARKET_CLOSE}")
    )

    try:
        records = kite.historical_data(
            instrument_token=token,
            from_date=from_ts.to_pydatetime(),
            to_date=to_ts.to_pydatetime(),
            interval="minute",
            continuous=False,
            oi=False,
        )
    except Exception as exc:
        logger.warning("Kite 1-min equity fetch failed for %s %s: %s", symbol, date, exc)
        return empty

    df = _kite_1min_df_from_records(records or [])
    if df.empty:
        return empty

    try:
        tmp = cache_path.with_name(cache_path.name + ".tmp")
        df.to_parquet(tmp)
        os.replace(tmp, cache_path)
    except Exception as exc:
        logger.warning("Kite 1-min equity: cache write failed for %s %s: %s", symbol, date, exc)

    logger.info("Kite 1-min equity: %d candles for %s %s", len(df), symbol, date)
    return df


def fetch_kite_1min_options(symbol: str, date: str, strike: int, expiry: str, right: str) -> "pd.DataFrame":
    """
    Fetch Kite 1-minute options OHLC for paper-session gap-filling.
    Cache: data/ohlcdata/{SYMBOL}-{CE|PE}-{STRIKE}-{EXPIRY_COMPACT}-{DD-MM-YYYY}-kite1m.parquet
    Same caching rules as fetch_kite_1min.
    """
    import os
    import pandas as pd
    from datetime import date as _date
    from app.config import OHLCDATA_DIR, MARKET_OPEN, MARKET_CLOSE

    is_today = date == _date.today().strftime("%Y-%m-%d")
    y, m, d = date.split("-")
    expiry_compact = expiry.replace("-", "")
    OHLCDATA_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = OHLCDATA_DIR / f"{symbol}-{right}-{strike}-{expiry_compact}-{d}-{m}-{y}-kite1m.parquet"
    empty = pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    if not is_today and cache_path.exists():
        try:
            df = pd.read_parquet(cache_path)
            if not df.empty:
                return df
        except Exception as exc:
            logger.warning("Kite 1-min options cache unreadable for %s %s %s: %s", symbol, right, date, exc)

    try:
        kite = _get_kite()
        token = fetch_options_instrument_token(symbol, expiry, strike, right)
    except Exception as exc:
        logger.warning("Kite 1-min options: cannot get token for %s %s %s %s: %s",
                       symbol, right, strike, date, exc)
        return empty

    from_ts = pd.Timestamp(f"{date} {MARKET_OPEN}")
    to_ts = (
        pd.Timestamp.utcnow() + pd.Timedelta(hours=5, minutes=30)
        if is_today else
        pd.Timestamp(f"{date} {MARKET_CLOSE}")
    )

    try:
        records = kite.historical_data(
            instrument_token=token,
            from_date=from_ts.to_pydatetime(),
            to_date=to_ts.to_pydatetime(),
            interval="minute",
            continuous=False,
            oi=False,
        )
    except Exception as exc:
        logger.warning("Kite 1-min options fetch failed for %s %s %s %s: %s",
                       symbol, right, strike, date, exc)
        return empty

    df = _kite_1min_df_from_records(records or [])
    if df.empty:
        return empty

    try:
        tmp = cache_path.with_name(cache_path.name + ".tmp")
        df.to_parquet(tmp)
        os.replace(tmp, cache_path)
    except Exception as exc:
        logger.warning("Kite 1-min options: cache write failed: %s", exc)

    logger.info("Kite 1-min options: %d candles for %s %s %s %s", len(df), symbol, right, strike, date)
    return df


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
# KiteBroadcaster — module-level singleton
# ---------------------------------------------------------------------------

class KiteBroadcaster:
    """
    Single KiteTicker WebSocket shared by all active paper trading sessions.

    Each session registers a (paper_tick_queue, right, loop) per token.
    Completed 1-second OHLC candles are pushed to every registered queue via
    loop.call_soon_threadsafe so the asyncio event loop receives them safely
    from the KiteTicker background thread.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # instrument_token → {session_id: (queue, right, loop)}
        self._token_sessions: dict[int, dict[str, tuple]] = defaultdict(dict)
        # session_id → set[instrument_token]
        self._session_tokens: dict[str, set[int]] = defaultdict(set)
        # per-token OHLC accumulator
        self._accumulators: dict[int, _OHLCAccumulator] = defaultdict(_OHLCAccumulator)
        self._ticker = None
        self._connected = False
        # Restart guard: only one 403-triggered restart timer allowed at a time.
        # Generation bumps whenever the ticker is replaced so stale timers no-op.
        self._restart_pending = False
        self._restart_generation = 0

    def register(
        self,
        session_id: str,
        tokens: list[int],
        rights: list[str | None],
        queue: asyncio.Queue,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        """
        Register a session for the given instrument tokens.
        rights[i] is "CE", "PE", or None for tokens[i].
        Starts KiteTicker if not running; otherwise extends subscription.
        Raises KiteTokenError / KiteConnectionError on failure.
        """
        with self._lock:
            for token, right in zip(tokens, rights):
                self._token_sessions[token][session_id] = (queue, right, loop)
                self._session_tokens[session_id].add(token)
            new_tokens = list(tokens)

        if not self._connected:
            self._start(new_tokens)
        else:
            self._subscribe_more(new_tokens)

    def unregister(self, session_id: str) -> None:
        """Remove session; unsubscribes tokens with no remaining subscribers."""
        with self._lock:
            owned = self._session_tokens.pop(session_id, set())
            orphaned = []
            for token in owned:
                self._token_sessions[token].pop(session_id, None)
                if not self._token_sessions[token]:
                    del self._token_sessions[token]
                    orphaned.append(token)

            if orphaned and self._ticker:
                try:
                    self._ticker.unsubscribe(orphaned)
                except Exception as exc:
                    logger.warning("Kite unsubscribe error: %s", exc)

            if not any(self._token_sessions.values()) and self._ticker:
                try:
                    self._ticker.close()
                except Exception:
                    pass
                self._ticker = None
                self._connected = False
                # Invalidate any pending restart timer so it doesn't fire after a
                # new session starts and replaces the ticker with a fresh one.
                self._restart_generation += 1
                self._restart_pending = False
                logger.info("KiteBroadcaster: no active sessions, ticker stopped")

    def update_session_right(
        self,
        session_id: str,
        right: str,
        new_token: int,
        queue: "asyncio.Queue",
        loop: "asyncio.AbstractEventLoop",
    ) -> None:
        """
        Replace the instrument token for a given right (CE/PE) in an active session.
        Called when the user removes a pane and adds a new one with a different strike
        mid-session so live ticks stream from the new strike instead of the old one.
        No-op if the session has not yet entered Phase 2 (broadcaster will use the
        already-updated session.strike_ce/pe when it registers).
        """
        orphaned: list[int] = []
        with self._lock:
            if session_id not in self._session_tokens:
                return

            # Find the old token registered for this session + right
            old_token: int | None = None
            for token in list(self._session_tokens[session_id]):
                entry = self._token_sessions.get(token, {}).get(session_id)
                if entry and entry[1] == right:
                    old_token = token
                    break

            if old_token is not None and old_token != new_token:
                self._token_sessions[old_token].pop(session_id, None)
                self._session_tokens[session_id].discard(old_token)
                if not self._token_sessions.get(old_token):
                    self._token_sessions.pop(old_token, None)
                    orphaned.append(old_token)

            self._token_sessions[new_token][session_id] = (queue, right, loop)
            self._session_tokens[session_id].add(new_token)

        if orphaned and self._ticker:
            try:
                self._ticker.unsubscribe(orphaned)
            except Exception as exc:
                logger.warning("KiteBroadcaster unsubscribe error on strike change: %s", exc)

        self._subscribe_more([new_token])
        logger.info(
            "KiteBroadcaster: session %s right=%s token updated (old=%s new=%s)",
            session_id, right, orphaned[0] if orphaned else "none", new_token,
        )

    def _start(self, tokens: list[int]) -> None:
        try:
            from kiteconnect import KiteTicker
        except ImportError as exc:
            raise KiteConnectionError("kiteconnect not installed") from exc

        # Bump generation before creating the ticker so any 403-retry timer that
        # was scheduled for the previous ticker becomes stale and will no-op.
        with self._lock:
            self._restart_generation += 1
            self._restart_pending = False

        cfg = self._read_config()
        ticker = KiteTicker(cfg["api_key"], cfg["access_token"])
        ticker.on_connect = self._on_connect
        ticker.on_ticks = self._on_ticks
        ticker.on_error = self._on_error
        ticker.on_close = self._on_close
        ticker.connect(threaded=True)
        self._ticker = ticker
        self._connected = True
        _time.sleep(1.0)  # allow websocket handshake to complete
        logger.info("KiteBroadcaster started")

    def _subscribe_more(self, tokens: list[int]) -> None:
        if self._ticker:
            try:
                self._ticker.subscribe(tokens)
                self._ticker.set_mode(self._ticker.MODE_LTP, tokens)
            except Exception as exc:
                logger.warning("KiteBroadcaster subscribe_more error: %s", exc)

    def _read_config(self) -> dict:
        from app.config import DATA_DIR
        cfg = configparser.ConfigParser()
        cfg.read(str(DATA_DIR / "accesskeys.ini"))
        if "kite" not in cfg:
            raise KiteTokenError("No [kite] section in data/accesskeys.ini")
        api_key = cfg["kite"].get("api_key", "").strip()
        access_token = cfg["kite"].get("access_token", "").strip()
        # DDB override: daily-rotating token set via Admin panel takes precedence.
        try:
            from app.services.token_service import get_token as _ddb_token
            ddb = _ddb_token("kite_access")
            if ddb:
                access_token = ddb
        except Exception:
            pass
        if not api_key or not access_token:
            raise KiteTokenError("Kite api_key or access_token missing")
        return {"api_key": api_key, "access_token": access_token}

    def _notify_sessions_error(self, message: str) -> None:
        """Push a broker_error dict to every registered session's paper_tick_queue."""
        with self._lock:
            entries = {
                sid: (queue, loop)
                for token_map in self._token_sessions.values()
                for sid, (queue, _right, loop) in token_map.items()
            }
        payload = {"type": "broker_error", "message": message}
        for sid, (queue, loop) in entries.items():
            try:
                loop.call_soon_threadsafe(queue.put_nowait, payload)
            except Exception:
                pass

    def _restart_with_fresh_creds(self, gen: int) -> None:
        """Re-create the KiteTicker with fresh credentials (reads DDB token)."""
        with self._lock:
            if gen != self._restart_generation:
                # A newer ticker was already created (new session registered, or
                # unregister closed the ticker) — this timer is stale, skip.
                return
            if not self._token_sessions:
                self._restart_pending = False
                return
            all_tokens = list(self._token_sessions.keys())
            old_ticker = self._ticker
            self._ticker = None
        if old_ticker:
            try:
                old_ticker.close()
            except Exception:
                pass
        try:
            self._start(all_tokens)  # bumps _restart_generation, clears _restart_pending
            logger.info("KiteBroadcaster: reconnected with fresh credentials (%d tokens)", len(all_tokens))
        except Exception as exc:
            with self._lock:
                self._restart_pending = False
            logger.error("KiteBroadcaster: reconnect failed: %s", exc)
            self._notify_sessions_error(
                f"Kite reconnect failed — update token in Admin settings: {exc}"
            )

    def _on_connect(self, ws, response) -> None:
        with self._lock:
            all_tokens = list(self._token_sessions.keys())
        logger.info("KiteBroadcaster: WebSocket connected, subscribing %d tokens: %s", len(all_tokens), all_tokens)
        if all_tokens and ws:
            try:
                ws.subscribe(all_tokens)
                ws.set_mode(ws.MODE_LTP, all_tokens)
                logger.info("KiteBroadcaster: subscribed %d tokens in LTP mode", len(all_tokens))
            except Exception as exc:
                logger.error("KiteBroadcaster on_connect subscribe error: %s", exc)

    def _on_ticks(self, ws, ticks) -> None:
        # IST offset: our convention stores IST wall-clock times as fake-UTC
        # (tz_localize("UTC") on IST naive datetimes).  Kite's exchange_timestamp
        # is a naive datetime in UTC (from gmtime).  To match the convention we
        # add 19800 s (5:30 h) so that "09:15 IST" maps to Unix-for-"09:15 UTC".
        _IST_OFFSET = 19800
        if not ticks:
            return
        if not getattr(self, '_ticks_logged', False):
            logger.info("KiteBroadcaster: first tick batch received (%d ticks)", len(ticks))
            self._ticks_logged = True

        for tick in ticks:
            token = tick.get("instrument_token")
            if token is None:
                continue
            price = float(tick.get("last_price", 0.0))
            if price == 0.0:
                continue
            ex_ts = tick.get("exchange_timestamp")
            if ex_ts and isinstance(ex_ts, datetime):
                # exchange_timestamp is naive UTC from kiteconnect gmtime — add IST offset
                ts_second = int(ex_ts.timestamp()) + _IST_OFFSET
            else:
                ts_second = int(_time.time()) + _IST_OFFSET

            candle = self._accumulators[token].update(price, ts_second)
            if candle is None:
                continue

            with self._lock:
                session_map = dict(self._token_sessions.get(token, {}))

            for session_id, (queue, right, loop) in session_map.items():
                payload = {**candle}
                if right:
                    payload["right"] = right
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, payload)
                except Exception as exc:
                    logger.warning("Tick push failed for session %s: %s", session_id, exc)

    def _on_error(self, ws, code, reason) -> None:
        logger.error("KiteTicker error — code=%s reason=%s", code, reason)
        # 403 on WebSocket upgrade = auth issue or concurrent connection limit.
        # kiteconnect keeps retrying with the same stale token; schedule a single
        # restart that re-reads credentials from DDB before reconnecting.
        if "403" in str(reason) or "Forbidden" in str(reason):
            with self._lock:
                if self._restart_pending:
                    return  # timer already queued — don't stack another one
                self._restart_pending = True
                gen = self._restart_generation
            threading.Timer(5.0, lambda: self._restart_with_fresh_creds(gen)).start()

    def _on_close(self, ws, code, reason) -> None:
        logger.warning("KiteTicker closed — code=%s reason=%s", code, reason)
        self._connected = False
        self._notify_sessions_error(
            "Kite connection lost — attempting to reconnect. Ticks may be delayed."
        )


_broadcaster: KiteBroadcaster | None = None
_broadcaster_lock = threading.Lock()


def get_broadcaster() -> KiteBroadcaster:
    global _broadcaster
    if _broadcaster is None:
        with _broadcaster_lock:
            if _broadcaster is None:
                _broadcaster = KiteBroadcaster()
    return _broadcaster


# ---------------------------------------------------------------------------
# BreezeStreamManager — per-session fallback
# ---------------------------------------------------------------------------

class BreezeStreamManager:
    """
    Fallback live feed via ICICI Direct (Breeze) WebSocket when Kite is unavailable.
    One instance per paper session. Aggregates LTP events → 1-second OHLC dicts
    and pushes them to session.paper_tick_queue via call_soon_threadsafe.
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
        breeze.on_ticks.append(self._on_ticks)
        breeze.ws_connect()

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
        for tick in ticks:
            try:
                price = float(tick.get("last", tick.get("ltp", 0.0)))
                right_raw = tick.get("right", "")
                right = right_raw.upper() if right_raw and right_raw.upper() in ("CE", "PE") else None
                key = f"{tick.get('stock_code', '')}_{right or 'EQ'}"
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
