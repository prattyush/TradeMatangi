"""
Kotak Neo broker integration for real trading.

Architecture:
  KotakNeoService is a module-level singleton wrapping neo_api_client.NeoAPI.
  Authentication requires a TOTP (time-based OTP) provided by the user at
  login time. Once authenticated the order-feed WebSocket is set up so that
  fill callbacks registered per kotak_order_id are dispatched when Kotak
  confirms an order fill.

Credentials read from data/accesskeys.ini [kotakneo]:
  access_token   — consumer key from Kotak Neo developer portal
  mobile         — registered mobile number
  ucc            — UCC / client code
  mpin           — MPIN

Order routing in real sessions:
  - STOPLOSS orders  → placed directly on Kotak as SL orders at placement time
  - LIMIT / TARGET   → simulated locally; on trigger → placed on Kotak as limit
  - TradePanel BUY   → Kotak LIMIT at LTP × (1 + KOTAK_SLIPPAGE_PCT)
  - TradePanel SELL  → Kotak LIMIT at LTP × (1 − KOTAK_SLIPPAGE_PCT)

Options trading symbol format (Kotak / NSE-BSE convention):
  Monthly expiry (last weekday occurrence of month): {BASE}{YY}{MON3}{STRIKE}{RIGHT}
    e.g. NIFTY26MAY23500PE, SENSEX26MAY76000CE
  Weekly non-monthly: {BASE}{YY}{M_DIGITS}{DD}{STRIKE}{RIGHT}
    e.g. NIFTY2660223500PE (June-2), SENSEX2660476000CE (June-4)
    Month Jan-Sep = single digit; Oct-Dec = two digits (10/11/12).
"""
from __future__ import annotations

import asyncio
import configparser
import json
import logging
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Callable

logger = logging.getLogger(__name__)

# IST offset in seconds (5h 30min) — same convention as kite_service.py:
# exchange timestamps are treated as IST wall-clock encoded as fake-UTC so
# Lightweight Charts displays 09:15 instead of 03:45.
_IST_OFFSET = 19800

# Kotak instrument master file cache TTL (24 hours).
_INSTRUMENTS_CACHE_TTL_SECS = 86400

# NSE/BSE minimum tick size is ₹0.05 (5 paise). Kotak rejects prices that are
# not multiples of this value.
_TICK_SIZE = 0.05


def _round_to_tick(price: float) -> float:
    """Round price to the nearest ₹0.05 tick."""
    return round(round(price / _TICK_SIZE) * _TICK_SIZE, 2)


# ---------------------------------------------------------------------------
# Options trading symbol helpers
# ---------------------------------------------------------------------------

def _is_monthly_expiry(expiry_dt: date, symbol: str) -> bool:
    """True if expiry_dt is the last occurrence of the expiry weekday in its month."""
    return (expiry_dt + timedelta(days=7)).month != expiry_dt.month


def _build_options_trading_symbol(base: str, expiry: str, strike: int, right: str, symbol: str) -> str:
    """
    Construct the Kotak / NSE-BSE options trading symbol string.

    Monthly expiry  → {BASE}{YY}{MON3}{STRIKE}{RIGHT}  e.g. NIFTY26MAY23500PE
    Weekly non-monthly → {BASE}{YY}{M}{DD}{STRIKE}{RIGHT}  e.g. NIFTY2660223500PE
    Oct/Nov/Dec month part uses two digits (10/11/12).
    """
    expiry_dt = datetime.strptime(expiry, "%Y-%m-%d").date()
    yy = expiry_dt.strftime("%y")          # "26"
    if _is_monthly_expiry(expiry_dt, symbol):
        month_part = expiry_dt.strftime("%b").upper()   # "MAY", "OCT", …
    else:
        m = expiry_dt.month
        dd = expiry_dt.strftime("%d")                   # "02", "14", …
        month_part = f"{m}{dd}"                         # "602", "1001", …
    return f"{base}{yy}{month_part}{strike}{right}"


class KotakError(Exception):
    """Raised when Kotak Neo API returns an error or is misconfigured."""


# ---------------------------------------------------------------------------
# Instrument master cache helpers
# ---------------------------------------------------------------------------

def _get_instruments_cache_path():
    from app.config import DATA_DIR
    return DATA_DIR / "kotak_instruments.json"


def _load_kotak_master_from_api() -> list[dict]:
    """
    Download the Kotak Neo instrument master via neo_api_client and cache to disk.

    Uses client.scrip_master(exchange_segment=seg) which returns a CSV URL string.
    Downloads each CSV and parses it; normalises into stable dicts.
    Returns normalised list of {instrument_token, symbol, exchange, name} dicts.
    Called lazily when the cache is missing or stale.
    """
    import csv
    import urllib.request

    try:
        client = _service._get_client()
    except KotakError as exc:
        logger.error("KotakBroadcaster: cannot download master — Kotak not authenticated: %s", exc)
        return []

    segments = ["nse_cm", "nse_fo", "bse_fo"]
    normalized: list[dict] = []

    for seg in segments:
        logger.info("KotakBroadcaster: fetching scrip master URL for segment %s …", seg)
        try:
            url = client.scrip_master(exchange_segment=seg)
            if not isinstance(url, str) or not url.startswith("http"):
                logger.warning(
                    "KotakBroadcaster: scrip_master(%s) returned unexpected value: %r — skipping",
                    seg, url,
                )
                continue

            logger.info("KotakBroadcaster: downloading master CSV for %s from %s", seg, url)
            req = urllib.request.Request(url, headers={"User-Agent": "TradeMatangi/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                content = resp.read().decode("utf-8", errors="replace")

            reader = csv.DictReader(content.splitlines())
            count = 0
            for row in reader:
                # Kotak scrip master CSV column names (pSymbol = numeric token,
                # pTrdSymbol = trading symbol used in place_order, pExchSeg = exchange).
                token = str(
                    row.get("pSymbol") or row.get("pScrip") or
                    row.get("instrument_token") or row.get("token") or ""
                ).strip()
                symbol = str(
                    row.get("pTrdSymbol") or row.get("trdSym") or
                    row.get("dScrip") or row.get("symbol") or ""
                ).strip()
                exchange = str(
                    row.get("pExchSeg") or row.get("exSeg") or
                    row.get("exchange_segment") or seg
                ).strip()
                name = str(
                    row.get("pSymbolName") or row.get("sym") or
                    row.get("cname") or row.get("company_name") or ""
                ).strip()
                inst_type = str(
                    row.get("pInstType") or row.get("instType") or
                    row.get("instrument_type") or ""
                ).strip()
                if token and symbol:
                    normalized.append({
                        "instrument_token": token,
                        "symbol": symbol,
                        "exchange": exchange,
                        "name": name,
                        "instrument_type": inst_type,
                    })
                    count += 1
            logger.info(
                "KotakBroadcaster: parsed %d instruments from %s master CSV", count, seg
            )
        except Exception as exc:
            logger.error(
                "KotakBroadcaster: failed to download/parse master for segment %s: %s", seg, exc
            )

    logger.info("KotakBroadcaster: total %d instruments across all segments", len(normalized))

    if not normalized:
        return []

    cache_path = _get_instruments_cache_path()
    try:
        import os
        tmp = str(cache_path) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(normalized, f)
        os.replace(tmp, cache_path)
        logger.info("KotakBroadcaster: cached instruments to %s", cache_path)
    except Exception as e:
        logger.warning("KotakBroadcaster: cache write failed: %s", e)

    return normalized


def _get_kotak_instruments() -> list[dict]:
    """
    Return cached Kotak Neo instrument master, refreshing from API if stale (> 24h).
    Returns an empty list when Kotak is not authenticated and no cache exists.
    """
    cache_path = _get_instruments_cache_path()
    if cache_path.exists():
        age = time.time() - cache_path.stat().st_mtime
        if age < _INSTRUMENTS_CACHE_TTL_SECS:
            try:
                with open(cache_path) as f:
                    instruments = json.load(f)
                logger.debug(
                    "KotakBroadcaster: loaded %d instruments from cache (age=%.0fs)",
                    len(instruments), age,
                )
                return instruments
            except Exception as e:
                logger.warning("KotakBroadcaster: cache read failed, re-downloading: %s", e)

    logger.info(
        "KotakBroadcaster: instrument cache missing or stale (%.0fs old), downloading …",
        time.time() - cache_path.stat().st_mtime if cache_path.exists() else -1,
    )
    return _load_kotak_master_from_api()


def fetch_kotak_equity_instrument_token(symbol: str) -> tuple[str, str]:
    """
    Return (instrument_token, exchange_segment) for the equity / index instrument.
    Used by KotakBroadcaster to subscribe to live price feed.
    Raises KotakError if the token cannot be resolved.
    """
    if symbol not in _SYMBOL_MAP:
        raise KotakError(f"Symbol '{symbol}' not configured for Kotak Neo streaming")

    kotak_sym, exchange_seg = _SYMBOL_MAP[symbol]
    instruments = _get_kotak_instruments()

    if not instruments:
        raise KotakError(
            f"Kotak Neo instrument master is empty. "
            f"Ensure Kotak Neo is authenticated and re-try."
        )

    # Exact match first
    matches = [
        inst for inst in instruments
        if inst["symbol"] == kotak_sym and inst["exchange"] == exchange_seg
    ]
    # Partial fallback
    if not matches:
        matches = [
            inst for inst in instruments
            if kotak_sym.upper() in inst["symbol"].upper() and inst["exchange"] == exchange_seg
        ]

    if not matches:
        raise KotakError(
            f"Instrument token not found for {symbol} "
            f"(kotak_sym={kotak_sym!r}, exchange={exchange_seg!r}) "
            f"in Kotak master ({len(instruments)} instruments)"
        )

    token = matches[0]["instrument_token"]
    if not token:
        raise KotakError(
            f"Instrument token is blank for {symbol} (kotak_sym={kotak_sym!r}); "
            f"master data may be malformed"
        )

    logger.info(
        "KotakBroadcaster: resolved %s → token=%s exchange=%s",
        symbol, token, exchange_seg,
    )
    return token, exchange_seg


def fetch_kotak_options_instrument_token(
    symbol: str,
    expiry: str,
    strike: int,
    right: str,
) -> tuple[str, str]:
    """
    Return (instrument_token, exchange_segment) for an options contract.
    expiry: "YYYY-MM-DD", right: "CE" or "PE".
    Raises KotakError if not found in master.
    """
    from app.config import SUPPORTED_SYMBOLS
    sym_info = SUPPORTED_SYMBOLS.get(symbol, {})
    exchange_seg = "bse_fo" if sym_info.get("options_exchange_code") == "BFO" else "nse_fo"
    base = "SENSEX" if symbol == "BSESEN" else symbol

    kotak_sym = _build_options_trading_symbol(base, expiry, strike, right, symbol)
    instruments = _get_kotak_instruments()

    if not instruments:
        raise KotakError(
            f"Kotak Neo instrument master is empty — cannot resolve options token for {kotak_sym}"
        )

    matches = [
        inst for inst in instruments
        if inst["symbol"] == kotak_sym and inst["exchange"] == exchange_seg
    ]

    if not matches:
        raise KotakError(
            f"Options token not found for {kotak_sym} ({exchange_seg}) "
            f"in Kotak master ({len(instruments)} instruments)"
        )

    token = matches[0]["instrument_token"]
    logger.info(
        "KotakBroadcaster: resolved options %s → token=%s exchange=%s",
        kotak_sym, token, exchange_seg,
    )
    return token, exchange_seg


# ---------------------------------------------------------------------------
# Credential helpers
# ---------------------------------------------------------------------------

def _read_kotak_credentials() -> dict[str, str]:
    from app.config import DATA_DIR
    cfg = configparser.ConfigParser()
    cfg.read(str(DATA_DIR / "accesskeys.ini"))
    if "kotakneo" not in cfg:
        raise KotakError("No [kotakneo] section in data/accesskeys.ini")
    section = cfg["kotakneo"]
    return {
        "access_token": section.get("access_token", "").strip(),
        "mobile": section.get("mobile", "").strip(),
        "ucc": section.get("ucc", "").strip(),
        "mpin": section.get("mpin", "").strip(),
    }


# ---------------------------------------------------------------------------
# Symbol mapping: our canonical key → (kotak_trading_symbol, exchange_segment)
# ---------------------------------------------------------------------------

_SYMBOL_MAP: dict[str, tuple[str, str]] = {
    "NIFTY":  ("NIFTY",          "nse_fo"),
    "BSESEN": ("SENSEX",         "bse_fo"),
    "TATPOW": ("TATPOWER-EQ",    "nse_cm"),
    "TATMOT": ("TMCV-EQ",        "nse_cm"),   # renamed from TATAMOTORS after Apr-2025 CV/PV demerger; -EQ suffix required by Kotak Neo for nse_cm equity
    "RELIND": ("RELIANCE-EQ",    "nse_cm"),
}


# ---------------------------------------------------------------------------
# Main service class
# ---------------------------------------------------------------------------

class KotakNeoService:
    """Thread-safe singleton wrapping neo_api_client.NeoAPI."""

    def __init__(self) -> None:
        self._client: Any = None
        self._authenticated = False
        self._lock = threading.Lock()
        # kotak_order_id → (callback, asyncio_loop)
        self._fill_callbacks: dict[str, tuple[Callable, Any]] = {}
        self._reject_callbacks: dict[str, tuple[Callable, Any]] = {}
        # KotakBroadcaster registers here to receive stock_feed messages
        self._market_data_callback: Callable | None = None

    # ── Authentication ────────────────────────────────────────────────────────

    def login_with_totp(self, totp: str) -> None:
        """
        Authenticate with Kotak Neo using a TOTP code.
        Raises KotakError with the exact error message on any failure.
        """
        try:
            from neo_api_client import NeoAPI  # type: ignore[import]
        except ImportError:
            raise KotakError(
                "neo_api_client package not installed. "
                "Run: pip install neo_api_client"
            )

        creds = _read_kotak_credentials()
        for key in ("access_token", "mobile", "ucc", "mpin"):
            if not creds[key]:
                raise KotakError(
                    f"Kotak Neo '{key}' missing in data/accesskeys.ini [kotakneo]"
                )

        with self._lock:
            try:
                client = NeoAPI(
                    environment="prod",
                    access_token=None,
                    neo_fin_key=None,
                    consumer_key=creds["access_token"],
                )
                client.totp_login(
                    mobile_number=creds["mobile"],
                    ucc=creds["ucc"],
                    totp=totp,
                )
                client.totp_validate(mpin=creds["mpin"])
                self._client = client
                self._authenticated = True
                logger.info("Kotak Neo authenticated successfully")
                self._start_order_feed()
            except KotakError:
                raise
            except Exception as exc:
                self._authenticated = False
                self._client = None
                raise KotakError(str(exc)) from exc

    def is_authenticated(self) -> bool:
        with self._lock:
            return self._authenticated

    def _get_client(self) -> Any:
        with self._lock:
            if not self._authenticated or self._client is None:
                raise KotakError(
                    "Not authenticated with Kotak Neo — TOTP login required"
                )
            return self._client

    # ── Order placement ───────────────────────────────────────────────────────

    def place_limit_order(
        self,
        symbol: str,
        side: str,    # "B" (buy) or "S" (sell)
        qty: int,
        price: float,
    ) -> str:
        """Place a limit order. Returns the Kotak order ID (nOrdNo)."""
        client = self._get_client()
        kotak_sym, exchange_seg = self._resolve_symbol(symbol)
        try:
            resp = client.place_order(
                exchange_segment=exchange_seg,
                product="MIS",
                price=str(_round_to_tick(price)),
                order_type="L",
                quantity=str(qty),
                validity="DAY",
                trading_symbol=kotak_sym,
                transaction_type=side,
                amo="NO",
                disclosed_quantity="0",
                market_protection="0",
                pf="N",
                trigger_price="0",
                tag=None,
            )
            return self._extract_order_id(resp)
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def place_sl_order(
        self,
        symbol: str,
        side: str,    # "B" or "S"
        qty: int,
        trigger_price: float,
        limit_price: float,
    ) -> str:
        """Place a stop-loss limit order. Returns the Kotak order ID."""
        client = self._get_client()
        kotak_sym, exchange_seg = self._resolve_symbol(symbol)
        try:
            resp = client.place_order(
                exchange_segment=exchange_seg,
                product="MIS",
                price=str(_round_to_tick(limit_price)),
                order_type="SL",
                quantity=str(qty),
                validity="DAY",
                trading_symbol=kotak_sym,
                transaction_type=side,
                amo="NO",
                disclosed_quantity="0",
                market_protection="0",
                pf="N",
                trigger_price=str(_round_to_tick(trigger_price)),
                tag=None,
            )
            return self._extract_order_id(resp)
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def place_options_limit_order(
        self,
        symbol: str,
        right: str,     # "CE" or "PE"
        strike: int,
        expiry: str,    # "YYYY-MM-DD"
        side: str,      # "B" or "S"
        qty: int,
        price: float,
    ) -> str:
        """Place a limit order on an options contract. Returns the Kotak order ID."""
        client = self._get_client()
        kotak_sym, exchange_seg = self._resolve_options_symbol(symbol, right, strike, expiry)
        try:
            resp = client.place_order(
                exchange_segment=exchange_seg,
                product="MIS",
                price=str(_round_to_tick(price)),
                order_type="L",
                quantity=str(qty),
                validity="DAY",
                trading_symbol=kotak_sym,
                transaction_type=side,
                amo="NO",
                disclosed_quantity="0",
                market_protection="0",
                pf="N",
                trigger_price="0",
                tag=None,
            )
            return self._extract_order_id(resp)
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def place_options_sl_order(
        self,
        symbol: str,
        right: str,     # "CE" or "PE"
        strike: int,
        expiry: str,    # "YYYY-MM-DD"
        side: str,      # "B" or "S"
        qty: int,
        trigger_price: float,
        limit_price: float,
    ) -> str:
        """Place an SL limit order on an options contract. Returns the Kotak order ID."""
        client = self._get_client()
        kotak_sym, exchange_seg = self._resolve_options_symbol(symbol, right, strike, expiry)
        try:
            resp = client.place_order(
                exchange_segment=exchange_seg,
                product="MIS",
                price=str(_round_to_tick(limit_price)),
                order_type="SL",
                quantity=str(qty),
                validity="DAY",
                trading_symbol=kotak_sym,
                transaction_type=side,
                amo="NO",
                disclosed_quantity="0",
                market_protection="0",
                pf="N",
                trigger_price=str(_round_to_tick(trigger_price)),
                tag=None,
            )
            return self._extract_order_id(resp)
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def modify_sl_order(
        self,
        kotak_order_id: str,
        new_trigger: float,
        new_limit: float,
        qty: int,
    ) -> None:
        """Modify the trigger and limit price of an existing SL order on Kotak."""
        client = self._get_client()
        try:
            resp = client.modify_order(
                order_id=kotak_order_id,
                price=str(_round_to_tick(new_limit)),
                order_type="SL",
                quantity=str(qty),
                validity="DAY",
                trigger_price=str(_round_to_tick(new_trigger)),
                disclosed_quantity="0",
            )
            self._check_api_response(resp)
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def cancel_order(self, kotak_order_id: str) -> None:
        """Cancel an open order on Kotak."""
        client = self._get_client()
        try:
            client.cancel_order(order_id=kotak_order_id)
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    # ── Account data ─────────────────────────────────────────────────────────

    def get_funds(self) -> float:
        """Return available funds (Net balance) from Kotak."""
        client = self._get_client()
        try:
            limits = client.limits()
            self._check_api_response(limits)
            if isinstance(limits, dict):
                return float(limits.get("Net", 0) or 0)
            return 0.0
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    @staticmethod
    def _normalize_order(raw: dict) -> dict:
        """Convert a raw Kotak order dict to a stable, UI-friendly shape."""
        status_raw = (
            str(raw.get("ordSt") or raw.get("stat") or "").lower()
        )
        side_code = str(raw.get("trnsTp", "B")).upper()
        price_type = str(raw.get("prcTp", "L")).upper()
        order_type_map = {"L": "LIMIT", "MKT": "MARKET", "SL": "SL", "SL-M": "SL-M"}
        return {
            "kotak_order_id": str(raw.get("nOrdNo", "")),
            "status": status_raw,
            "side": "BUY" if side_code == "B" else "SELL",
            "symbol": str(raw.get("trdSym") or raw.get("sym") or ""),
            "exchange": str(raw.get("exSeg", "")),
            "quantity": int(raw.get("qty") or 0),
            "filled_quantity": int(raw.get("fldQty") or raw.get("flQty") or 0),
            "limit_price": float(raw.get("prc") or 0),
            "trigger_price": float(raw.get("trgPrc") or 0),
            "filled_price": float(raw.get("avgPrc") or raw.get("flPrc") or 0),
            "order_type": order_type_map.get(price_type, price_type),
            "order_time": str(raw.get("ordDtTm") or raw.get("ordEntTm") or ""),
            "product": str(raw.get("prod", "")),
            "reject_reason": str(
                raw.get("rejRsn") or raw.get("rjRsn") or raw.get("rejectionReason") or ""
            ),
        }

    def get_order_history(self) -> list[dict]:
        """Return today's orders from Kotak normalized to a stable dict shape."""
        client = self._get_client()
        try:
            resp = client.order_report()
            self._check_api_response(resp)
            if isinstance(resp, list):
                raw_list = resp
            elif isinstance(resp, dict):
                raw_list = resp.get("data", [])
                if not isinstance(raw_list, list):
                    raw_list = []
            else:
                raw_list = []
            return [self._normalize_order(o) for o in raw_list if isinstance(o, dict)]
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    # ── Fill callbacks ────────────────────────────────────────────────────────

    def register_fill_callback(
        self,
        kotak_order_id: str,
        callback: Callable,
        loop: Any,
    ) -> None:
        """
        Register a thread-safe callback to be called when `kotak_order_id` is
        filled. The callback signature is: callback(kotak_order_id, side, qty, price).
        It is scheduled on `loop` via call_soon_threadsafe.
        """
        with self._lock:
            self._fill_callbacks[kotak_order_id] = (callback, loop)

    def deregister_fill_callback(self, kotak_order_id: str) -> None:
        with self._lock:
            self._fill_callbacks.pop(kotak_order_id, None)

    def register_reject_callback(
        self,
        kotak_order_id: str,
        callback: Callable,
        loop: Any,
    ) -> None:
        """Register a callback fired when `kotak_order_id` is rejected by the exchange."""
        with self._lock:
            self._reject_callbacks[kotak_order_id] = (callback, loop)

    def deregister_reject_callback(self, kotak_order_id: str) -> None:
        with self._lock:
            self._reject_callbacks.pop(kotak_order_id, None)

    # ── Market data callback (used by KotakBroadcaster) ──────────────────────

    def register_market_data_callback(self, callback: Callable | None) -> None:
        """
        Register (or clear) a callback for incoming market data (stock_feed) messages.
        Called by KotakBroadcaster to hook into the shared NeoWebSocket.
        The callback receives the raw message dict and runs in the WebSocket thread.
        """
        with self._lock:
            self._market_data_callback = callback
        logger.info(
            "KotakNeoService: market data callback %s",
            "registered" if callback else "cleared",
        )

    # ── WebSocket order feed ──────────────────────────────────────────────────

    def _start_order_feed(self) -> None:
        """Start the Kotak order-feed WebSocket (runs in a background thread)."""
        if self._client is None:
            return
        try:
            self._client.on_message = self._on_message
            self._client.on_error = self._on_error
            self._client.on_close = self._on_close
            self._client.on_open = self._on_open
            # subscribe_to_orderfeed() creates the NeoWebSocket and calls
            # get_order_feed() which starts the WS in a background thread.
            # Setting on_* attributes before calling this is required.
            self._client.subscribe_to_orderfeed()
            logger.info("Kotak Neo order feed WebSocket subscribed")
        except Exception as exc:
            logger.warning("Failed to start Kotak order feed WebSocket: %s", exc)

    def _on_open(self, *args: Any) -> None:
        logger.info("Kotak Neo order feed WebSocket opened")

    def _on_close(self, *args: Any) -> None:
        logger.warning("Kotak Neo order feed WebSocket closed")

    def _on_error(self, *args: Any) -> None:
        error = args[0] if args else "unknown"
        logger.error("Kotak Neo order feed WebSocket error: %s", error)

    def _on_message(self, message: Any) -> None:
        """
        Handle incoming messages from the Kotak NeoWebSocket.
        Dispatches by "type" field:
          - "order_feed"  → order fill / reject callbacks
          - "stock_feed"  → market data callback (KotakBroadcaster)
        Sample order_feed: {"type":"order_feed","data":"{\"type\":\"order\",\"data\":[{...}]}"}
        """
        try:
            if isinstance(message, (bytes, bytearray)):
                message = message.decode()
            if isinstance(message, str):
                message = json.loads(message)
            if not isinstance(message, dict):
                return

            msg_type = message.get("type")
            logger.debug("KotakNeoService: WebSocket message type=%s", msg_type)

            # Dispatch market data to KotakBroadcaster if registered
            if msg_type == "stock_feed":
                with self._lock:
                    cb = self._market_data_callback
                if cb is not None:
                    try:
                        cb(message)
                    except Exception as exc:
                        logger.warning(
                            "KotakNeoService: market data callback raised: %s", exc
                        )
                return

            if msg_type != "order_feed":
                logger.debug("KotakNeoService: ignoring unknown message type=%s", msg_type)
                return

            raw_data = message.get("data")
            outer = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
            if not isinstance(outer, dict) or outer.get("type") != "order":
                return

            raw_orders = outer.get("data", {})
            if isinstance(raw_orders, dict):
                raw_orders = [raw_orders]
            elif not isinstance(raw_orders, list) or not raw_orders:
                return

            for order_data in raw_orders:
                if not isinstance(order_data, dict):
                    continue

                order_id = str(order_data.get("nOrdNo", ""))
                order_status = str(order_data.get("ordSt", "")).lower()

                if order_status in ("complete", "filled"):
                    avg_prc = order_data.get("avgPrc", "0") or "0"
                    qty_str = order_data.get("qty", "0") or "0"
                    side_code = order_data.get("trnsTp", "B")

                    with self._lock:
                        entry = self._fill_callbacks.get(order_id)
                    if entry is None:
                        continue

                    callback, loop = entry
                    filled_price = float(avg_prc)
                    qty = int(qty_str)
                    side = "BUY" if side_code == "B" else "SELL"

                    logger.info(
                        "Kotak order %s filled: side=%s qty=%d price=%.2f",
                        order_id, side, qty, filled_price,
                    )
                    loop.call_soon_threadsafe(callback, order_id, side, qty, filled_price)

                    with self._lock:
                        self._fill_callbacks.pop(order_id, None)
                        self._reject_callbacks.pop(order_id, None)

                elif order_status in ("rejected", "cancelled"):
                    reject_reason = (
                        order_data.get("rejRsn")
                        or order_data.get("rjRsn")
                        or order_data.get("rejectionReason")
                        or "Order rejected by exchange"
                    )
                    logger.warning(
                        "Kotak order %s %s: %s", order_id, order_status, reject_reason
                    )

                    with self._lock:
                        entry = self._reject_callbacks.get(order_id)
                        self._fill_callbacks.pop(order_id, None)
                        self._reject_callbacks.pop(order_id, None)

                    if entry is not None:
                        r_callback, r_loop = entry
                        r_loop.call_soon_threadsafe(r_callback, order_id, str(reject_reason))

            else:
                logger.debug("Kotak order %s status update: %s", order_id, order_status)

        except Exception as exc:
            logger.warning("Kotak order feed message parsing error: %s", exc)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _resolve_options_symbol(self, symbol: str, right: str, strike: int, expiry: str) -> tuple[str, str]:
        """Return (kotak_trading_symbol, exchange_segment) for an options contract."""
        from app.config import SUPPORTED_SYMBOLS
        if symbol == "NIFTY":
            base = "NIFTY"
        elif symbol == "BSESEN":
            base = "SENSEX"
        else:
            raise KotakError(f"Symbol '{symbol}' does not support options trading on Kotak Neo")
        sym_info = SUPPORTED_SYMBOLS.get(symbol, {})
        exchange = "bse_fo" if sym_info.get("options_exchange_code") == "BFO" else "nse_fo"
        kotak_sym = _build_options_trading_symbol(base, expiry, strike, right, symbol)
        logger.debug("Resolved options symbol %s → %s (%s)", f"{symbol} {right} {strike} {expiry}", kotak_sym, exchange)
        return kotak_sym, exchange

    def _resolve_symbol(self, symbol: str) -> tuple[str, str]:
        if symbol not in _SYMBOL_MAP:
            raise KotakError(
                f"Symbol '{symbol}' is not configured for Kotak Neo real trading"
            )
        return _SYMBOL_MAP[symbol]

    def _check_api_response(self, resp: Any) -> None:
        """
        Raise KotakError if resp is a Kotak error dict (stat=Not_Ok / errMsg present).
        stCode 100008 = session expired — also marks the service as unauthenticated so
        the next is_authenticated() check returns False and prompts a re-TOTP.
        """
        if not isinstance(resp, dict):
            return
        if resp.get("stat") == "Not_Ok" or resp.get("errMsg"):
            err_msg = resp.get("errMsg") or "unknown error"
            st_code = resp.get("stCode")
            if st_code == 100008:
                # Session expired — force re-authentication
                with self._lock:
                    self._authenticated = False
                    self._client = None
                raise KotakError(
                    f"Kotak session expired (unauthorized) — please reconnect via Settings. "
                    f"(code {st_code})"
                )
            raise KotakError(f"Kotak API error: {err_msg} (code {st_code})")

    def _extract_order_id(self, resp: Any) -> str:
        """Parse Kotak place_order response to extract the order number."""
        self._check_api_response(resp)
        if isinstance(resp, dict):
            for key in ("nOrdNo", "order_id"):
                if resp.get(key):
                    return str(resp[key])
            data = resp.get("data")
            if isinstance(data, dict):
                self._check_api_response(data)
                if data.get("nOrdNo"):
                    return str(data["nOrdNo"])
        raise KotakError(f"Unexpected Kotak order response (no order ID): {resp!r}")


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_service = KotakNeoService()


# ---------------------------------------------------------------------------
# 1-second OHLC accumulator for Kotak market data ticks
# ---------------------------------------------------------------------------

@dataclass
class _KotakOHLCAccumulator:
    """
    Accumulates LTP ticks into completed 1-second OHLC candles.
    Identical logic to _OHLCAccumulator in kite_service.py.
    """
    open: float = 0.0
    high: float = 0.0
    low: float = 0.0
    close: float = 0.0
    current_second: int = 0

    def update(self, price: float, ts_second: int) -> dict | None:
        """
        Feed a price. Returns a completed candle dict when the second boundary
        is crossed, otherwise None.
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
# KotakBroadcaster — module-level singleton for Kotak Neo market data
# ---------------------------------------------------------------------------

class KotakBroadcaster:
    """
    Kotak Neo market data WebSocket broadcaster.

    Mirrors KiteBroadcaster: one shared WebSocket connection (via the
    authenticated KotakNeoService), fan-out to all registered session queues.

    Market data arrives on the same NeoWebSocket as order feed; the service
    dispatches "stock_feed" type messages here via register_market_data_callback.
    Completed 1-second OHLC candles are pushed to session queues using
    loop.call_soon_threadsafe so asyncio loops receive them safely from the
    background WebSocket thread.

    Authentication: KotakNeoService must be authenticated before register() is
    called. is_ready() should be checked before use; paper sessions fall back to
    Kite if Kotak is not available.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Kotak scrip token str → {session_id: (queue, right, loop)}
        self._token_sessions: dict[str, dict[str, tuple]] = defaultdict(dict)
        # session_id → set[token_str]
        self._session_tokens: dict[str, set[str]] = defaultdict(set)
        # token_str → exchange_segment (for (un)subscribe calls)
        self._token_exchange: dict[str, str] = {}
        # token_str → True if this is an index instrument (NIFTY/SENSEX underlying)
        self._token_is_index: dict[str, bool] = {}
        # per-token OHLC accumulator
        self._accumulators: dict[str, _KotakOHLCAccumulator] = defaultdict(_KotakOHLCAccumulator)
        self._subscribed = False

    def is_ready(self) -> bool:
        """True when Kotak Neo is authenticated and ready to stream market data."""
        return _service.is_authenticated()

    def register(
        self,
        session_id: str,
        tokens: list[str],
        exchanges: list[str],
        rights: list[str | None],
        queue: "asyncio.Queue",
        loop: "asyncio.AbstractEventLoop",
        is_indices: list[bool] | None = None,
    ) -> None:
        """
        Register a session for the given Kotak scrip tokens.

        tokens[i]:     Kotak instrument token string (from master data)
        exchanges[i]:  exchange_segment for tokens[i] (e.g. "nse_cm", "nse_fo")
        rights[i]:     "CE", "PE", or None (equity/index)
        is_indices[i]: True when token is an index (NIFTY/SENSEX underlying) —
                       Kotak requires a separate subscribe call with isIndex=True
                       for indices. Defaults to False for all tokens when omitted.

        Raises KotakError if Kotak is not authenticated or subscription fails.
        """
        if is_indices is None:
            is_indices = [False] * len(tokens)
        logger.info(
            "KotakBroadcaster: registering session %s with %d tokens: %s",
            session_id, len(tokens),
            [(t, r, idx) for t, r, idx in zip(tokens, rights, is_indices)],
        )
        with self._lock:
            for token, exchange, right, is_idx in zip(tokens, exchanges, rights, is_indices):
                self._token_sessions[token][session_id] = (queue, right, loop)
                self._session_tokens[session_id].add(token)
                self._token_exchange[token] = exchange
                self._token_is_index[token] = is_idx

        self._subscribe_all()

    def _subscribe_all(self) -> None:
        """Register market data callback and subscribe to all tracked tokens.

        Kotak requires separate subscribe() calls for index instruments (isIndex=True)
        and regular scrips (isIndex=False) — mixing them in one call causes indices
        to silently receive no data.
        """
        with self._lock:
            index_dicts = [
                {"instrument_token": tok, "exchange_segment": exch}
                for tok, exch in self._token_exchange.items()
                if self._token_is_index.get(tok, False)
            ]
            scrip_dicts = [
                {"instrument_token": tok, "exchange_segment": exch}
                for tok, exch in self._token_exchange.items()
                if not self._token_is_index.get(tok, False)
            ]

        if not index_dicts and not scrip_dicts:
            return

        try:
            _service.register_market_data_callback(self._on_ticks)
            client = _service._get_client()
            if index_dicts:
                client.subscribe(
                    instrument_tokens=index_dicts,
                    isIndex=True,
                    isDepth=False,
                )
                logger.info(
                    "KotakBroadcaster: subscribed %d index instruments (isIndex=True): %s",
                    len(index_dicts),
                    [d["instrument_token"] for d in index_dicts],
                )
            if scrip_dicts:
                client.subscribe(
                    instrument_tokens=scrip_dicts,
                    isIndex=False,
                    isDepth=False,
                )
                logger.info(
                    "KotakBroadcaster: subscribed %d scrip instruments (isIndex=False): %s",
                    len(scrip_dicts),
                    [d["instrument_token"] for d in scrip_dicts],
                )
            self._subscribed = True
        except KotakError:
            raise
        except Exception as exc:
            logger.error("KotakBroadcaster: subscription call failed: %s", exc)
            raise KotakError(f"Kotak market data subscription failed: {exc}") from exc

    def unregister(self, session_id: str) -> None:
        """Remove a session; unsubscribes tokens that have no remaining sessions."""
        logger.info("KotakBroadcaster: unregistering session %s", session_id)
        orphaned: list[tuple[str, str]] = []   # (token, exchange_segment)
        with self._lock:
            owned = self._session_tokens.pop(session_id, set())
            for token in owned:
                self._token_sessions[token].pop(session_id, None)
                if not self._token_sessions[token]:
                    del self._token_sessions[token]
                    exch = self._token_exchange.pop(token, "")
                    self._token_is_index.pop(token, None)
                    orphaned.append((token, exch))

        if orphaned:
            logger.info(
                "KotakBroadcaster: unsubscribing orphaned tokens: %s",
                [t for t, _ in orphaned],
            )
            try:
                client = _service._get_client()
                client.un_subscribe(
                    instrument_tokens=[
                        {"instrument_token": t, "exchange_segment": e}
                        for t, e in orphaned
                    ]
                )
            except Exception as exc:
                logger.warning("KotakBroadcaster: un_subscribe error: %s", exc)

        with self._lock:
            has_sessions = bool(any(self._token_sessions.values()))

        if not has_sessions:
            self._subscribed = False
            _service.register_market_data_callback(None)
            logger.info(
                "KotakBroadcaster: no active sessions — market data callback cleared"
            )

    def update_session_right(
        self,
        session_id: str,
        right: str,
        new_token: str,
        new_exchange: str,
        queue: "asyncio.Queue",
        loop: "asyncio.AbstractEventLoop",
    ) -> None:
        """
        Swap the instrument token for a given right (CE/PE) in a live session.
        Called when the user changes the options strike mid-session.
        """
        orphaned: list[tuple[str, str]] = []  # (token, exchange_segment)
        with self._lock:
            if session_id not in self._session_tokens:
                logger.debug(
                    "KotakBroadcaster: update_session_right — session %s not registered",
                    session_id,
                )
                return

            old_token: str | None = None
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
                    old_exch = self._token_exchange.pop(old_token, "")
                    self._token_is_index.pop(old_token, None)
                    orphaned.append((old_token, old_exch))

            self._token_sessions[new_token][session_id] = (queue, right, loop)
            self._session_tokens[session_id].add(new_token)
            self._token_exchange[new_token] = new_exchange
            self._token_is_index[new_token] = False  # strike updates are always options, never indices

        if orphaned:
            try:
                client = _service._get_client()
                client.un_subscribe(
                    instrument_tokens=[
                        {"instrument_token": t, "exchange_segment": e}
                        for t, e in orphaned
                    ]
                )
            except Exception as exc:
                logger.warning(
                    "KotakBroadcaster: un_subscribe error on strike change: %s", exc
                )

        # Subscribe new token
        try:
            client = _service._get_client()
            client.subscribe(
                instrument_tokens=[
                    {"instrument_token": new_token, "exchange_segment": new_exchange}
                ],
                isIndex=False,
                isDepth=False,
            )
            logger.info(
                "KotakBroadcaster: session %s right=%s token updated "
                "(old=%s new=%s exchange=%s)",
                session_id, right,
                orphaned[0] if orphaned else "none", new_token, new_exchange,
            )
        except Exception as exc:
            logger.error(
                "KotakBroadcaster: failed to subscribe new token %s: %s",
                new_token, exc,
            )

    # ── Internal tick handler ─────────────────────────────────────────────────

    def _on_ticks(self, message: Any) -> None:
        """
        Receive market data messages dispatched by KotakNeoService._on_message.
        Runs in the WebSocket background thread — must be thread-safe.
        Expected format: {"type": "stock_feed", "data": {...} | [{...}, ...]}
        """
        try:
            if isinstance(message, (bytes, bytearray)):
                message = message.decode()
            if isinstance(message, str):
                message = json.loads(message)
            if not isinstance(message, dict):
                return

            msg_type = message.get("type", "")
            if msg_type != "stock_feed":
                logger.debug("KotakBroadcaster: ignoring type=%s", msg_type)
                return

            raw_data = message.get("data", {})
            if isinstance(raw_data, dict):
                ticks = [raw_data]
            elif isinstance(raw_data, list):
                ticks = raw_data
            elif isinstance(raw_data, str):
                try:
                    parsed = json.loads(raw_data)
                    ticks = parsed if isinstance(parsed, list) else [parsed]
                except Exception:
                    logger.warning(
                        "KotakBroadcaster: could not parse nested data string: %.100s …",
                        raw_data,
                    )
                    return
            else:
                logger.debug(
                    "KotakBroadcaster: unexpected data type %s", type(raw_data).__name__
                )
                return

            for tick in ticks:
                if isinstance(tick, dict):
                    self._process_tick(tick)

        except Exception as exc:
            logger.warning("KotakBroadcaster: _on_ticks error: %s", exc)

    def _process_tick(self, tick: dict) -> None:
        """
        Process a single Kotak market data tick dict.
        Accumulates into 1-second OHLC and fans out completed candles to sessions.
        Field names are defensive to handle variation across SDK versions.
        """
        # Instrument token — websocket sends "tk"; keep fallbacks for safety
        token = str(
            tick.get("tk") or
            tick.get("instrument_token") or
            tick.get("scrip_token") or
            tick.get("token") or
            ""
        )
        if not token:
            logger.debug(
                "KotakBroadcaster: tick missing token — keys: %s",
                list(tick.keys())[:10],
            )
            return

        # LTP — try all known field names
        ltp_raw = (
            tick.get("ltP") or tick.get("ltp") or
            tick.get("last_price") or tick.get("ltp_price") or
            tick.get("close") or 0
        )
        try:
            price = float(ltp_raw)
        except (TypeError, ValueError):
            logger.debug(
                "KotakBroadcaster: invalid LTP %r for token %s", ltp_raw, token
            )
            return

        if price <= 0:
            return

        # Timestamp: prefer exchange timestamp; add IST offset to align with
        # the fake-UTC convention used throughout the platform.
        ts_raw = (
            tick.get("exchange_timestamp") or
            tick.get("timestamp") or
            tick.get("ttime") or
            None
        )
        if ts_raw is not None:
            try:
                ts_int = int(ts_raw)
                # If the timestamp looks like epoch seconds in IST-range add offset;
                # if it's already large enough, treat as-is.
                ts_second = ts_int + _IST_OFFSET if ts_int < 2_000_000_000 else ts_int
            except (TypeError, ValueError):
                ts_second = int(time.time()) + _IST_OFFSET
        else:
            ts_second = int(time.time()) + _IST_OFFSET

        # Update OHLC accumulator for this token
        with self._lock:
            acc = self._accumulators[token]
        completed = acc.update(price, ts_second)
        if completed is None:
            return

        # Retrieve registered sessions for this token
        with self._lock:
            session_entries = dict(self._token_sessions.get(token, {}))

        if not session_entries:
            logger.debug(
                "KotakBroadcaster: no sessions for token %s — dropped candle", token
            )
            return

        logger.debug(
            "KotakBroadcaster: token=%s OHLC O=%.2f H=%.2f L=%.2f C=%.2f ts=%d "
            "sessions=%d",
            token,
            completed["open"], completed["high"],
            completed["low"], completed["close"],
            completed["time"], len(session_entries),
        )

        for sid, (queue, right, loop) in session_entries.items():
            tick_payload = {**completed, "right": right}
            try:
                loop.call_soon_threadsafe(queue.put_nowait, tick_payload)
            except Exception as exc:
                logger.warning(
                    "KotakBroadcaster: failed to push tick for session %s: %s",
                    sid, exc,
                )


# Module-level KotakBroadcaster singleton — shared across all active sessions.
_kotak_broadcaster = KotakBroadcaster()


def get_kotak_broadcaster() -> KotakBroadcaster:
    """Return the module-level KotakBroadcaster singleton."""
    return _kotak_broadcaster


def get_service() -> KotakNeoService:
    """Return the module-level KotakNeoService singleton."""
    return _service
