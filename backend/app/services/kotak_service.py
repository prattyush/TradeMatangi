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
  - TradePanel BUY   → Kotak LIMIT at LTP × (1 + user target/market gap)
  - TradePanel SELL  → Kotak LIMIT at LTP × (1 − user target/market gap)

Options trading symbol format (Kotak / NSE-BSE convention):
  Monthly expiry (last weekday occurrence of month): {BASE}{YY}{MON3}{STRIKE}{RIGHT}
    e.g. NIFTY26MAY23500PE, SENSEX26MAY76000CE
  Weekly non-monthly: {BASE}{YY}{M}{DD}{STRIKE}{RIGHT}
    e.g. NIFTY2660223500PE (June-2), SENSEX2660476000CE (June-4)
    Month Jan-Sep = single digit; Oct-Dec = O/N/D.
"""
from __future__ import annotations

import asyncio
import configparser
import contextlib
import json
import logging
import math
import os
import sys
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
    Oct/Nov/Dec month codes are O/N/D.
    """
    expiry_dt = datetime.strptime(expiry, "%Y-%m-%d").date()
    yy = expiry_dt.strftime("%y")          # "26"
    if _is_monthly_expiry(expiry_dt, symbol):
        month_part = expiry_dt.strftime("%b").upper()   # "MAY", "OCT", …
    else:
        m = expiry_dt.month
        dd = expiry_dt.strftime("%d")                   # "02", "14", …
        month_code = {10: "O", 11: "N", 12: "D"}.get(m, str(m))
        month_part = f"{month_code}{dd}"                # "602", "O01", …
    return f"{base}{yy}{month_part}{strike}{right}"


class KotakError(Exception):
    """Raised when Kotak Neo API returns an error or is misconfigured."""


class KotakOrderRejected(KotakError):
    """An explicit negative broker response, not an ambiguous transport failure."""


# ---------------------------------------------------------------------------
# Instrument master cache helpers
# ---------------------------------------------------------------------------

def _get_instruments_cache_path():
    from app.config import DATA_DIR
    return DATA_DIR / "kotak_instruments.json"


def _load_kotak_master_from_api(*, client=None) -> list[dict]:
    """
    Download the Kotak Neo instrument master via neo_api_client and cache to disk.

    Uses client.scrip_master(exchange_segment=seg) which returns a CSV URL string.
    Downloads each CSV and parses it; normalises into stable dicts.
    Returns normalised list of {instrument_token, symbol, exchange, name} dicts.
    Called lazily when the cache is missing or stale.
    """
    import csv
    import urllib.request

    read_only = client is not None
    try:
        if client is None:
            client = _service._get_client()
    except KotakError as exc:
        logger.error("KotakBroadcaster: cannot download master — Kotak not authenticated: %s", exc)
        return []

    segments = ["nse_cm", "nse_fo", "bse_cm", "bse_fo"]  # bse_cm needed for SENSEX index token
    normalized: list[dict] = []

    for seg in segments:
        logger.info("KotakBroadcaster: fetching scrip master URL for segment %s …", seg)
        try:
            url = client.scrip_master(exchange_segment=seg)
            if not read_only:
                _service._check_api_response(url)
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
                        "expiry": row.get("pExpiryDate") or row.get("expiry") or row.get("expDt") or "",
                        "strike": row.get("dStrikePrice") or row.get("stkPrc") or "",
                        "right": row.get("pOptionType") or row.get("optTp") or "",
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


_master_lock = threading.Lock()


def _get_kotak_instruments(*, client=None) -> list[dict]:
    with _master_lock:
        return _get_kotak_instruments_unlocked(client=client)


def _get_kotak_instruments_unlocked(*, client=None) -> list[dict]:
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
    return _load_kotak_master_from_api() if client is None else _load_kotak_master_from_api(client=client)


def fetch_kotak_equity_instrument_token(symbol: str, *, client=None) -> tuple[str, str]:
    """
    Return (instrument_token, exchange_segment) for the equity / index instrument.
    Used by KotakBroadcaster to subscribe to live price feed.
    Raises KotakError if the token cannot be resolved.
    """
    if symbol not in _SYMBOL_MAP:
        raise KotakError(f"Symbol '{symbol}' not configured for Kotak Neo streaming")

    kotak_sym, exchange_seg = _SYMBOL_MAP[symbol]
    instruments = _get_kotak_instruments() if client is None else _get_kotak_instruments(client=client)

    if not instruments:
        raise KotakError(
            f"Kotak Neo instrument master is empty. "
            + ("Check the configured Kotak consumer key and retry." if client is not None
               else "Ensure Kotak Neo is authenticated and re-try.")
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
    *, client=None,
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
    instruments = _get_kotak_instruments() if client is None else _get_kotak_instruments(client=client)

    if not instruments:
        raise KotakError(
            f"Kotak Neo instrument master is empty — cannot resolve options token for {kotak_sym}"
        )

    matches = [
        inst for inst in instruments
        if inst["symbol"] == kotak_sym and inst["exchange"] == exchange_seg
    ]

    if not matches:
        # Canonical Breeze stock codes differ from exchange trading names.
        mapped_base = _SYMBOL_MAP.get(symbol, (base, exchange_seg))[0].removesuffix("-EQ")
        if mapped_base != base:
            mapped_symbol = _build_options_trading_symbol(mapped_base, expiry, strike, right, symbol)
            matches = [inst for inst in instruments
                       if inst["symbol"] == mapped_symbol and inst["exchange"] == exchange_seg]
            if matches:
                kotak_sym = mapped_symbol

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
    "NIFTY":  ("NIFTY",          "nse_cm"),   # NIFTY 50 index lives in nse_cm (token 26000); nse_fo only has futures/options
    "BSESEN": ("SENSEX",         "bse_cm"),   # SENSEX index lives in bse_cm; bse_fo only has futures/options
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
        self._login_lock = threading.Lock()
        self._feed_lock = threading.Lock()
        self._bridge = None
        self._generation = 0
        # kotak_order_id → (callback, asyncio_loop)
        self._fill_callbacks: dict[str, tuple[Callable, Any]] = {}
        self._reject_callbacks: dict[str, tuple[Callable, Any]] = {}
        self._cancel_callbacks: dict[str, tuple[Callable, Any]] = {}
        self._pending_cancellations: dict[str, dict] = {}
        # Fills that arrived before register_fill_callback was called (race condition
        # for very fast fills on liquid instruments).
        # kotak_order_id → (side, qty, price)
        self._pending_fills: dict[str, tuple[str, int, float]] = {}
        self._pending_rejects: dict[str, str] = {}
        self._position_observers: dict[str, tuple[Callable, Any]] = {}
        self._position_events: dict[tuple, dict] = {}
        self._order_observers: dict[str, tuple[Callable, Any]] = {}
        self._terminal_orders: set[str] = set()
        # KotakBroadcaster registers here to receive stock_feed messages
        self._market_data_callback: Callable | None = None

    # ── Authentication ────────────────────────────────────────────────────────

    @staticmethod
    def _close_client(client):
        if client is not None:
            with contextlib.suppress(Exception):
                client.api_client.rest_client.close()

    def shutdown(self) -> None:
        """Invalidate old callbacks before closing sockets, without holding state locks."""
        with self._feed_lock:
            with self._lock:
                self._generation += 1
                self._position_events.clear()
                self._authenticated = False
                client, self._client = self._client, None
                bridge, self._bridge = self._bridge, None
        try:
            if bridge is not None:
                bridge.close()
        finally:
            self._close_client(client)

    def login_with_totp(self, totp: str) -> None:
        # SDK logging must use the application's configured log directory.
        from app.config import LOG_DIR
        os.environ.setdefault("NEO_LOG_FILE_PATH", str(LOG_DIR / "neo-api-client.log"))
        if "pytest" in sys.modules:
            os.environ.setdefault("NEO_LOG_FILE_ENABLED", "false")
        try:
            from neo_api_client import NeoAPI
        except ImportError as exc:
            raise KotakError("Kotak SDK missing. Run: bash scripts/install-backend-dependencies.sh") from exc
        creds = _read_kotak_credentials()
        for key in ("access_token", "mobile", "ucc", "mpin"):
            if not creds[key]:
                raise KotakError(f"Kotak Neo '{key}' missing in data/accesskeys.ini [kotakneo]")
        with self._login_lock:
            self.shutdown()
            client = None
            try:
                client = NeoAPI(environment="prod", consumer_key=creds["access_token"])
                response = client.totp_login(mobile_number=creds["mobile"], ucc=creds["ucc"], totp=totp)
                self._validate_login_response(response, client, trade=False)
                response = client.totp_validate(mpin=creds["mpin"])
                self._validate_login_response(response, client, trade=True)
                with self._lock:
                    self._client = client
                    self._authenticated = True
                    self._pending_fills.clear()
                self._start_order_feed()
                # Re-login restores only subscriptions still owned by consumers.
                get_kotak_broadcaster()._subscribe_all(wait=False)
                logger.info("Kotak Neo authenticated successfully")
            except Exception as exc:
                self.shutdown()
                self._close_client(client)
                if isinstance(exc, KotakError):
                    raise
                raise KotakError(str(exc)) from exc

    def _validate_login_response(self, response, client, *, trade):
        self._check_api_response(response)
        data = response.get("data") if isinstance(response, dict) else None
        config = client.configuration
        token = config.edit_token if trade else config.view_token
        sid = config.edit_sid if trade else config.sid
        if not isinstance(data, dict) or data.get("status") != "success" or not token or not sid:
            raise KotakError("Kotak authentication response is missing a valid session")

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
        tag: str | None = None,
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
                trigger_price="0",
                tag=tag,
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
        tag: str | None = None,
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
                trigger_price=str(_round_to_tick(trigger_price)),
                tag=tag,
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
        tag: str | None = None,
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
                trigger_price="0",
                tag=tag,
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
        tag: str | None = None,
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
                trigger_price=str(_round_to_tick(trigger_price)),
                tag=tag,
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
    ) -> str:
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
            self._check_order_ack(resp)
            data = resp.get("data", resp) if isinstance(resp, dict) else {}
            return str(data.get("nOrdNo") or data.get("order_id") or kotak_order_id) if isinstance(data, dict) else kotak_order_id
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def modify_sl_to_limit_order(
        self,
        kotak_order_id: str,
        limit_price: float,
        qty: int,
    ) -> str:
        """
        Convert an existing SL order to a plain LIMIT order by calling modify_order
        with order_type="L" and trigger_price="0".  Atomic — no window without
        broker-side protection.  Raises KotakError if the API does not support it.
        """
        client = self._get_client()
        try:
            resp = client.modify_order(
                order_id=kotak_order_id,
                price=str(_round_to_tick(limit_price)),
                order_type="L",
                quantity=str(qty),
                validity="DAY",
                trigger_price="0",
                disclosed_quantity="0",
            )
            self._check_order_ack(resp)
            data = resp.get("data", resp) if isinstance(resp, dict) else {}
            return str(data.get("nOrdNo") or data.get("order_id") or kotak_order_id) if isinstance(data, dict) else kotak_order_id
        except KotakError:
            raise
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def cancel_order(self, kotak_order_id: str, *, initiator="system", purpose="legacy", context=None) -> None:
        """Journal intent before the broker call, including fast/late terminal events."""
        client = self._get_client()
        from app.services import protection_journal as journal
        account = self.account_identity()
        key, intent = journal.begin_cancel(account, kotak_order_id, initiator, purpose, context)
        logger.info("broker_cancel_requested order=%s request=%s initiator=%s purpose=%s", kotak_order_id, intent["request_id"], initiator, purpose)
        try:
            resp = client.cancel_order(order_id=kotak_order_id)
            self._check_order_ack(resp)
        except Exception as exc:
            # A transport exception is ambiguous; a negative acknowledgement is definitive.
            state = "failed" if isinstance(exc, KotakOrderRejected) else "unknown"
            journal.finish_cancel(key, intent, state, str(exc))
            logger.warning("broker_cancel_failed order=%s request=%s state=%s", kotak_order_id, intent["request_id"], state)
            raise KotakError(str(exc)) from exc
        journal.finish_cancel(key, intent, "acknowledged")
        logger.info("broker_cancel_acknowledged order=%s request=%s", kotak_order_id, intent["request_id"])

    # ── Account data ─────────────────────────────────────────────────────────

    def get_funds(self) -> float:
        """Return raw available funds; capital accounting uses the full limits report."""
        return float(self.get_limits()["Net"])

    def get_limits(self) -> dict:
        """Return validated limits without discarding committed-funds information."""
        client = self._get_client()
        try:
            limits = client.limits()
            self._check_api_response(limits)
            import math
            if not isinstance(limits, dict) or limits.get("Net") in (None, "") or isinstance(limits.get("Net"), bool):
                raise KotakError("Kotak limits response is missing available funds (Net)")
            funds = float(limits["Net"])
            if not math.isfinite(funds):
                raise KotakError("Kotak limits response contains invalid available funds")
            return limits
        except KotakError as exc:
            raise KotakError(f"Kotak limits: {exc}") from exc
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    @staticmethod
    def _normalize_order(raw: dict) -> dict:
        """Convert a raw Kotak order dict to a stable, UI-friendly shape."""
        from app.services.broker_reports import normalize_order
        return normalize_order(raw)

    def _report(self, method: str) -> list[dict]:
        """A failed/malformed report must never become an authoritative empty day."""
        try:
            resp = getattr(self._get_client(), method)()
            # Kotak documents this envelope for reports with no records. It is
            # distinct from unavailable/malformed reports, and never supplies
            # a substitute balance for limits().
            if (isinstance(resp, dict)
                    and str(resp.get("stCode")) == "5203"
                    and str(resp.get("errMsg", "")).strip().casefold() == "no data"
                    and str(resp.get("stat", "")).casefold() == "not_ok"
                    and resp.get("data") in (None, [])
                    and not any(resp.get(key) for key in ("error", "Error", "Error Message", "fault"))
                    and str(resp.get("status_code") or resp.get("StatusCode") or "200") == "200"):
                logger.debug("Kotak %s returned no records (5203)", method)
                return []
            self._check_api_response(resp)
            if isinstance(resp, list):
                data = resp
            elif isinstance(resp, dict) and isinstance(resp.get("data"), list):
                data = resp["data"]
            else:
                raise KotakError(f"Malformed Kotak {method} response")
            if any(not isinstance(row, dict) for row in data):
                raise KotakError(f"Malformed Kotak {method} record")
            return data
        except KotakError as exc:
            raise KotakError(f"Kotak {method}: {exc}") from exc
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def get_order_history(self) -> list[dict]:
        try:
            raw = self._report("order_report")
            from app.services.kotak_cancel_audit import record
            record({"type": "order", "data": raw}, stage="report")
            rows = [self._normalize_order(row) for row in raw]
            if any(not row["kotak_order_id"] or not row["symbol"] or not row["status"] or row["quantity"] <= 0 for row in rows):
                raise KotakError("Malformed Kotak order report identity or quantity")
            return rows
        except ValueError as exc:
            raise KotakError(str(exc)) from exc

    def get_trade_history(self) -> list[dict]:
        from app.services.broker_reports import normalize_execution
        try:
            return [normalize_execution(row) for row in self._report("trade_report")]
        except ValueError as exc:
            raise KotakError(str(exc)) from exc

    def get_positions(self) -> list[dict]:
        rows = self._report("positions")
        for row in rows:
            if not (row.get("trdSym") or row.get("symbol") or row.get("sym")) or not any(k in row for k in ("netQty", "net_quantity", "cfBuyQty", "flBuyQty", "cfSellQty", "flSellQty")):
                raise KotakError("Malformed Kotak position identity or quantity")
        return rows

    def account_identity(self) -> str:
        # Stable opaque identity; never return credentials in diagnostics or responses.
        import hashlib
        ucc = _read_kotak_credentials()["ucc"]
        if not ucc:
            raise KotakError("Kotak account identity is missing")
        return hashlib.sha256(ucc.encode()).hexdigest()[:16]

    # ── Fill callbacks ────────────────────────────────────────────────────────

    def register_fill_callback(
        self,
        kotak_order_id: str,
        callback: Callable,
        loop: Any,
    ) -> None:
        """
        Register a thread-safe callback for when `kotak_order_id` is filled.
        Callback signature: callback(kotak_order_id, side, qty, price).

        If the fill arrived before this registration (race condition on fast fills),
        it is dispatched immediately via loop.call_soon_threadsafe.
        """
        with self._lock:
            pending = self._pending_fills.pop(kotak_order_id, None)
            if kotak_order_id not in self._terminal_orders:
                self._fill_callbacks[kotak_order_id] = (callback, loop)

        if pending is not None:
            p_side, p_qty, p_price = pending
            logger.info(
                "KotakNeoService: dispatching buffered fill for %s "
                "side=%s qty=%d price=%.2f",
                kotak_order_id, p_side, p_qty, p_price,
            )
            loop.call_soon_threadsafe(callback, kotak_order_id, p_side, p_qty, p_price)

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
            pending = self._pending_rejects.pop(kotak_order_id, None)
            if kotak_order_id not in self._terminal_orders:
                self._reject_callbacks[kotak_order_id] = (callback, loop)
        if pending is not None:
            loop.call_soon_threadsafe(callback, kotak_order_id, pending)

    def deregister_reject_callback(self, kotak_order_id: str) -> None:
        with self._lock:
            self._reject_callbacks.pop(kotak_order_id, None)

    def register_cancel_callback(self, kotak_order_id: str, callback: Callable, loop: Any) -> None:
        with self._lock:
            pending = self._pending_cancellations.pop(kotak_order_id, None)
            if pending is not None:
                self._pending_rejects.pop(kotak_order_id, None)
            if kotak_order_id not in self._terminal_orders:
                self._cancel_callbacks[kotak_order_id] = (callback, loop)
        if pending is not None:
            loop.call_soon_threadsafe(callback, kotak_order_id, pending)

    def deregister_cancel_callback(self, kotak_order_id: str) -> None:
        with self._lock:
            self._cancel_callbacks.pop(kotak_order_id, None)

    def register_position_observer(self, token, callback, loop):
        with self._lock:
            self._position_observers[token] = (callback, loop)

    def deregister_position_observer(self, token):
        with self._lock:
            self._position_observers.pop(token, None)

    def register_order_observer(self, token, callback, loop):
        """Observe raw order updates without replacing fill/terminal handlers."""
        with self._lock:
            self._order_observers[token] = (callback, loop)

    def deregister_order_observer(self, token):
        with self._lock:
            self._order_observers.pop(token, None)

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

    def replace_market_subscriptions(self, subscriptions, *, wait=True) -> None:
        self._get_client()
        self._start_order_feed()
        with self._lock:
            bridge = self._bridge
        try:
            if bridge is None:
                raise KotakError("Kotak feed is unavailable; login required")
            bridge.replace_subscriptions(subscriptions, wait=wait)
        except Exception as exc:
            raise KotakError(str(exc)) from exc

    def _start_order_feed(self) -> None:
        from app.services.kotak_stream import KotakFeedBridge
        with self._feed_lock:
            with self._lock:
                if not self._authenticated or self._client is None or self._bridge is not None:
                    return
                client, generation = self._client, self._generation
            def current():
                with self._lock:
                    return self._authenticated and self._generation == generation
            def order(message):
                if current():
                    self._on_message(message)
            def market(message):
                if current():
                    self._on_message(message)
            def expired():
                if current():
                    self.shutdown()
            self._bridge = KotakFeedBridge(client, order, market, expired)

    def _on_message(self, message: Any) -> None:
        """
        Adapt typed v3 orders and raw fallback frames to existing callbacks.
        The bridge normalizes market prices into stock_feed messages. Older
        nested order envelopes remain accepted for imported/test fixtures.
        """
        try:
            if hasattr(message, "model_dump"):
                message = message.model_dump(by_alias=True)
            if isinstance(message, (bytes, bytearray)):
                message = message.decode()
            if isinstance(message, str):
                message = json.loads(message)
            if not isinstance(message, dict):
                return

            msg_type = message.get("type")
            if msg_type == 'order_feed':
                nested = message.get('data')
                nested = json.loads(nested) if isinstance(nested, str) else nested
                if isinstance(nested, dict) and nested.get('type') == 'position':
                    message, msg_type = nested, 'position'

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

            logger.debug("KotakNeoService: WebSocket message type=%s", msg_type)
            if msg_type in ("order", "order_feed", "position"):
                from app.services.kotak_cancel_audit import redact
                logger.debug("Kotak raw event type=%s payload=%s", msg_type, json.dumps(redact(message), default=str))
            if msg_type == "position":
                payload = message.get("data")
                rows = payload if isinstance(payload, list) else [payload]
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    key = tuple(str(row.get(name) or "") for name in ("actId", "exSeg", "prod", "sym", "tok"))
                    with self._lock:
                        self._position_events[key] = {"received_at": time.time(), "generation": self._generation, "raw": dict(row)}
                        if len(self._position_events) > 256:
                            self._position_events.pop(next(iter(self._position_events)))
                    with self._lock:
                        observers = list(self._position_observers.values())
                    for callback, loop in observers:
                        if not loop.is_closed():
                            loop.call_soon_threadsafe(callback, dict(row))
                    logger.info("Kotak position update symbol=%s exchange=%s product=%s filled_buy=%s filled_sell=%s position_flag=%s square_off_flag=%s",
                                row.get("sym"), row.get("exSeg"), row.get("prod"), row.get("flBuyQty"), row.get("flSellQty"), row.get("posFlg"), row.get("sqrFlg"))
                return


            if msg_type not in ("order_feed", "order"):
                logger.debug("KotakNeoService: ignoring unknown message type=%s", msg_type)
                return

            raw_data = message.get("data")
            outer = message if msg_type == "order" else json.loads(raw_data) if isinstance(raw_data, str) else raw_data
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
                try:
                    self._dispatch_order_record(order_data)
                except (ValueError, TypeError, OverflowError) as exc:
                    logger.warning("Kotak invalid order row order=%s: %s", order_data.get("nOrdNo"), exc)
        except Exception as exc:
            logger.warning("Kotak order feed message parsing error: %s", exc)

    def _dispatch_order_record(self, order_data):
        from app.services.kotak_cancel_audit import record
        record({"type": "order", "data": order_data}, stage="parsed")
        order_id = str(order_data.get("nOrdNo") or "")
        if not order_id:
            return
        with self._lock:
            observers = list(self._order_observers.values())
        received = time.time()
        for callback, loop in observers:
            if not loop.is_closed():
                loop.call_soon_threadsafe(callback, {**order_data, '_received_at': received})
        status = str(order_data.get("ordSt") or order_data.get("stat") or "").strip().lower().replace("_", " ")
        if status == "canceled":
            status = "cancelled"
        with self._lock:
            if order_id in self._terminal_orders:
                return
        try:
            cumulative = int(float(order_data.get("fldQty") or order_data.get("flQty") or 0))
        except (ValueError, OverflowError):
            if status not in ("cancelled", "rejected"):
                raise
            cumulative = 0
            logger.warning("Kotak terminal order %s has invalid fill quantity; broker reconciliation required", order_id)
        if status in ("complete", "filled") or cumulative > 0:
            side_code = order_data.get("trnsTp")
            qty = cumulative or int(float(order_data.get("qty") or 0))
            price = float(order_data.get("avgPrc") or order_data.get("flPrc") or 0)
            if side_code in ("B", "BUY", "S", "SELL") and qty > 0 and math.isfinite(price) and price > 0:
                side = "BUY" if side_code in ("B", "BUY") else "SELL"
                with self._lock:
                    entry = self._fill_callbacks.get(order_id)
                    if status in ("complete", "filled"):
                        self._fill_callbacks.pop(order_id, None)
                        self._reject_callbacks.pop(order_id, None)
                        self._cancel_callbacks.pop(order_id, None)
                        self._terminal_orders.add(order_id)
                    if entry is None:
                        previous = self._pending_fills.get(order_id)
                        if previous is None or qty > previous[1]:
                            self._pending_fills[order_id] = (side, qty, price)
                if entry:
                    callback, loop = entry
                    loop.call_soon_threadsafe(callback, order_id, side, qty, price)
                logger.info("Kotak order %s filled: side=%s qty=%d price=%.2f", order_id, side, qty, price)
        if status in ("rejected", "cancelled"):
            reasons = [str(order_data.get(key) or "") for key in ("rejRsn", "rjRsn", "rejectionReason")]
            reason = next((value for value in reasons if value.strip() not in ("", "--", "___")), next((value for value in reasons if value), ""))
            metadata = {"status": status, "raw_reason": reason,
                        "reason": reason if reason.strip() not in ("", "--", "___") else None,
                        "raw": order_data, "received_at": time.time()}
            with self._lock:
                reject = self._reject_callbacks.pop(order_id, None)
                cancel = self._cancel_callbacks.pop(order_id, None)
                self._fill_callbacks.pop(order_id, None)
                self._terminal_orders.add(order_id)
                if status == "cancelled" and cancel is None:
                    self._pending_cancellations[order_id] = metadata
                    if len(self._pending_cancellations) > 1024:
                        self._pending_cancellations.pop(next(iter(self._pending_cancellations)))
                if reject is None and cancel is None:
                    self._pending_rejects[order_id] = reason or "Order rejected by exchange"
            logger.warning("Kotak order %s %s: %s", order_id, status, reason or "reason missing")
            if status == "cancelled" and cancel:
                callback, loop = cancel
                loop.call_soon_threadsafe(callback, order_id, metadata)
            elif reject:
                callback, loop = reject
                loop.call_soon_threadsafe(callback, order_id, reason or "Order rejected by exchange")
        else:
            logger.debug("Kotak order %s status update: %s", order_id, status)


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
        """SDK REST failures are returned as dictionaries, not just exceptions."""
        if not isinstance(resp, dict):
            return
        if isinstance(resp.get("data"), dict):
            self._check_api_response(resp["data"])
        error = next((resp[k] for k in ("errMsg", "Error", "error", "Error Message", "fault")
                      if resp.get(k)), None)
        if isinstance(error, BaseException):
            # v3 catches transport/SDK exceptions and returns {"Error": exc}.
            # That dictionary is not an exchange rejection and cannot justify resubmission.
            raise KotakError(f"Kotak SDK/transport failure: {error}") from error
        status = str(resp.get("stat") or resp.get("status") or "").lower()
        code = str(resp.get("stCode", ""))
        http_status = str(resp.get("status_code") or resp.get("StatusCode") or "")
        if isinstance(error, list):
            code = str(error[0].get("code", code)) if error and isinstance(error[0], dict) else code
            error = "; ".join(str(e.get("message", "Broker error")) if isinstance(e, dict) else str(e) for e in error)
        if isinstance(error, dict):
            code = str(error.get("code", code))
            error = error.get("message") or "Broker error"
        if http_status.isdigit() and int(http_status) >= 500:
            raise KotakError(f"Kotak server response is ambiguous (HTTP {http_status})")
        expired = code in ("100008", "401", "403") or http_status in ("401", "403") or bool(resp.get("Error Message"))
        failed = status in ("not_ok", "not ok", "error", "failed", "failure") or (http_status.isdigit() and int(http_status) >= 400)
        if expired:
            self.shutdown()
            raise KotakOrderRejected("Kotak session expired (unauthorized) — please reconnect via Settings")
        if error or failed or (code and code not in ("200", "0") and status not in ("ok", "success")):
            raise KotakOrderRejected(f"Kotak API error: {error or resp.get('stat') or 'unknown error'} (code {code})")

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
        raise KotakError("Unexpected Kotak order response (no order ID)")

    def _check_order_ack(self, resp: Any) -> None:
        self._check_api_response(resp)
        data = resp.get("data", resp) if isinstance(resp, dict) else None
        if not isinstance(data, dict) or not (
            str(data.get("stat") or data.get("status") or "").lower() in ("ok", "success")
            or data.get("nOrdNo") or data.get("order_id")
        ):
            raise KotakError("Malformed Kotak order acknowledgement")


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

    A dedicated SFeed socket delivers normalized "stock_feed" messages through
    register_market_data_callback; order events use a separate socket.
    Completed 1-second OHLC candles are pushed to session queues using
    loop.call_soon_threadsafe so asyncio loops receive them safely from the
    background WebSocket thread.

    Authentication: KotakNeoService must be authenticated before register() is
    called. is_ready() should be checked before use; paper sessions fall back to
    Kite if Kotak is not available.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Serialize mutations and bridge waits without holding the tick lock.
        self._operation_lock = threading.RLock()
        self._token_sessions: dict[tuple[str, str], dict[str, tuple]] = defaultdict(dict)
        self._session_tokens: dict[str, set[tuple[str, str]]] = defaultdict(set)
        self._token_is_index: dict[tuple[str, str], bool] = {}
        self._accumulators: dict[tuple[str, str], _KotakOHLCAccumulator] = defaultdict(_KotakOHLCAccumulator)
        self._subscribed = False

    def is_ready(self) -> bool:
        return _service.is_authenticated()

    def _subscriptions(self):
        with self._lock:
            return [{"exchange_segment": exchange, "instrument_token": token,
                     "is_index": self._token_is_index[(exchange, token)]}
                    for exchange, token in self._token_sessions]

    def _subscribe_all(self, *, wait=True) -> None:
        with self._operation_lock:
            subscriptions = self._subscriptions()
            if not subscriptions:
                return
            _service.register_market_data_callback(self._on_ticks)
            _service.replace_market_subscriptions(subscriptions, wait=wait)
            self._subscribed = True

    def register(self, session_id, tokens, exchanges, rights, queue, loop, is_indices=None) -> None:
        """Share exact exchange/token subscriptions, separating indices from scrips."""
        is_indices = is_indices if is_indices is not None else [False] * len(tokens)
        if not len(tokens) == len(exchanges) == len(rights) == len(is_indices):
            raise KotakError("Kotak subscription lists have different lengths")
        with self._operation_lock:
            with self._lock:
                for token, exchange, right, is_index in zip(tokens, exchanges, rights, is_indices):
                    key = (exchange, str(token))
                    self._token_sessions[key][session_id] = (queue, right, loop)
                    self._session_tokens[session_id].add(key)
                    self._token_is_index[key] = is_index
            try:
                self._subscribe_all()
            except Exception:
                self.unregister(session_id)
                raise

    def _remove_key(self, session_id, key):
        self._token_sessions[key].pop(session_id, None)
        self._session_tokens[session_id].discard(key)
        if not self._token_sessions[key]:
            self._token_sessions.pop(key, None)
            self._token_is_index.pop(key, None)
            self._accumulators.pop(key, None)

    def unregister(self, session_id) -> None:
        with self._operation_lock:
            with self._lock:
                for key in list(self._session_tokens.get(session_id, ())):
                    self._remove_key(session_id, key)
                self._session_tokens.pop(session_id, None)
            subscriptions = self._subscriptions()
            if _service.is_authenticated():
                try:
                    _service.replace_market_subscriptions(subscriptions)
                except KotakError as exc:
                    logger.warning("Kotak unsubscribe failed: %s", exc)
            self._subscribed = bool(subscriptions)
            if not subscriptions:
                _service.register_market_data_callback(None)

    def update_session_right(self, session_id, right, new_token, new_exchange, queue, loop) -> None:
        """Commit a strike replacement only after the new subscription succeeds."""
        new_key = (new_exchange, str(new_token))
        with self._operation_lock:
            with self._lock:
                if session_id not in self._session_tokens:
                    return
                old_key = next((key for key in self._session_tokens[session_id]
                                if self._token_sessions[key][session_id][1] == right), None)
                orphan = old_key != new_key and old_key is not None and len(self._token_sessions[old_key]) == 1
            subscriptions = [s for s in self._subscriptions()
                             if not orphan or (s["exchange_segment"], s["instrument_token"]) != old_key]
            if not any((s["exchange_segment"], s["instrument_token"]) == new_key for s in subscriptions):
                subscriptions.append({"exchange_segment": new_exchange, "instrument_token": str(new_token), "is_index": False})
            _service.replace_market_subscriptions(subscriptions)
            with self._lock:
                if old_key is not None and old_key != new_key:
                    self._remove_key(session_id, old_key)
                self._token_sessions[new_key][session_id] = (queue, right, loop)
                self._session_tokens[session_id].add(new_key)
                self._token_is_index[new_key] = False

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

        if not math.isfinite(price) or price <= 0:
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
                ts_second = (ts_int if ts_int > 0 else int(time.time())) + _IST_OFFSET
            except (TypeError, ValueError):
                ts_second = int(time.time()) + _IST_OFFSET
        else:
            ts_second = int(time.time()) + _IST_OFFSET

        key = (tick.get("e") or tick.get("exchange_segment"), token)
        with self._lock:
            session_entries = dict(self._token_sessions.get(key, {}))
            if not session_entries:
                return
            completed = self._accumulators[key].update(price, ts_second)
        if completed is None:
            return

        if not session_entries:
            logger.debug(
                "KotakBroadcaster: no sessions for token %s — dropped candle", token
            )
            return

        for sid, (queue, right, loop) in session_entries.items():
            tick_payload = {**completed, "right": right, "provider_token": token}
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
