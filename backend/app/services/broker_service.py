"""
Breeze (ICICI Direct) broker integration.
Fetches second-level OHLC data and caches it as Parquet files in
data/ohlcdata/.  Legacy pickle files in data/ are silently migrated
on first access.

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
from app.services.data_loader import parquet_path, pickle_path, validate_and_fill_gaps

_CHUNK_MINUTES = 15   # 900-second windows stay safely under the ~1000-record Breeze API limit
_MIN_DAY_ROWS = 20000  # A complete trading day has ~22500 rows; below this triggers re-fetch

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
    for key in ("api_key", "api_secret"):
        if not section.get(key):
            raise BreezeTokenError(
                f"Missing '{key}' in [icicidirect] section of data/accesskeys.ini."
            )
    # DDB token takes precedence over accesskeys.ini (admin sets it daily via UI)
    try:
        from app.services.token_service import get_token as _get_ddb_token
        session_token = _get_ddb_token("icici_session") or section.get("session_token", "")
    except Exception:
        session_token = section.get("session_token", "")
    if not session_token:
        raise BreezeTokenError(
            "Missing 'session_token' — set it via the Admin panel or in "
            "[icicidirect] section of data/accesskeys.ini."
        )
    return {
        "api_key": section["api_key"],
        "api_secret": section["api_secret"],
        "session_token": session_token,
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
    matching the format of existing data files (tz-naive IST index).
    """
    rows = []
    for r in records:
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
    df = df[~df.index.duplicated(keep="first")]  # remove duplicates from chunk boundaries
    return df


def _fetch_day_paginated(breeze, sym_info: dict, date: str) -> list[dict]:
    """
    Fetch a full trading day by issuing 15-minute chunk requests.
    The Breeze API caps responses at ~1000 records; chunking prevents truncation.
    """
    from_ts = pd.Timestamp(f"{date} {MARKET_OPEN}")
    to_ts = pd.Timestamp(f"{date} {MARKET_CLOSE}")
    chunk_delta = pd.Timedelta(minutes=_CHUNK_MINUTES)

    all_records: list[dict] = []
    current = from_ts
    while current < to_ts:
        chunk_end = min(current + chunk_delta, to_ts)
        response = breeze.get_historical_data_v2(
            interval="1second",
            from_date=current.strftime("%Y-%m-%d %H:%M:%S"),
            to_date=chunk_end.strftime("%Y-%m-%d %H:%M:%S"),
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
            raise RuntimeError(
                f"Breeze API error for {sym_info['breeze_stock_code']} "
                f"{current.strftime('%H:%M')}–{chunk_end.strftime('%H:%M')}: {error}"
            )

        all_records.extend(response.get("Success") or [])
        current = chunk_end

    return all_records


def fetch_historical(symbol: str, date: str) -> Path:
    """
    Ensure second-level OHLC data for symbol+date exists as a complete Parquet file
    in data/ohlcdata/.  Returns the parquet path.

    Cache order:
      1. Parquet in ohlcdata/ with >= _MIN_DAY_ROWS rows — return immediately
      2. Legacy pickle in data/ with >= _MIN_DAY_ROWS rows — convert to parquet, return
      3. Fetch from Breeze API (paginated 15-min chunks) — validate, save as parquet, return

    Raises BreezeTokenError on auth failure, BreezeSymbolError for unknown symbols.
    Incomplete cached files (< _MIN_DAY_ROWS rows) are discarded and re-fetched.
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise BreezeSymbolError(
            f"Symbol '{symbol}' is not supported. "
            f"Supported: {list(SUPPORTED_SYMBOLS.keys())}"
        )

    import time as _time
    from datetime import date as _date
    is_today = date == _date.today().strftime("%Y-%m-%d")

    _TODAY_CACHE_TTL = 600  # 10 minutes — re-fetch today's partial data after this

    pq = parquet_path(symbol, date)
    partial_pq: "Path | None" = None  # preserve partial data for today as fallback

    if pq.exists():
        try:
            if is_today:
                age_secs = _time.time() - pq.stat().st_mtime
                cached_df = pd.read_parquet(pq)
                if len(cached_df) > 0 and age_secs < _TODAY_CACHE_TTL:
                    logger.info(
                        "Parquet cache hit (partial today) for %s %s (%d rows, age %.0fs)",
                        symbol, date, len(cached_df), age_secs,
                    )
                    return pq
                if len(cached_df) > 0:
                    partial_pq = pq  # keep as fallback if Breeze fails
                logger.info(
                    "Today's parquet for %s %s is %s (%.0fs old) — re-fetching",
                    symbol, date, "stale" if age_secs >= _TODAY_CACHE_TTL else "empty", age_secs,
                )
            else:
                cached_df = pd.read_parquet(pq)
                if len(cached_df) >= _MIN_DAY_ROWS:
                    logger.info("Parquet cache hit for %s %s (%d rows)", symbol, date, len(cached_df))
                    return pq
                logger.warning(
                    "Cached parquet for %s %s has only %d rows (< %d), re-fetching",
                    symbol, date, len(cached_df), _MIN_DAY_ROWS,
                )
                pq.unlink()
        except Exception as e:
            logger.warning("Could not read cached parquet for %s %s: %s — re-fetching", symbol, date, e)
            if not is_today:
                pq.unlink(missing_ok=True)

    # Migrate legacy pickle to parquet if it has enough data
    pkl = pickle_path(symbol, date)
    if pkl.exists():
        try:
            pkl_df = pd.read_pickle(pkl)
            if len(pkl_df) >= _MIN_DAY_ROWS:
                logger.info("Migrating complete legacy pickle to parquet for %s %s", symbol, date)
                pkl_df.to_parquet(pq)
                return pq
            logger.warning(
                "Legacy pickle for %s %s has only %d rows, skipping migration — fetching from Breeze",
                symbol, date, len(pkl_df),
            )
        except Exception as e:
            logger.warning("Could not read legacy pickle for %s %s: %s", symbol, date, e)

    # Fetch from Breeze with pagination
    logger.info("Fetching %s %s from Breeze (paginated, %d-min chunks)...", symbol, date, _CHUNK_MINUTES)
    sym_info = SUPPORTED_SYMBOLS[symbol]
    try:
        breeze = _get_breeze()
        records = _fetch_day_paginated(breeze, sym_info, date)
    except (BreezeTokenError, Exception) as exc:
        if partial_pq is not None:
            # Breeze unavailable but we have partial today data — use it
            logger.warning(
                "Breeze unavailable for %s %s (%s); using partial cached data (%s)",
                symbol, date, exc, partial_pq,
            )
            return partial_pq
        raise

    if not records:
        if partial_pq is not None:
            logger.warning("Breeze returned no records for %s %s; using partial cache", symbol, date)
            return partial_pq
        raise RuntimeError(
            f"Breeze returned no data for {symbol} on {date}. "
            "This may be a market holiday or the date is outside available history."
        )

    df = _breeze_to_dataframe(records)
    if df.empty:
        raise RuntimeError(f"Could not parse Breeze data for {symbol} on {date}.")

    df = validate_and_fill_gaps(df, date, partial=is_today)

    tmp = pq.with_name(pq.name + ".tmp")
    try:
        df.to_parquet(tmp)
        os.replace(tmp, pq)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    logger.info("Saved %d rows to %s", len(df), pq)
    return pq
