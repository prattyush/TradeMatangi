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
"""
from __future__ import annotations

import configparser
import json
import logging
import threading
from typing import Any, Callable

logger = logging.getLogger(__name__)

# NSE/BSE minimum tick size is ₹0.05 (5 paise). Kotak rejects prices that are
# not multiples of this value.
_TICK_SIZE = 0.05


def _round_to_tick(price: float) -> float:
    """Round price to the nearest ₹0.05 tick."""
    return round(round(price / _TICK_SIZE) * _TICK_SIZE, 2)


class KotakError(Exception):
    """Raised when Kotak Neo API returns an error or is misconfigured."""


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

    def get_order_history(self) -> list[dict]:
        """Return today's orders from Kotak as a list of dicts."""
        client = self._get_client()
        try:
            resp = client.order_report()
            self._check_api_response(resp)
            if isinstance(resp, list):
                return resp
            if isinstance(resp, dict):
                data = resp.get("data", [])
                return data if isinstance(data, list) else []
            return []
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

    def _on_open(self) -> None:
        logger.info("Kotak Neo order feed WebSocket opened")

    def _on_close(self) -> None:
        logger.warning("Kotak Neo order feed WebSocket closed")

    def _on_error(self, error: Any) -> None:
        logger.error("Kotak Neo order feed WebSocket error: %s", error)

    def _on_message(self, message: Any) -> None:
        """
        Handle incoming messages from the Kotak order feed WebSocket.
        Sample structure: {"type":"order_feed","data":"{\"type\":\"order\",\"data\":{...}}"}
        """
        try:
            if isinstance(message, (bytes, bytearray)):
                message = message.decode()
            if isinstance(message, str):
                message = json.loads(message)
            if not isinstance(message, dict) or message.get("type") != "order_feed":
                return

            raw_data = message.get("data")
            outer = json.loads(raw_data) if isinstance(raw_data, str) else raw_data
            if not isinstance(outer, dict) or outer.get("type") != "order":
                return

            order_data = outer.get("data", {})
            if not isinstance(order_data, dict):
                return

            order_id = str(order_data.get("nOrdNo", ""))
            order_status = str(order_data.get("ordSt", "")).lower()

            if order_status in ("complete", "filled"):
                avg_prc = order_data.get("avgPrc", "0") or "0"
                qty_str = order_data.get("qty", "0") or "0"
                side_code = order_data.get("trnsTp", "B")

                with self._lock:
                    entry = self._fill_callbacks.get(order_id)
                if entry is None:
                    return

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


def get_service() -> KotakNeoService:
    """Return the module-level KotakNeoService singleton."""
    return _service
