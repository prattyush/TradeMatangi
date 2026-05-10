"""
Loads OHLC data files, converts IST→UTC, and provides
both batch (historical REST) and streaming (simulation tick) access.

Data lookup order: ohlcdata/<symbol>.parquet → legacy <symbol>.pickle
Parquet files in ohlcdata/ are written by broker_service when Breeze
fetches new dates.
"""
from __future__ import annotations

import pandas as pd
from pathlib import Path
from typing import Iterator

from app.config import DATA_DIR, CANDLE_INTERVAL_MINUTES, MARKET_OPEN, MARKET_CLOSE

_MAX_GAP_SECONDS = 900  # 15 minutes — gaps larger than this cannot be interpolated


def parquet_path(symbol: str, date: str) -> Path:
    """date format: YYYY-MM-DD  →  ohlcdata/SYMBOL-DD-MM-YYYY.parquet"""
    y, m, d = date.split("-")
    ohlc_dir = DATA_DIR / "ohlcdata"
    ohlc_dir.mkdir(parents=True, exist_ok=True)
    return ohlc_dir / f"{symbol}-{d}-{m}-{y}.parquet"


def pickle_path(symbol: str, date: str) -> Path:
    """date format: YYYY-MM-DD  →  SYMBOL-DD-MM-YYYY.pickle (legacy)"""
    y, m, d = date.split("-")
    return DATA_DIR / f"{symbol}-{d}-{m}-{y}.pickle"


def load_dataframe(symbol: str, date: str) -> pd.DataFrame:
    """
    Load second-level OHLC data for the given symbol and date.

    Checks in order: parquet (ohlcdata/) → legacy pickle (data/).
    Raises FileNotFoundError if neither exists.

    The index is tz-naive IST from the source files.  We attach the UTC
    label directly — i.e. treat "09:15:00 IST" as "09:15:00 UTC" so that
    Lightweight Charts displays correct IST market time on the x-axis.
    """
    pq = parquet_path(symbol, date)
    pkl = pickle_path(symbol, date)

    if pq.exists():
        df = pd.read_parquet(pq)
    elif pkl.exists():
        df = pd.read_pickle(pkl)
    else:
        raise FileNotFoundError(
            f"No data file found for {symbol} on {date}. "
            "Start a session to trigger a Breeze fetch, or check the date."
        )

    df = df.rename(columns=str.lower)
    df = df[["open", "high", "low", "close"]]
    df.index = df.index.tz_localize("UTC")
    return df


def validate_and_fill_gaps(df: pd.DataFrame, date: str) -> pd.DataFrame:
    """
    Ensure second-level OHLC data covers the full trading day (MARKET_OPEN..MARKET_CLOSE-1s).

    - Gaps ≤ 15 minutes (900 s) are forward-filled (backward-filled for any leading gap).
    - Gaps > 15 minutes raise RuntimeError.

    The DataFrame index must be tz-naive with IST wall-clock timestamps (as stored in files).
    """
    market_open = pd.Timestamp(f"{date} {MARKET_OPEN}")
    market_close = pd.Timestamp(f"{date} {MARKET_CLOSE}") - pd.Timedelta(seconds=1)

    if df.empty:
        raise RuntimeError(f"No data for {date}.")

    sorted_idx = df.index.sort_values()

    leading_gap = max(0.0, (sorted_idx[0] - market_open).total_seconds())
    diffs = pd.Series(sorted_idx).diff().dt.total_seconds().dropna()
    max_between = max(0.0, float(diffs.max()) - 1.0) if len(diffs) > 0 else 0.0
    trailing_gap = max(0.0, (market_close - sorted_idx[-1]).total_seconds())

    max_gap = max(leading_gap, max_between, trailing_gap)

    if max_gap > _MAX_GAP_SECONDS:
        gap_min = int(max_gap) // 60
        gap_sec = int(max_gap) % 60
        raise RuntimeError(
            f"Data for {date} has a gap of {gap_min}m {gap_sec}s "
            f"(limit: {_MAX_GAP_SECONDS // 60} minutes). "
            "Delete the cached file and re-fetch to get complete data."
        )

    full_index = pd.date_range(start=market_open, end=market_close, freq="1s")
    df = df.reindex(full_index).ffill().bfill()
    return df


def resample_to_candles(
    df: pd.DataFrame,
    interval_minutes: int = CANDLE_INTERVAL_MINUTES,
) -> pd.DataFrame:
    """Resample second-level data to interval_minutes-minute OHLC candles."""
    rule = f"{interval_minutes}min"
    candles = df.resample(rule).agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
    ).dropna()
    return candles


def candles_to_records(candles: pd.DataFrame) -> list[dict]:
    """Convert candle DataFrame to list of dicts with Unix UTC timestamps."""
    records = []
    for ts, row in candles.iterrows():
        records.append({
            "time": int(ts.timestamp()),
            "open": round(float(row["open"]), 2),
            "high": round(float(row["high"]), 2),
            "low": round(float(row["low"]), 2),
            "close": round(float(row["close"]), 2),
        })
    return records


def pre_session_candles(
    symbol: str,
    date: str,
    start_time: str,
    interval_minutes: int = CANDLE_INTERVAL_MINUTES,
) -> list[dict]:
    """
    Return candles for `date` from market open (09:15) up to but not
    including the candle window that contains start_time.
    """
    df = load_dataframe(symbol, date)

    market_open_ts = pd.Timestamp(f"{date} {MARKET_OPEN}", tz="UTC")
    start_ts = pd.Timestamp(f"{date} {start_time}", tz="UTC")

    if start_ts <= market_open_ts:
        return []

    window = df[(df.index >= market_open_ts) & (df.index < start_ts)]
    if window.empty:
        return []

    candles = resample_to_candles(window, interval_minutes)
    return candles_to_records(candles)


def iter_ticks(
    symbol: str,
    date: str,
    start_time: str = "09:15:00",
) -> Iterator[dict]:
    """
    Yield one tick dict per second starting from start_time (IST, HH:MM:SS).
    Each tick: {type, time, open, high, low, close} where time is a Unix
    timestamp that displays as the IST wall-clock time in Lightweight Charts.
    """
    df = load_dataframe(symbol, date)

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
