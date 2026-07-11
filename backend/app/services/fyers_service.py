"""
Fyers live streaming service for paper trading.

Architecture:
  FyersBroadcaster (singleton) manages one FyersDataSocket WebSocket connection.
  Multiple paper-trading sessions register their paper_tick_queue; incoming
  LTP ticks are aggregated into 1-second OHLC dicts and fan-out to each queue.
  The paper session loop reads from paper_tick_queue, calls
  _emit_tick_and_check_orders (which writes to session.queue for SSE), so the
  same order/strategy evaluation path as sim mode is reused unchanged.
"""
from __future__ import annotations

import asyncio
import configparser
import logging
import threading
import time as _time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------

class FyersTokenError(Exception):
    """Fyers access token is missing, invalid, or expired."""


class FyersConnectionError(Exception):
    """Fyers WebSocket failed to connect."""


# ---------------------------------------------------------------------------
# Symbol name mapping
# ---------------------------------------------------------------------------

_FYERS_SYMBOL_INFO: dict[str, dict] = {
    "NIFTY":  {"name": "NIFTY",   "exchange": "NSE", "is_index": True},
    "BSESEN": {"name": "SENSEX",  "exchange": "BSE", "is_index": True},
    "TATPOW": {"name": "TATPOWER","exchange": "NSE", "is_index": False},
    "TATMOT": {"name": "TMCV",    "exchange": "NSE", "is_index": False},
    "RELIND": {"name": "RELIANCE","exchange": "NSE", "is_index": False},
}

_MONTH_ABBR = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
]


def _fyers_equity_symbol(symbol_key: str) -> str:
    info = _FYERS_SYMBOL_INFO.get(symbol_key)
    if info:
        return f"{info['exchange']}:{info['name']}-EQ"
    return f"NSE:{symbol_key}-EQ"


def _fyers_index_symbol(symbol_key: str) -> str:
    info = _FYERS_SYMBOL_INFO.get(symbol_key)
    if info is None:
        raise ValueError(f"Unknown symbol: {symbol_key}")
    name = info["name"]
    exchange = info["exchange"]
    if symbol_key == "NIFTY":
        return f"{exchange}:{name}50-INDEX"
    return f"{exchange}:{name}-INDEX"


def _fyers_options_symbol(symbol_key: str, expiry: str, strike: int, right: str) -> str:
    info = _FYERS_SYMBOL_INFO.get(symbol_key)
    if info is None:
        raise ValueError(f"Unknown symbol: {symbol_key}")
    try:
        dt = datetime.strptime(expiry, "%Y-%m-%d")
        day = f"{dt.day:02d}"
        month = _MONTH_ABBR[dt.month - 1]
    except ValueError:
        raise ValueError(f"Invalid expiry date format: {expiry}")
    return f"{info['exchange']}:{info['name']}{day}{month}{int(strike)}{right.upper()}"


def resolve_fyers_symbols(session) -> tuple[list[str], list[str | None]]:
    """
    Build the list of Fyers symbols and corresponding rights for a session.
    Returns (symbols, rights) where rights[i] is "CE", "PE", or None.
    """
    from app.config import SUPPORTED_SYMBOLS
    sym_info = SUPPORTED_SYMBOLS.get(session.symbol, {})
    symbols: list[str] = []
    rights: list[str | None] = []

    if sym_info.get("options_only"):
        symbols.append(_fyers_index_symbol(session.symbol))
        rights.append(None)
    else:
        symbols.append(_fyers_equity_symbol(session.symbol))
        rights.append(None)

    if session.instrument_type == "options" and session.expiry:
        ce_strike = session.strike_ce or session.strike
        pe_strike = session.strike_pe or session.strike
        if session.right in (None, "CE") and ce_strike:
            symbols.append(_fyers_options_symbol(session.symbol, session.expiry, ce_strike, "CE"))
            rights.append("CE")
        if session.right in (None, "PE") and pe_strike:
            symbols.append(_fyers_options_symbol(session.symbol, session.expiry, pe_strike, "PE"))
            rights.append("PE")

    return symbols, rights


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
# FyersBroadcaster — module-level singleton
# ---------------------------------------------------------------------------

class FyersBroadcaster:
    """
    Single FyersDataSocket WebSocket shared by all active paper trading sessions.

    Each session registers a (paper_tick_queue, right, loop) per symbol.
    Completed 1-second OHLC candles are pushed to every registered queue via
    loop.call_soon_threadsafe so the asyncio event loop receives them safely
    from the FyersDataSocket background thread.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # fyers_symbol → {session_id: (queue, right, loop)}
        self._symbol_sessions: dict[str, dict[str, tuple]] = defaultdict(dict)
        # session_id → set[fyers_symbol]
        self._session_symbols: dict[str, set[str]] = defaultdict(set)
        # per-symbol OHLC accumulator
        self._accumulators: dict[str, _OHLCAccumulator] = defaultdict(_OHLCAccumulator)
        self._fyers = None
        self._connected = False

    # ── public API ────────────────────────────────────────────────────────

    def register(
        self,
        session_id: str,
        symbols: list[str],
        rights: list[str | None],
        queue: asyncio.Queue,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        with self._lock:
            for sym, right in zip(symbols, rights):
                self._symbol_sessions[sym][session_id] = (queue, right, loop)
                self._session_symbols[session_id].add(sym)
            new_symbols = list(symbols)

        if self._fyers is None:
            self._start(new_symbols)
        elif self._connected:
            self._subscribe_more(new_symbols)

    def unregister(self, session_id: str) -> None:
        with self._lock:
            owned = self._session_symbols.pop(session_id, set())
            orphaned = []
            for sym in owned:
                self._symbol_sessions[sym].pop(session_id, None)
                if not self._symbol_sessions[sym]:
                    del self._symbol_sessions[sym]
                    orphaned.append(sym)

            if orphaned and self._fyers:
                try:
                    self._fyers.unsubscribe(orphaned)
                except Exception as exc:
                    logger.warning("Fyers unsubscribe error: %s", exc)

            if not any(self._symbol_sessions.values()) and self._fyers:
                try:
                    self._fyers.close_connection()
                except Exception:
                    pass
                self._fyers = None
                self._connected = False
                logger.info("FyersBroadcaster: no active sessions, ticker stopped")

    # ── internal ──────────────────────────────────────────────────────────

    def _read_config(self) -> dict:
        from app.config import DATA_DIR
        cfg = configparser.ConfigParser()
        cfg.read(str(DATA_DIR / "accesskeys.ini"))
        if "fyers" not in cfg:
            raise FyersTokenError("No [fyers] section in data/accesskeys.ini")
        app_id = cfg["fyers"].get("app_id", "").strip()
        access_token = cfg["fyers"].get("access_token", "").strip()

        try:
            from app.services.token_service import get_token as _ddb_token
            ddb = _ddb_token("fyers_access")
            if ddb:
                access_token = ddb
        except Exception:
            pass

        if not app_id or not access_token:
            raise FyersTokenError("Fyers app_id or access_token missing")
        return {"app_id": app_id, "access_token": access_token}

    def _start(self, symbols: list[str]) -> None:
        try:
            from fyers_apiv3 import data_ws  # noqa: F811
        except ImportError as exc:
            raise FyersConnectionError(
                "fyers-apiv3 package not installed. Run: pip install fyers-apiv3"
            ) from exc

        cfg = self._read_config()
        access_token_str = f"{cfg['app_id']}:{cfg['access_token']}"

        with self._lock:
            old_fyers = self._fyers
            self._fyers = None
        if old_fyers:
            try:
                old_fyers.close_connection()
            except Exception:
                pass

        fyers = data_ws.FyersDataSocket(
            access_token=access_token_str,
            log_path="",
            litemode=False,
            write_to_file=False,
            reconnect=True,
            on_connect=self._on_connect,
            on_close=self._on_close,
            on_error=self._on_error,
            on_message=self._on_message,
        )

        with self._lock:
            self._fyers = fyers
        fyers.connect()
        _time.sleep(1.0)
        logger.info("FyersBroadcaster started")

    def _subscribe_more(self, symbols: list[str]) -> None:
        if self._fyers and self._connected:
            try:
                self._fyers.subscribe(symbols)
                self._fyers.mode(self._fyers.MODE_LTP)
            except Exception as exc:
                logger.warning("FyersBroadcaster subscribe_more error: %s", exc)

    def _notify_sessions_error(self, message: str) -> None:
        with self._lock:
            entries = {
                sid: (queue, loop)
                for sym_map in self._symbol_sessions.values()
                for sid, (queue, _right, loop) in sym_map.items()
            }
        payload = {"type": "broker_error", "message": message}
        for sid, (queue, loop) in entries.items():
            try:
                loop.call_soon_threadsafe(queue.put_nowait, payload)
            except Exception:
                pass

    # ── WebSocket callbacks ──────────────────────────────────────────────

    def _on_connect(self, ws, response=None) -> None:
        with self._lock:
            self._connected = True
            all_symbols = list(self._symbol_sessions.keys())
        logger.info(
            "FyersBroadcaster: WebSocket connected, subscribing %d symbols",
            len(all_symbols),
        )
        if all_symbols and ws:
            try:
                ws.subscribe(all_symbols)
                ws.mode(ws.MODE_LTP)
                logger.info(
                    "FyersBroadcaster: subscribed %d symbols in LTP mode",
                    len(all_symbols),
                )
            except Exception as exc:
                logger.error("FyersBroadcaster on_connect subscribe error: %s", exc)

    def _on_message(self, ws, message) -> None:
        _IST_OFFSET = 19800
        if not message:
            return
        # message is a dict like:
        #   {'ltp': 108.65, 'exch_feed_time': 1703757600, 'symbol': 'NSE:BANKNIFTY23DEC48400CE', ...}
        symbol = message.get("symbol")
        if not symbol:
            return
        ltp = message.get("ltp")
        if ltp is None:
            return
        price = float(ltp)
        if price == 0.0:
            return

        exch_feed_time = message.get("exch_feed_time")
        if exch_feed_time:
            # exch_feed_time is a UTC Unix epoch; add IST offset to match
            # our tz_localize("UTC") convention
            ts_second = int(exch_feed_time) + _IST_OFFSET
        else:
            ts_second = int(_time.time()) + _IST_OFFSET

        candle = self._accumulators[symbol].update(price, ts_second)
        if candle is None:
            return

        with self._lock:
            session_map = dict(self._symbol_sessions.get(symbol, {}))

        for session_id, (queue, right, loop) in session_map.items():
            payload = {**candle}
            if right:
                payload["right"] = right
            try:
                loop.call_soon_threadsafe(queue.put_nowait, payload)
            except Exception as exc:
                logger.warning(
                    "Fyers tick push failed for session %s: %s", session_id, exc,
                )

    def _on_close(self, ws, code=None, reason=None) -> None:
        logger.warning("FyersDataSocket closed — code=%s reason=%s", code, reason)
        self._connected = False
        self._notify_sessions_error(
            "Fyers connection lost — attempting to reconnect. Ticks may be delayed."
        )

    def _on_error(self, ws, code=None, reason=None) -> None:
        logger.error("FyersDataSocket error — code=%s reason=%s", code, reason)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_broadcaster: FyersBroadcaster | None = None
_broadcaster_lock = threading.Lock()


def get_fyers_broadcaster() -> FyersBroadcaster:
    global _broadcaster
    if _broadcaster is None:
        with _broadcaster_lock:
            if _broadcaster is None:
                _broadcaster = FyersBroadcaster()
    return _broadcaster
