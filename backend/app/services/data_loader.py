"""
Loads NIFTY OHLC pickle files, converts IST→UTC, and provides
both batch (historical REST) and streaming (simulation tick) access.
"""
from __future__ import annotations

import pandas as pd
from pathlib import Path
from typing import Iterator

from app.config import DATA_DIR, CANDLE_INTERVAL_MINUTES


def _pickle_path(symbol: str, date: str) -> Path:
    """date format: YYYY-MM-DD  →  SYMBOL-DD-MM-YYYY.pickle"""
    y, m, d = date.split("-")
    return DATA_DIR / f"{symbol}-{d}-{m}-{y}.pickle"


def load_dataframe(symbol: str, date: str) -> pd.DataFrame:
    """
    Load second-level OHLC data for the given symbol and date.
    The pickle index is tz-naive IST; we localize and convert to UTC.
    Returns DataFrame with UTC DatetimeIndex, columns: open, high, low, close.
    """
    path = _pickle_path(symbol, date)
    if not path.exists():
        raise FileNotFoundError(f"Data file not found: {path}")

    df = pd.read_pickle(path)

    # Standardise column names (pickle has open, close, low, high, volume)
    df = df.rename(columns=str.lower)
    df = df[["open", "high", "low", "close"]]

    # Localize tz-naive IST index to UTC
    df.index = df.index.tz_localize("Asia/Kolkata").tz_convert("UTC")

    return df


def resample_to_candles(df: pd.DataFrame) -> pd.DataFrame:
    """Resample second-level data to CANDLE_INTERVAL_MINUTES-minute OHLC candles."""
    rule = f"{CANDLE_INTERVAL_MINUTES}min"
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


def iter_ticks(
    symbol: str,
    date: str,
    start_time: str = "09:15:00",
) -> Iterator[dict]:
    """
    Yield one tick dict per second starting from start_time.
    Each tick: {time, open, high, low, close} with UTC Unix timestamp.
    """
    df = load_dataframe(symbol, date)

    # Filter from the requested start_time (UTC equivalent)
    # The start_time is provided as IST ("09:15:00") — convert to UTC timestamp
    date_ist = pd.Timestamp(f"{date} {start_time}", tz="Asia/Kolkata")
    date_utc = date_ist.tz_convert("UTC")
    df = df[df.index >= date_utc]

    for ts, row in df.iterrows():
        yield {
            "type": "tick",
            "time": int(ts.timestamp()),
            "open": round(float(row["open"]), 2),
            "high": round(float(row["high"]), 2),
            "low": round(float(row["low"]), 2),
            "close": round(float(row["close"]), 2),
        }
