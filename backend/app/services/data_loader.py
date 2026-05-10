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
    The pickle index is tz-naive IST (e.g. 09:15:00).  We attach the UTC
    label directly — i.e. we treat "09:15:00 IST" as "09:15:00 UTC" for
    timestamp purposes.  Lightweight Charts then displays the correct IST
    market time on the x-axis without any client-side timezone config.
    Returns DataFrame with UTC-labelled DatetimeIndex, columns: open, high, low, close.
    """
    path = _pickle_path(symbol, date)
    if not path.exists():
        raise FileNotFoundError(f"Data file not found: {path}")

    df = pd.read_pickle(path)

    # Standardise column names (pickle has open, close, low, high, volume)
    df = df.rename(columns=str.lower)
    df = df[["open", "high", "low", "close"]]

    # Attach UTC label to the naive IST index so that Unix timestamps
    # produce display-correct times (09:15 shown on chart, not 03:45).
    df.index = df.index.tz_localize("UTC")

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
    Yield one tick dict per second starting from start_time (IST, HH:MM:SS).
    Each tick: {type, time, open, high, low, close} where time is a Unix
    timestamp that displays as the IST wall-clock time in Lightweight Charts.
    """
    df = load_dataframe(symbol, date)

    # start_time is IST wall-clock; the index is labelled UTC with IST values,
    # so we compare directly as if start_time is UTC.
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
