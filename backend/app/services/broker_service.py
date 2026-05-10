"""
Breeze (ICICI Direct) broker integration.
Fetches second-level OHLC data and caches it as pickle files in DATA_DIR.
Credentials are re-read from data/accesskeys.ini on every call so that
a token refresh takes effect without restarting the backend.
"""
from __future__ import annotations

import configparser
import logging
import os
import pandas as pd
from pathlib import Path

from app.config import DATA_DIR, MARKET_OPEN, MARKET_CLOSE, SUPPORTED_SYMBOLS
from app.services.data_loader import pickle_path

logger = logging.getLogger(__name__)

_CREDENTIALS_PATH = DATA_DIR / "accesskeys.ini"


class BreezeTokenError(Exception):
    """Raised when the Breeze session token is missing or expired."""


class BreezeSymbolError(Exception):
    """Raised when a symbol is not supported for Breeze fetching."""


def _read_breeze_credentials() -> dict[str, str]:
    config = configparser.ConfigParser()
    config.read(_CREDENTIALS_PATH)
    if "icicidirect" not in config:
        raise BreezeTokenError(
            "Missing [icicidirect] section in data/accesskeys.ini. "
            "Please add api_key, api_secret, and session_token."
        )
    section = config["icicidirect"]
    for key in ("api_key", "api_secret", "session_token"):
        if not section.get(key):
            raise BreezeTokenError(
                f"Missing '{key}' in [icicidirect] section of data/accesskeys.ini."
            )
    return {
        "api_key": section["api_key"],
        "api_secret": section["api_secret"],
        "session_token": section["session_token"],
    }


def _get_breeze():
    """Create and authenticate a fresh BreezeConnect instance."""
    try:
        from breeze_connect import BreezeConnect
    except ImportError as e:
        raise ImportError(
            "breeze-connect is not installed. Run: pip install breeze-connect"
        ) from e

    creds = _read_breeze_credentials()
    breeze = BreezeConnect(api_key=creds["api_key"])
    result = breeze.generate_session(
        api_secret=creds["api_secret"],
        session_token=creds["session_token"],
    )
    if result and (
        result.get("Status") not in (200, None)
        or result.get("Error")
    ):
        raise BreezeTokenError(
            f"Breeze session generation failed: {result.get('Error', 'unknown error')}. "
            "Please refresh your session_token in data/accesskeys.ini."
        )
    return breeze


def _breeze_to_dataframe(records: list[dict]) -> pd.DataFrame:
    """
    Convert Breeze API response records to a second-level DataFrame
    matching the format of existing pickle files (tz-naive IST index).
    """
    rows = []
    for r in records:
        # Breeze returns datetime as a string "YYYY-MM-DD HH:MM:SS"
        dt_str = r.get("datetime") or r.get("date") or r.get("time")
        if dt_str is None:
            continue
        rows.append({
            "datetime": pd.Timestamp(str(dt_str)),
            "open": float(r.get("open", 0)),
            "high": float(r.get("high", 0)),
            "low": float(r.get("low", 0)),
            "close": float(r.get("close", 0)),
            "volume": float(r.get("volume", 0)),
        })

    if not rows:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    df = pd.DataFrame(rows)
    df = df.set_index("datetime").sort_index()
    return df


def fetch_historical(symbol: str, date: str) -> Path:
    """
    Ensure second-level OHLC data for symbol+date exists as a pickle file.
    Returns the pickle path. Cache-first: if the pickle already exists, returns
    immediately without calling Breeze.
    Raises BreezeTokenError on auth failure, BreezeSymbolError for unknown symbols.
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise BreezeSymbolError(
            f"Symbol '{symbol}' is not supported. "
            f"Supported: {list(SUPPORTED_SYMBOLS.keys())}"
        )

    path = pickle_path(symbol, date)
    if path.exists():
        logger.info("Cache hit for %s %s — skipping Breeze fetch", symbol, date)
        return path

    logger.info("Fetching %s %s from Breeze...", symbol, date)
    sym_info = SUPPORTED_SYMBOLS[symbol]

    breeze = _get_breeze()

    from_dt = f"{date} {MARKET_OPEN}"
    to_dt = f"{date} {MARKET_CLOSE}"

    response = breeze.get_historical_data_v2(
        interval="1second",
        from_date=from_dt,
        to_date=to_dt,
        stock_code=sym_info["breeze_stock_code"],
        exchange_code=sym_info["exchange_code"],
        product_type=sym_info["product_type"],
    )

    if response is None:
        raise BreezeTokenError(
            "Breeze returned no response. Your session_token may be expired. "
            "Please refresh it in data/accesskeys.ini."
        )

    status = response.get("Status")
    error = response.get("Error")

    if status == 401 or (error and "session" in str(error).lower()):
        raise BreezeTokenError(
            f"Breeze session expired or invalid: {error}. "
            "Please refresh session_token in data/accesskeys.ini."
        )

    if status not in (200, None) and error:
        raise RuntimeError(f"Breeze API error for {symbol} {date}: {error}")

    records = response.get("Success") or []
    if not records:
        raise RuntimeError(
            f"Breeze returned no data for {symbol} on {date}. "
            "This may be a market holiday or the date is outside available history."
        )

    df = _breeze_to_dataframe(records)
    if df.empty:
        raise RuntimeError(f"Could not parse Breeze data for {symbol} on {date}.")

    tmp = path.with_suffix(".tmp")
    try:
        df.to_pickle(tmp)
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    logger.info("Saved %d rows to %s", len(df), path)
    return path
