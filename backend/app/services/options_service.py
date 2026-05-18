"""
Options data infrastructure: expiry calculation, ATM strike, data fetch, caching,
and margin utilities for naked short positions.
"""
from __future__ import annotations

import datetime
import logging
import os
from pathlib import Path
from typing import Iterator

import pandas as pd

from app.config import DATA_DIR, OHLCDATA_DIR, MARKET_OPEN, MARKET_CLOSE, LOT_SIZES, SUPPORTED_SYMBOLS

logger = logging.getLogger(__name__)

_CHUNK_MINUTES = 15
_CUTOFF_DATE = datetime.date(2025, 9, 1)  # From this date: Tuesday expiry; before: Thursday

STRIKE_INTERVALS: dict[str, int] = {
    "NIFTY": 50,
    "BSESEN": 100,
    "RELIND": 5,
    "TATMOT": 5,
    "TATPOW": 5,
}

# NSE market holidays (2025–2026). Update annually when NSE publishes the official list.
NSE_HOLIDAYS: frozenset[datetime.date] = frozenset({
    # 2025
    datetime.date(2025, 1, 26),   # Republic Day
    datetime.date(2025, 2, 26),   # Mahashivratri
    datetime.date(2025, 3, 14),   # Holi
    datetime.date(2025, 3, 31),   # Eid ul-Fitr
    datetime.date(2025, 4, 14),   # Dr. Ambedkar Jayanti
    datetime.date(2025, 4, 18),   # Good Friday
    datetime.date(2025, 5, 1),    # Maharashtra Day
    datetime.date(2025, 8, 15),   # Independence Day
    datetime.date(2025, 8, 27),   # Ganesh Chaturthi
    datetime.date(2025, 10, 2),   # Gandhi Jayanti / Dussehra
    datetime.date(2025, 10, 21),  # Diwali Laxmi Puja
    datetime.date(2025, 10, 22),  # Balipratipada
    datetime.date(2025, 11, 5),   # Gurunanak Jayanti
    datetime.date(2025, 12, 25),  # Christmas
    # 2026
    datetime.date(2026, 1, 26),   # Republic Day
    datetime.date(2026, 3, 20),   # Holi
    datetime.date(2026, 4, 3),    # Good Friday
    datetime.date(2026, 4, 14),   # Dr. Ambedkar Jayanti
    datetime.date(2026, 5, 1),    # Maharashtra Day
    datetime.date(2026, 8, 15),   # Independence Day
    datetime.date(2026, 10, 2),   # Gandhi Jayanti
    datetime.date(2026, 12, 25),  # Christmas
})


def _is_trading_day(d: datetime.date) -> bool:
    return d.weekday() < 5 and d not in NSE_HOLIDAYS


def _prev_trading_day(d: datetime.date) -> datetime.date:
    d -= datetime.timedelta(days=1)
    while not _is_trading_day(d):
        d -= datetime.timedelta(days=1)
    return d


def _expiry_weekday(trading_date: datetime.date, symbol: str = "NIFTY") -> int:
    """
    Target expiry weekday for a symbol.
    BSESEN: always Thursday (3) — BSE SENSEX expiry never changed.
    Others (NSE): Tuesday (1) from 2025-09-01, Thursday (3) before.
    """
    if symbol == "BSESEN":
        return 3
    return 1 if trading_date >= _CUTOFF_DATE else 3


def get_weekly_expiry(trading_date_str: str, symbol: str = "NIFTY") -> str:
    """
    Return the weekly expiry date at or after trading_date.
    If the computed expiry is a holiday, shifts to the previous trading day.
    """
    d = datetime.date.fromisoformat(trading_date_str)
    target_wd = _expiry_weekday(d, symbol)
    days_ahead = (target_wd - d.weekday()) % 7
    expiry = d + datetime.timedelta(days=days_ahead)
    if not _is_trading_day(expiry):
        expiry = _prev_trading_day(expiry)
    return expiry.isoformat()


def get_monthly_expiry(trading_date_str: str, symbol: str = "NIFTY") -> str:
    """
    Return the last expiry weekday of the month containing trading_date.
    If the computed expiry is a holiday, shifts to the previous trading day.
    """
    d = datetime.date.fromisoformat(trading_date_str)
    target_wd = _expiry_weekday(d, symbol)
    # Last day of the month
    if d.month == 12:
        last_day = datetime.date(d.year + 1, 1, 1) - datetime.timedelta(days=1)
    else:
        last_day = datetime.date(d.year, d.month + 1, 1) - datetime.timedelta(days=1)
    # Walk back to find last occurrence of target_wd
    days_back = (last_day.weekday() - target_wd) % 7
    monthly = last_day - datetime.timedelta(days=days_back)
    if not _is_trading_day(monthly):
        monthly = _prev_trading_day(monthly)
    return monthly.isoformat()


def get_expiry_date(symbol: str, trading_date_str: str) -> str:
    """
    Return the next valid expiry date for the given symbol.
    NIFTY / BSESEN: next weekly expiry (at or after trading_date).
    Equities: monthly expiry (last expiry weekday of the current month;
              if already past, uses next month's expiry).
    """
    if symbol in ("NIFTY", "BSESEN"):
        return get_weekly_expiry(trading_date_str, symbol)

    monthly = get_monthly_expiry(trading_date_str, symbol)
    if monthly < trading_date_str:
        # Current month's expiry already passed — advance to next month
        d = datetime.date.fromisoformat(trading_date_str)
        if d.month == 12:
            next_month = datetime.date(d.year + 1, 1, 1)
        else:
            next_month = datetime.date(d.year, d.month + 1, 1)
        monthly = get_monthly_expiry(next_month.isoformat(), symbol)
    return monthly


def get_atm_strike(symbol: str, price: float, offset: int = 0) -> int:
    """
    Compute the ATM strike for the given underlying price.
    offset: number of strike intervals above (+OTM call / -OTM put) or below.
    """
    interval = STRIKE_INTERVALS.get(symbol, 5)
    atm = round(price / interval) * interval
    return int(atm + offset * interval)


def options_parquet_path(
    symbol: str, date: str, strike: int, expiry: str, right: str
) -> Path:
    """
    Cache path for one options contract's daily data.
    Format: data/ohlcdata/{SYMBOL}-{CE|PE}-{STRIKE}-{ED}-{EM}-{EY}-{DD}-{MM}-{YYYY}.parquet
    where expiry is in DD-MM-YYYY and date is in DD-MM-YYYY.
    """
    y, m, d = date.split("-")
    ey, em, ed = expiry.split("-")
    right_str = "CE" if right.upper() in ("CE", "CALL") else "PE"
    OHLCDATA_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{symbol}-{right_str}-{strike}-{ed}-{em}-{ey}-{d}-{m}-{y}.parquet"
    return OHLCDATA_DIR / filename


def _breeze_expiry_format(expiry: str) -> str:
    """Convert YYYY-MM-DD to the Breeze API ISO format."""
    return f"{expiry}T06:00:00.000Z"


def _fetch_options_day_paginated(
    breeze, symbol: str, date: str, strike: int, expiry: str, right: str
) -> list[dict]:
    """
    Fetch a full trading day of options OHLC data in 15-minute chunks
    to stay under the Breeze API ~1000-record cap.
    right: "CE"/"CALL" or "PE"/"PUT"
    """
    from app.services.broker_service import BreezeTokenError

    from_ts = pd.Timestamp(f"{date} {MARKET_OPEN}")
    to_ts = pd.Timestamp(f"{date} {MARKET_CLOSE}")
    chunk_delta = pd.Timedelta(minutes=_CHUNK_MINUTES)
    right_str = "call" if right.upper() in ("CE", "CALL") else "put"
    expiry_iso = _breeze_expiry_format(expiry)
    sym_info = SUPPORTED_SYMBOLS.get(symbol, {})
    stock_code = sym_info.get("breeze_stock_code", symbol)
    options_exchange = sym_info.get("options_exchange_code", "NFO")

    all_records: list[dict] = []
    current = from_ts
    while current < to_ts:
        chunk_end = min(current + chunk_delta, to_ts)
        response = breeze.get_historical_data_v2(
            interval="1second",
            from_date=current.strftime("%Y-%m-%d %H:%M:%S"),
            to_date=chunk_end.strftime("%Y-%m-%d %H:%M:%S"),
            stock_code=stock_code,
            exchange_code=options_exchange,
            product_type="options",
            expiry_date=expiry_iso,
            strike_price=str(strike),
            right=right_str,
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
                f"Breeze API error for {symbol} options "
                f"{current.strftime('%H:%M')}–{chunk_end.strftime('%H:%M')}: {error}"
            )
        all_records.extend(response.get("Success") or [])
        current = chunk_end
    return all_records


def _validate_options_gaps(df: pd.DataFrame, date: str, partial: bool = False) -> pd.DataFrame:
    """
    Fill options data to cover the full trading day (or up to last actual row when partial).
    Options may not trade from exact market open (far-OTM contracts), so we
    forward-fill from the first available tick and backward-fill any leading gap.
    No strict gap limit — options data is inherently sparser than equity.

    partial=True (today's live data): reindex only from market_open to the last actual row.
    This prevents fake flat bars from being written into the parquet for future hours
    that haven't happened yet (paper trading / intraday fetch).
    """
    if df.empty:
        raise RuntimeError(f"No options data for {date}.")
    # Strip tz-awareness so we can reindex with a tz-naive full-day index.
    # The tz-as-UTC label is re-applied in load_options_dataframe at read time.
    if df.index.tzinfo is not None:
        df.index = df.index.tz_localize(None)
    market_open = pd.Timestamp(f"{date} {MARKET_OPEN}")
    if partial:
        # Stop at the last actual data row — no fake future bars for incomplete days.
        end_ts = df.index[-1]
    else:
        end_ts = pd.Timestamp(f"{date} {MARKET_CLOSE}") - pd.Timedelta(seconds=1)
    full_index = pd.date_range(start=market_open, end=end_ts, freq="1s")
    df = df.reindex(full_index).ffill().bfill()
    return df


_OPTIONS_TODAY_CACHE_TTL = 600  # 10 min — re-fetch today's partial options data


def fetch_options_historical(
    symbol: str, date: str, strike: int, expiry: str, right: str
) -> Path:
    """
    Ensure options OHLC data for the given contract and date is cached as Parquet.
    Returns the cache path. Fetches from Breeze if not cached.
    Raises RuntimeError when Breeze returns no data (holiday / contract inactive).

    For today's date (paper trading): parquet is re-fetched after _OPTIONS_TODAY_CACHE_TTL
    seconds so the chart always shows near-current Breeze data. Gap-fill stops at the last
    actual row (partial mode) — no fake flat bars for hours that haven't happened yet.
    """
    import time as _time

    from app.services.broker_service import _get_breeze, _breeze_to_dataframe

    is_today = date == datetime.date.today().strftime("%Y-%m-%d")
    pq = options_parquet_path(symbol, date, strike, expiry, right)
    partial_pq: Path | None = None  # fallback if Breeze unavailable for today

    if pq.exists():
        try:
            cached_df = pd.read_parquet(pq)
            if not cached_df.empty:
                if is_today:
                    age_secs = _time.time() - pq.stat().st_mtime
                    if age_secs < _OPTIONS_TODAY_CACHE_TTL:
                        logger.info(
                            "Options parquet cache hit (partial today): %s (age %.0fs)",
                            pq.name, age_secs,
                        )
                        return pq
                    partial_pq = pq
                    logger.info(
                        "Today's options parquet %s is stale (%.0fs) — re-fetching",
                        pq.name, age_secs,
                    )
                else:
                    logger.info("Options parquet cache hit: %s", pq.name)
                    return pq
            else:
                pq.unlink()
        except Exception as e:
            logger.warning("Could not read cached options parquet %s: %s — re-fetching", pq.name, e)
            pq.unlink(missing_ok=True)

    logger.info(
        "Fetching options data: %s %s strike=%s expiry=%s right=%s",
        symbol, date, strike, expiry, right,
    )
    try:
        breeze = _get_breeze()
        records = _fetch_options_day_paginated(breeze, symbol, date, strike, expiry, right)
    except Exception as exc:
        if partial_pq is not None:
            logger.warning(
                "Breeze unavailable for options %s %s %s on %s (%s); using partial cache",
                symbol, right, strike, date, exc,
            )
            return partial_pq
        raise

    if not records:
        if partial_pq is not None:
            logger.warning(
                "Breeze returned no options records for %s %s %s on %s; using partial cache",
                symbol, right, strike, date,
            )
            return partial_pq
        raise RuntimeError(
            f"Breeze returned no options data for {symbol} {right} {strike} "
            f"expiry={expiry} on {date}. "
            "This may be a holiday or the contract did not trade on this date."
        )

    df = _breeze_to_dataframe(records)
    if df.empty:
        raise RuntimeError(
            f"Could not parse Breeze options data for {symbol} {right} {strike} on {date}."
        )

    df = _validate_options_gaps(df, date, partial=is_today)

    tmp = pq.with_name(pq.name + ".tmp")
    try:
        df.to_parquet(tmp)
        os.replace(tmp, pq)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    logger.info("Saved %d rows to %s", len(df), pq)
    return pq


def load_options_dataframe(
    symbol: str, date: str, strike: int, expiry: str, right: str
) -> pd.DataFrame:
    """
    Load options OHLC data from Parquet cache.
    Applies the same IST-as-UTC label convention as equity data so that
    Lightweight Charts displays correct IST market times.
    """
    pq = options_parquet_path(symbol, date, strike, expiry, right)
    if not pq.exists():
        raise FileNotFoundError(
            f"No options data for {symbol} {right} {strike} expiry={expiry} on {date}. "
            "Start a session to trigger a Breeze fetch."
        )
    df = pd.read_parquet(pq)
    df = df.rename(columns=str.lower)
    df = df[["open", "high", "low", "close"]]
    if df.index.tzinfo is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    return df


def options_iter_ticks(
    symbol: str,
    date: str,
    strike: int,
    expiry: str,
    right: str,
    start_time: str = "09:15:00",
) -> Iterator[dict]:
    """Yield one tick dict per second for the options contract starting from start_time."""
    df = load_options_dataframe(symbol, date, strike, expiry, right)
    start_ts = pd.Timestamp(f"{date} {start_time}", tz="UTC")
    df = df[df.index >= start_ts]
    for ts, row in df.iterrows():
        yield {
            "type": "tick",
            "time": int(ts.timestamp()),
            "open": round(float(row["open"]), 2),
            "high": round(float(row["high"]), 2),
            "low": round(float(row["low"]), 2),
            "close": round(float(row["close"]), 2),
        }


def compute_short_margin(symbol: str, underlying_price: float) -> float:
    """
    Minimum margin required for a naked short options position.
    = underlying_price × lot_size × 20%
    """
    lot_size = LOT_SIZES.get(symbol, 1)
    return underlying_price * lot_size * 0.20


def get_underlying_price_at(symbol: str, date: str, unix_ts: int) -> float | None:
    """
    Read the underlying equity price at the given Unix timestamp from the cached parquet.
    Returns None if equity data is unavailable. Used for margin checks during options sessions.
    """
    try:
        from app.services.data_loader import load_dataframe
        df = load_dataframe(symbol, date)
        target_ts = pd.Timestamp(unix_ts, unit="s", tz="UTC")
        rows = df[df.index >= target_ts]
        if rows.empty:
            return None
        return round(float(rows.iloc[0]["close"]), 2)
    except Exception:
        return None
