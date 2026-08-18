#!/usr/bin/env python3
"""
Test broker streaming data — standalone script.

Usage:
  python scripts/test_broker_streaming.py [breeze|kite|kotak|fyers] [--symbol NIFTY|BSESEN]

  - breeze: ICICI Direct Breeze WebSocket
  - kite:   Zerodha Kite WebSocket
  - kotak:  Kotak Neo WebSocket (requires OTP)
  - fyers:  Fyers WebSocket

  --symbol NIFTY   Subscribe to NIFTY 50 index + ATM NIFTY options (NSE/NFO)
  --symbol BSESEN  Subscribe to SENSEX index + ATM SENSEX options (BSE/BFO)

All logs go to <data/accesskeys.ini [paths].logs>/test_broker_streaming.log

This script subscribes to the chosen index + its ATM options.
The ATM strike is determined from the first index tick received.
"""
import argparse
import configparser
import json
import logging
import os
import signal
import sys
import threading
import time as _time
from datetime import date, datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Path setup — add backend/ to sys.path so we can import app modules
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(PROJECT_ROOT / "backend"))

DATA_DIR = Path(os.getenv("DATA_DIR", str(PROJECT_ROOT / "data")))
INI_PATH = DATA_DIR / "accesskeys.ini"

# ---------------------------------------------------------------------------
# Logging setup — reads log dir from accesskeys.ini [paths]
# ---------------------------------------------------------------------------
_cfg = configparser.ConfigParser()
_cfg.read(str(INI_PATH))
LOG_DIR = Path(_cfg["paths"].get("logs", str(DATA_DIR / "logs")))
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "test_broker_streaming.log"

logger = logging.getLogger("test_broker_streaming")
logger.setLevel(logging.DEBUG)

fh = logging.FileHandler(str(LOG_FILE), encoding="utf-8")
fh.setLevel(logging.DEBUG)
fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))

ch = logging.StreamHandler(sys.stdout)
ch.setLevel(logging.INFO)
ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

logger.addHandler(fh)
logger.addHandler(ch)

logger.info("=" * 60)
logger.info("Test broker streaming started — log file: %s", LOG_FILE)
logger.info("=" * 60)

# ---------------------------------------------------------------------------
# Shutdown event
# ---------------------------------------------------------------------------
shutdown_event = threading.Event()

def _sig_handler(sig, frame):
    logger.info("Received signal %s — shutting down", sig)
    shutdown_event.set()

signal.signal(signal.SIGINT, _sig_handler)
signal.signal(signal.SIGTERM, _sig_handler)

# ---------------------------------------------------------------------------
# DDB token helpers (reads BrokerTokens table from DynamoDB Local)
# ---------------------------------------------------------------------------

def _get_ddb_token(sk: str) -> str | None:
    """Read a token override from the DDB BrokerTokens table."""
    try:
        from app.services.token_service import get_token
        return get_token(sk)
    except Exception as exc:
        logger.debug("DDB token read failed for %s: %s", sk, exc)
        return None


# ---------------------------------------------------------------------------
# Per-symbol configuration — mirrors backend SUPPORTED_SYMBOLS
# ---------------------------------------------------------------------------
# Canonical key → broker-specific parameters.
# NIFTY is NSE/NFO; BSESEN (SENSEX) is BSE/BFO.
SYMBOL_INFO: dict[str, dict] = {
    "NIFTY": {
        "display_name": "NIFTY 50",
        "index_token_kite": 256265,        # NIFTY 50 index on NSE
        "index_exchange_kite": "NSE",
        "index_exchange_breeze": "NSE",
        "stock_code_breeze": "NIFTY",
        "options_exchange_kite": "NFO",
        "options_exchange_breeze": "NFO",
        "options_exchange_kotak": "nse_fo",
        "options_exchange_fyers": "NSE",
        "base_name_kotak": "NIFTY",
        "base_name_fyers": "NIFTY",
        "strike_interval": 50,
        "lot_size": 65,
        # Breeze subscribe right values are LOWERCASE "call"/"put"
        "breeze_rights": ("call", "put"),
        # Kite/Kotak/Fyers option rights are UPPERCASE "CE"/"PE"
        "upper_rights": ("CE", "PE"),
    },
    "BSESEN": {
        "display_name": "SENSEX",
        "index_token_kite": 265,            # SENSEX index on BSE
        "index_exchange_kite": "BSE",
        "index_exchange_breeze": "BSE",
        "stock_code_breeze": "BSESEN",      # Breeze raw code is "BSESEN"
        "options_exchange_kite": "BFO",
        "options_exchange_breeze": "BFO",
        "options_exchange_kotak": "bse_fo",
        "options_exchange_fyers": "BSE",
        "base_name_kotak": "SENSEX",
        "base_name_fyers": "SENSEX",
        "strike_interval": 100,
        "lot_size": 20,
        "breeze_rights": ("call", "put"),
        "upper_rights": ("CE", "PE"),
    },
}


# ---------------------------------------------------------------------------
# Options helpers — replicate options_service logic for standalone use
# ---------------------------------------------------------------------------

STRIKE_INTERVALS = {"NIFTY": 50, "BSESEN": 100, "RELIND": 5, "TATMOT": 5, "TATPOW": 5}
_CUTOFF_DATE = date(2025, 9, 1)
NSE_HOLIDAYS: frozenset[date] = frozenset({
    date(2025, 10, 2),  date(2025, 10, 21), date(2025, 10, 22),
    date(2025, 11, 5),  date(2025, 12, 25),
    date(2026, 1, 1),   date(2026, 1, 26),  date(2026, 2, 18),
    date(2026, 3, 6),   date(2026, 3, 20),  date(2026, 3, 25),
    date(2026, 4, 3),   date(2026, 4, 14),  date(2026, 4, 15),
    date(2026, 4, 20),  date(2026, 5, 1),   date(2026, 5, 20),
    date(2026, 6, 29),  date(2026, 7, 7),
    date(2026, 8, 5),   date(2026, 8, 15),  date(2026, 8, 27),
    date(2026, 10, 2),  date(2026, 11, 10), date(2026, 11, 16),
    date(2026, 12, 25),
})


def _is_trading_day(d: date) -> bool:
    if d.weekday() in (5, 6):
        return False
    return d not in NSE_HOLIDAYS


def _prev_trading_day(d: date) -> date:
    d -= timedelta(days=1)
    while not _is_trading_day(d):
        d -= timedelta(days=1)
    return d


def get_weekly_expiry(trading_date_str: str, symbol: str = "NIFTY") -> str:
    d = date.fromisoformat(trading_date_str)
    # BSESEN (SENSEX) weekly expiry is always Thursday (weekday 3).
    # NSE: Tuesday (1) from 2025-09-01, Thursday (3) before.
    if symbol == "BSESEN":
        target_wd = 3
    else:
        target_wd = 1 if d >= _CUTOFF_DATE else 3
    days_ahead = (target_wd - d.weekday()) % 7
    expiry = d + timedelta(days=days_ahead)
    if not _is_trading_day(expiry):
        expiry = _prev_trading_day(expiry)
    return expiry.isoformat()


def get_atm_strike(price: float, symbol: str = "NIFTY") -> int:
    interval = STRIKE_INTERVALS.get(symbol, 50)
    atm = round(price / interval) * interval
    return int(atm)


# ---------------------------------------------------------------------------
# Breeze (ICICI Direct) streaming
# ---------------------------------------------------------------------------

class BreezeStreamTester:
    def __init__(self, symbol: str = "NIFTY"):
        self._breeze = None
        self._tick_count = 0
        self._subscribed_options = False
        self._index_price = 0.0
        self.symbol = symbol
        self.info = SYMBOL_INFO[symbol]

    def _get_breeze(self):
        from breeze_connect import BreezeConnect
        cfg = configparser.ConfigParser()
        cfg.read(str(INI_PATH))
        section = cfg["icicidirect"]
        api_key = section["api_key"].strip()
        api_secret = section["api_secret"].strip()
        session_token = _get_ddb_token("icici_session") or section["session_token"].strip()

        breeze = BreezeConnect(api_key=api_key)
        result = breeze.generate_session(api_secret=api_secret, session_token=session_token)
        logger.info("Breeze session result: %s", json.dumps(result, default=str))
        return breeze

    def _on_ticks(self, ticks):
        if isinstance(ticks, str):
            try:
                ticks = json.loads(ticks)
            except Exception:
                return
        if isinstance(ticks, dict):
            ticks = [ticks]
        if not isinstance(ticks, list):
            return

        for tick in ticks:
            if not isinstance(tick, dict):
                continue
            self._tick_count += 1

            ltp = float(tick.get("last", tick.get("ltp", 0.0)))
            name = tick.get("stock_name", tick.get("stock_code", ""))
            exchange = tick.get("exchange", "")
            right_raw = tick.get("right", "").upper()
            strike = tick.get("strike_price", "")

            logger.info(
                "BREEZE TICK #%d: name=%s exchange=%s ltp=%.2f right=%s strike=%s",
                self._tick_count, name, exchange, ltp, right_raw, strike,
            )

            # Once we have the index price for the chosen symbol, subscribe to options.
            # Breeze sends right="" for cash/index ticks.
            stock_code = self.info["stock_code_breeze"]
            if (
                not self._subscribed_options
                and stock_code in name.upper()
                and right_raw == ""
                and ltp > 0
            ):
                self._index_price = ltp
                self._subscribe_options(ltp)

    def _subscribe_options(self, price: float):
        atm = get_atm_strike(price, self.symbol)
        expiry = get_weekly_expiry(date.today().isoformat(), self.symbol)
        expiry_breeze = datetime.strptime(expiry, "%Y-%m-%d").strftime("%d-%b-%Y")

        logger.info(
            "BREEZE: %s LTP=%.2f → ATM strike=%d expiry=%s — subscribing options",
            self.info["display_name"], price, atm, expiry,
        )

        for right in self.info["breeze_rights"]:
            logger.info(
                "BREEZE: subscribing %s %s %d %s %s",
                self.info["stock_code_breeze"], right.upper(), atm, expiry_breeze,
                self.info["options_exchange_breeze"],
            )
            try:
                self._breeze.subscribe_feeds(
                    exchange_code=self.info["options_exchange_breeze"],
                    stock_code=self.info["stock_code_breeze"],
                    product_type="options",
                    expiry_date=expiry_breeze,
                    strike_price=str(atm),
                    right=right,
                    get_exchange_quotes=True,
                    get_market_depth=False,
                )
            except Exception as exc:
                logger.error("BREEZE: options subscribe failed for %s %d: %s", right, atm, exc)

        self._subscribed_options = True

    def run(self):
        logger.info(
            "BREEZE: connecting to ICICI Direct WebSocket (symbol=%s)...",
            self.info["display_name"],
        )
        self._breeze = self._get_breeze()
        self._breeze.on_ticks = self._on_ticks
        self._breeze.ws_connect()

        # Subscribe to the chosen index (cash product on its native exchange).
        logger.info(
            "BREEZE: subscribing %s index (%s, cash)",
            self.info["display_name"], self.info["index_exchange_breeze"],
        )
        self._breeze.subscribe_feeds(
            exchange_code=self.info["index_exchange_breeze"],
            stock_code=self.info["stock_code_breeze"],
            product_type="cash",
            expiry_date="",
            strike_price="",
            right="",
            get_exchange_quotes=True,
            get_market_depth=False,
        )

        logger.info("BREEZE: streaming started — waiting for ticks... (Ctrl+C to stop)")

        while not shutdown_event.is_set():
            _time.sleep(0.5)

    def stop(self):
        if self._breeze:
            try:
                self._breeze.ws_disconnect()
            except Exception:
                pass
        logger.info("BREEZE: total ticks received: %d", self._tick_count)


# ---------------------------------------------------------------------------
# Kite (Zerodha) streaming
# ---------------------------------------------------------------------------

class KiteStreamTester:
    def __init__(self, symbol: str = "NIFTY"):
        self._ticker = None
        self._tick_count = 0
        self._subscribed_options = False
        self._index_price = 0.0
        self._accumulators: dict[int, dict] = {}
        self.symbol = symbol
        self.info = SYMBOL_INFO[symbol]
        self._index_token = self.info["index_token_kite"]

    def _read_kite_config(self):
        cfg = configparser.ConfigParser()
        cfg.read(str(INI_PATH))
        section = cfg["kite"]
        api_key = section["api_key"].strip()
        access_token = _get_ddb_token("kite_access") or section["access_token"].strip()
        return api_key, access_token

    def _lookup_options_token(self, strike: int, expiry: str, right: str):
        import csv
        from app.config import DATA_DIR
        exchange = self.info["options_exchange_kite"]
        cache = DATA_DIR / f"kite_instruments_{exchange}.csv"
        expiry_dt = datetime.strptime(expiry, "%Y-%m-%d")
        # Kite tradingsymbol name for options: NIFTY for NIFTY, SENSEX for BSESEN
        base_name = self.info["base_name_kotak"]
        with open(cache, newline="") as f:
            for row in csv.DictReader(f):
                try:
                    row_strike = float(row.get("strike", 0))
                    row_expiry = datetime.strptime(row.get("expiry", "1900-01-01"), "%Y-%m-%d")
                except (ValueError, TypeError):
                    continue
                if (
                    row.get("name", "").upper() == base_name.upper()
                    and row.get("instrument_type", "").upper() == right.upper()
                    and row_expiry == expiry_dt
                    and abs(row_strike - strike) < 0.5
                ):
                    return int(row["instrument_token"])
        raise ValueError(
            f"Options token not found: {base_name} {right} {strike} {expiry} (cache={cache})"
        )

    def _subscribe_options(self, price: float, ws):
        atm = get_atm_strike(price, self.symbol)
        expiry = get_weekly_expiry(date.today().isoformat(), self.symbol)

        logger.info(
            "KITE: %s LTP=%.2f → ATM strike=%d expiry=%s — subscribing options",
            self.info["display_name"], price, atm, expiry,
        )

        tokens = []
        for right in self.info["upper_rights"]:
            try:
                tok = self._lookup_options_token(atm, expiry, right)
                tokens.append(tok)
                logger.info(
                    "KITE: resolved %s %s %d expiry=%s → token=%d",
                    self.info["display_name"], right, atm, expiry, tok,
                )
            except ValueError as exc:
                logger.error("KITE: %s", exc)

        if tokens:
            ws.subscribe(tokens)
            ws.set_mode(ws.MODE_LTP, tokens)
            logger.info("KITE: subscribed %d option tokens in LTP mode", len(tokens))
        self._subscribed_options = True

    def _on_connect(self, ws, response):
        logger.info("KITE: WebSocket connected — response=%s", response)
        ws.subscribe([self._index_token])
        ws.set_mode(ws.MODE_LTP, [self._index_token])
        logger.info(
            "KITE: subscribed %s index token=%d in LTP mode",
            self.info["display_name"], self._index_token,
        )

    def _on_ticks(self, ws, ticks):
        _IST_OFFSET = 19800

        for tick in ticks:
            token = tick.get("instrument_token")
            if token is None:
                continue
            price = float(tick.get("last_price", 0.0))
            if price == 0.0:
                continue

            self._tick_count += 1
            ex_ts = tick.get("exchange_timestamp")
            if ex_ts and isinstance(ex_ts, datetime):
                ts_second = int(ex_ts.timestamp()) + _IST_OFFSET
            else:
                ts_second = int(_time.time()) + _IST_OFFSET

            logger.info(
                "KITE TICK #%d: token=%d ltp=%.2f ts=%s",
                self._tick_count, token, price,
                datetime.fromtimestamp(ts_second - _IST_OFFSET).isoformat() if ex_ts else "now",
            )

            # Accumulate into 1-sec OHLC
            if token not in self._accumulators:
                self._accumulators[token] = {
                    "open": price, "high": price, "low": price,
                    "close": price, "current_second": ts_second,
                }
            else:
                acc = self._accumulators[token]
                if ts_second != acc["current_second"]:
                    logger.info(
                        "KITE OHLC token=%d O=%.2f H=%.2f L=%.2f C=%.2f time=%d",
                        token, acc["open"], acc["high"], acc["low"], acc["close"],
                        acc["current_second"],
                    )
                    acc["open"] = acc["high"] = acc["low"] = acc["close"] = price
                    acc["current_second"] = ts_second
                else:
                    acc["high"] = max(acc["high"], price)
                    acc["low"] = min(acc["low"], price)
                    acc["close"] = price

            # On first index tick, subscribe options
            if not self._subscribed_options and token == self._index_token and price > 0:
                self._index_price = price
                self._subscribe_options(price, ws)

    def _on_error(self, ws, code, reason):
        logger.error("KITE: WebSocket error — code=%s reason=%s", code, reason)

    def _on_close(self, ws, code, reason):
        logger.warning("KITE: WebSocket closed — code=%s reason=%s", code, reason)

    def run(self):
        from kiteconnect import KiteTicker
        api_key, access_token = self._read_kite_config()
        logger.info(
            "KITE: connecting with api_key=%s access_token=%s... (symbol=%s)",
            api_key, access_token[:8] + "..." if len(access_token) > 8 else access_token,
            self.info["display_name"],
        )

        ticker = KiteTicker(api_key, access_token)
        ticker.on_connect = self._on_connect
        ticker.on_ticks = self._on_ticks
        ticker.on_error = self._on_error
        ticker.on_close = self._on_close
        self._ticker = ticker

        ticker.connect(threaded=True)
        logger.info("KITE: streaming started — waiting for ticks... (Ctrl+C to stop)")

        while not shutdown_event.is_set():
            _time.sleep(0.5)

    def stop(self):
        if self._ticker:
            try:
                self._ticker.close()
            except Exception:
                pass
        logger.info("KITE: total ticks received: %d", self._tick_count)


# ---------------------------------------------------------------------------
# Kotak Neo streaming
# ---------------------------------------------------------------------------

class KotakStreamTester:
    def __init__(self, symbol: str = "NIFTY"):
        self._client = None
        self._tick_count = 0
        self._subscribed_options = False
        self._index_price = 0.0
        self._accumulators: dict[str, dict] = {}
        self.symbol = symbol
        self.info = SYMBOL_INFO[symbol]
        self._index_token: str | None = None
        self._index_exchange: str | None = None

    def _read_kotak_config(self):
        cfg = configparser.ConfigParser()
        cfg.read(str(INI_PATH))
        section = cfg["kotakneo"]
        return {
            "access_token": section["access_token"].strip(),  # consumer_key
            "mobile": section["mobile"].strip(),
            "ucc": section["ucc"].strip(),
            "mpin": section["mpin"].strip(),
        }

    def _get_instruments(self):
        cache_path = DATA_DIR / "kotak_instruments.json"
        with open(cache_path) as f:
            return json.load(f)

    def _get_index_token(self, instruments):
        # NIFTY index lives in nse_cm; SENSEX index lives in bse_cm.
        # Tradingsymbol on the index segment matches the canonical display name.
        base_name = self.info["base_name_kotak"]
        index_exchange = "bse_cm" if self.symbol == "BSESEN" else "nse_cm"
        for inst in instruments:
            if inst["symbol"] == base_name and inst["exchange"] == index_exchange:
                return inst["instrument_token"], inst["exchange"]
        raise ValueError(
            f"{base_name} index token not found in kotak_instruments.json (exchange={index_exchange})"
        )

    def _build_options_symbol(self, expiry: str, strike: int, right: str) -> str:
        expiry_dt = datetime.strptime(expiry, "%Y-%m-%d").date()
        yy = expiry_dt.strftime("%y")
        base = self.info["base_name_kotak"]
        if (expiry_dt + timedelta(days=7)).month != expiry_dt.month:
            month_part = expiry_dt.strftime("%b").upper()
        else:
            m = expiry_dt.month
            dd = expiry_dt.strftime("%d")
            month_part = f"{m}{dd}"
        return f"{base}{yy}{month_part}{strike}{right}"

    def _lookup_options_token(self, instruments, expiry: str, strike: int, right: str):
        kotak_sym = self._build_options_symbol(expiry, strike, right)
        logger.info("KOTAK: looking up options symbol %s", kotak_sym)
        opts_exchange = self.info["options_exchange_kotak"]
        for inst in instruments:
            if inst["symbol"] == kotak_sym and inst["exchange"] == opts_exchange:
                return inst["instrument_token"], inst["exchange"]
        raise ValueError(f"Options token not found: {kotak_sym} (exchange={opts_exchange})")

    def _on_message(self, message):
        try:
            if isinstance(message, (bytes, bytearray)):
                message = message.decode()
            if isinstance(message, str):
                message = json.loads(message)
            if not isinstance(message, dict):
                return

            msg_type = message.get("type", "")
            if msg_type != "stock_feed":
                logger.debug("KOTAK: ignoring msg type=%s", msg_type)
                return

            raw_data = message.get("data", {})
            if isinstance(raw_data, dict):
                ticks = [raw_data]
            elif isinstance(raw_data, list):
                ticks = raw_data
            else:
                return

            for tick in ticks:
                if not isinstance(tick, dict):
                    continue
                self._process_tick(tick)
        except Exception as exc:
            logger.warning("KOTAK: message handler error: %s", exc)

    def _process_tick(self, tick):
        token = str(
            tick.get("tk") or tick.get("instrument_token") or
            tick.get("scrip_token") or tick.get("token") or ""
        )
        if not token:
            return

        ltp = float(
            tick.get("ltP") or tick.get("ltp") or
            tick.get("last_price") or tick.get("close") or 0
        )
        if ltp <= 0:
            return

        self._tick_count += 1
        _IST_OFFSET = 19800
        ts_raw = tick.get("exchange_timestamp") or tick.get("timestamp") or tick.get("ttime")
        if ts_raw is not None:
            try:
                ts_int = int(ts_raw)
                ts_second = ts_int + _IST_OFFSET if ts_int < 2_000_000_000 else ts_int
            except (TypeError, ValueError):
                ts_second = int(_time.time()) + _IST_OFFSET
        else:
            ts_second = int(_time.time()) + _IST_OFFSET

        logger.info("KOTAK TICK #%d: token=%s ltp=%.2f", self._tick_count, token, ltp)

        # Accumulate into 1-sec OHLC
        if token not in self._accumulators:
            self._accumulators[token] = {
                "open": ltp, "high": ltp, "low": ltp,
                "close": ltp, "current_second": ts_second,
            }
        else:
            acc = self._accumulators[token]
            if ts_second != acc["current_second"]:
                logger.info(
                    "KOTAK OHLC token=%s O=%.2f H=%.2f L=%.2f C=%.2f time=%d",
                    token, acc["open"], acc["high"], acc["low"], acc["close"],
                    acc["current_second"],
                )
                acc["open"] = acc["high"] = acc["low"] = acc["close"] = ltp
                acc["current_second"] = ts_second
            else:
                acc["high"] = max(acc["high"], ltp)
                acc["low"] = min(acc["low"], ltp)
                acc["close"] = ltp

        # On first index tick, subscribe options
        if not self._subscribed_options and ltp > 0 and self._index_token and token == self._index_token:
            self._index_price = ltp
            instruments = self._get_instruments()
            self._subscribe_options(ltp, instruments)

    def _subscribe_options(self, price: float, instruments):
        atm = get_atm_strike(price, self.symbol)
        expiry = get_weekly_expiry(date.today().isoformat(), self.symbol)

        logger.info(
            "KOTAK: %s LTP=%.2f → ATM strike=%d expiry=%s — subscribing options",
            self.info["display_name"], price, atm, expiry,
        )

        tokens = []
        for right in self.info["upper_rights"]:
            try:
                tok, exch = self._lookup_options_token(instruments, expiry, atm, right)
                tokens.append({"instrument_token": tok, "exchange_segment": exch})
                logger.info(
                    "KOTAK: resolved %s %s %d expiry=%s → token=%s exchange=%s",
                    self.info["display_name"], right, atm, expiry, tok, exch,
                )
            except ValueError as exc:
                logger.error("KOTAK: %s", exc)

        if tokens:
            try:
                self._client.subscribe(
                    instrument_tokens=tokens,
                    isIndex=False,
                    isDepth=False,
                )
                logger.info("KOTAK: subscribed %d option tokens", len(tokens))
            except Exception as exc:
                logger.error("KOTAK: options subscribe failed: %s", exc)

        self._subscribed_options = True

    def run(self):
        from neo_api_client import NeoAPI
        creds = self._read_kotak_config()

        # Ask for OTP
        logger.info("KOTAK: requesting TOTP/OTP...")
        totp = input("Enter Kotak Neo OTP/TOTP: ").strip()
        if not totp:
            logger.error("KOTAK: no OTP provided — exiting")
            return

        logger.info("KOTAK: authenticating mobile=%s ucc=%s...", creds["mobile"], creds["ucc"])
        client = NeoAPI(
            environment="prod",
            access_token=None,
            neo_fin_key=None,
            consumer_key=creds["access_token"],
        )
        try:
            client.totp_login(
                mobile_number=creds["mobile"],
                ucc=creds["ucc"],
                totp=totp,
            )
            client.totp_validate(mpin=creds["mpin"])
            logger.info("KOTAK: authenticated successfully")
        except Exception as exc:
            logger.error("KOTAK: authentication failed: %s", exc)
            return

        self._client = client

        # Set up order feed WebSocket (market data rides on this)
        client.on_message = self._on_message
        client.on_error = lambda *a: logger.error("KOTAK: WebSocket error: %s", a)
        client.on_close = lambda *a: logger.warning("KOTAK: WebSocket closed: %s", a)
        client.on_open = lambda *a: logger.info("KOTAK: WebSocket opened")
        client.subscribe_to_orderfeed()

        # Load instrument master to find the index token for the chosen symbol.
        instruments = self._get_instruments()
        self._index_token, self._index_exchange = self._get_index_token(instruments)
        logger.info(
            "KOTAK: %s index token=%s exchange=%s",
            self.info["display_name"], self._index_token, self._index_exchange,
        )

        # Subscribe index
        client.subscribe(
            instrument_tokens=[
                {"instrument_token": self._index_token, "exchange_segment": self._index_exchange},
            ],
            isIndex=True,
            isDepth=False,
        )
        logger.info("KOTAK: subscribed %s index (isIndex=True)", self.info["display_name"])

        logger.info("KOTAK: streaming started — waiting for ticks... (Ctrl+C to stop)")

        while not shutdown_event.is_set():
            _time.sleep(0.5)

    def stop(self):
        logger.info("KOTAK: total ticks received: %d", self._tick_count)


# ---------------------------------------------------------------------------
# Fyers streaming
# ---------------------------------------------------------------------------

class FyersStreamTester:
    _MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                   "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

    def __init__(self, symbol: str = "NIFTY"):
        self._fyers = None
        self._tick_count = 0
        self._subscribed_options = False
        self._index_price = 0.0
        self._accumulators: dict[str, dict] = {}
        self._connected = threading.Event()
        self.symbol = symbol
        self.info = SYMBOL_INFO[symbol]
        # Fyers index symbol: "NSE:NIFTY50-INDEX" for NIFTY (special-cased)
        # but "BSE:SENSEX-INDEX" for BSESEN.
        if symbol == "NIFTY":
            self._index_symbol = f"{self.info['options_exchange_fyers']}:NIFTY50-INDEX"
        else:
            self._index_symbol = f"{self.info['options_exchange_fyers']}:SENSEX-INDEX"

    def _read_fyers_config(self):
        cfg = configparser.ConfigParser()
        cfg.read(str(INI_PATH))
        section = cfg["fyers"]
        app_id = section["app_id"].strip()
        access_token = _get_ddb_token("fyers_access") or section["access_token"].strip()
        return app_id, access_token

    def _on_connect(self, ws, response=None):
        logger.info("FYERS: WebSocket connected — response=%s", response)
        self._connected.set()

        ws.subscribe([self._index_symbol])
        ws.mode(ws.MODE_LTP)
        logger.info("FYERS: subscribed %s in LTP mode", self._index_symbol)

    def _on_message(self, ws, message):
        _IST_OFFSET = 19800
        if not message:
            return
        symbol = message.get("symbol")
        if not symbol:
            return
        ltp = message.get("ltp")
        if ltp is None:
            return
        price = float(ltp)
        if price == 0.0:
            return

        self._tick_count += 1
        exch_feed_time = message.get("exch_feed_time")
        if exch_feed_time:
            ts_second = int(exch_feed_time) + _IST_OFFSET
        else:
            ts_second = int(_time.time()) + _IST_OFFSET

        logger.info("FYERS TICK #%d: symbol=%s ltp=%.2f", self._tick_count, symbol, price)

        # Accumulate into 1-sec OHLC
        if symbol not in self._accumulators:
            self._accumulators[symbol] = {
                "open": price, "high": price, "low": price,
                "close": price, "current_second": ts_second,
            }
        else:
            acc = self._accumulators[symbol]
            if ts_second != acc["current_second"]:
                logger.info(
                    "FYERS OHLC symbol=%s O=%.2f H=%.2f L=%.2f C=%.2f time=%d",
                    symbol, acc["open"], acc["high"], acc["low"], acc["close"],
                    acc["current_second"],
                )
                acc["open"] = acc["high"] = acc["low"] = acc["close"] = price
                acc["current_second"] = ts_second
            else:
                acc["high"] = max(acc["high"], price)
                acc["low"] = min(acc["low"], price)
                acc["close"] = price

        # On first index tick, subscribe options
        if not self._subscribed_options and symbol == self._index_symbol and price > 0:
            self._index_price = price
            self._subscribe_options(price, ws)

    def _subscribe_options(self, price: float, ws):
        atm = get_atm_strike(price, self.symbol)
        expiry = get_weekly_expiry(date.today().isoformat(), self.symbol)
        exp_dt = datetime.strptime(expiry, "%Y-%m-%d")
        day = f"{exp_dt.day:02d}"
        month = self._MONTH_ABBR[exp_dt.month - 1]
        base = self.info["base_name_fyers"]
        exchange = self.info["options_exchange_fyers"]

        logger.info(
            "FYERS: %s LTP=%.2f → ATM strike=%d expiry=%s — subscribing options",
            self.info["display_name"], price, atm, expiry,
        )

        symbols = []
        for right in self.info["upper_rights"]:
            sym = f"{exchange}:{base}{day}{month}{atm}{right}"
            symbols.append(sym)
            logger.info("FYERS: options symbol %s", sym)

        if symbols:
            ws.subscribe(symbols)
            ws.mode(ws.MODE_LTP)
            logger.info("FYERS: subscribed %d option symbols in LTP mode", len(symbols))

        self._subscribed_options = True

    def _on_close(self, ws, code=None, reason=None):
        logger.warning("FYERS: WebSocket closed — code=%s reason=%s", code, reason)

    def _on_error(self, ws, code=None, reason=None):
        logger.error("FYERS: WebSocket error — code=%s reason=%s", code, reason)

    def run(self):
        from fyers_apiv3 import data_ws
        app_id, access_token = self._read_fyers_config()
        access_token_str = f"{app_id}:{access_token}"

        logger.info(
            "FYERS: connecting with app_id=%s... (symbol=%s)",
            app_id, self.info["display_name"],
        )
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
        self._fyers = fyers
        fyers.connect()

        logger.info("FYERS: streaming started — waiting for ticks... (Ctrl+C to stop)")

        while not shutdown_event.is_set():
            _time.sleep(0.5)

    def stop(self):
        if self._fyers:
            try:
                self._fyers.close_connection()
            except Exception:
                pass
        logger.info("FYERS: total ticks received: %d", self._tick_count)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Test broker streaming data (NIFTY or SENSEX index + ATM options)"
    )
    parser.add_argument(
        "broker",
        choices=["breeze", "kite", "kotak", "fyers"],
        help="Broker to test streaming from",
    )
    parser.add_argument(
        "--symbol",
        choices=["NIFTY", "BSESEN"],
        default="NIFTY",
        help="Underlying index to stream: NIFTY (NSE/NFO) or BSESEN/SENSEX (BSE/BFO). Default: NIFTY",
    )
    args = parser.parse_args()

    sym_info = SYMBOL_INFO[args.symbol]
    logger.info(
        "Selected symbol=%s (%s) — strike interval=%d lot size=%d",
        args.symbol, sym_info["display_name"],
        sym_info["strike_interval"], sym_info["lot_size"],
    )

    # Ensure DynamoDB Local is running for token lookups
    try:
        from app.services.token_service import get_token as _check_ddb
        _check_ddb("kite_access")  # just check connectivity
        logger.info("DynamoDB connection OK")
    except Exception as exc:
        logger.warning("DynamoDB connection issue: %s — continuing without DDB token overrides", exc)

    testers = {
        "breeze": BreezeStreamTester,
        "kite": KiteStreamTester,
        "kotak": KotakStreamTester,
        "fyers": FyersStreamTester,
    }

    tester = testers[args.broker](symbol=args.symbol)
    try:
        tester.run()
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    except Exception as exc:
        logger.exception("Fatal error: %s", exc)
    finally:
        tester.stop()
        logger.info("Test finished. Log file: %s", LOG_FILE)


if __name__ == "__main__":
    main()
