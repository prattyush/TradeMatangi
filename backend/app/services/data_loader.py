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

from app.config import DATA_DIR, OHLCDATA_DIR, CANDLE_INTERVAL_MINUTES, MARKET_OPEN, MARKET_CLOSE, get_market_close

_MAX_GAP_SECONDS = 900  # 15 minutes — gaps larger than this cannot be interpolated


def has_native_second_cadence(df: pd.DataFrame) -> bool:
    """Whether provider rows include genuine adjacent one-second OHLC points.

    This must be checked before ``validate_and_fill_gaps``: that helper
    intentionally materialises missing seconds, which would otherwise make a
    minute-level provider response look like genuine second data.
    """
    if len(df.index)==0:return False
    declared=df.attrs.get("native_interval_seconds")
    if declared in (1,60):return declared==1
    if len(df.index) < 2:
        return False
    index = df.index.sort_values()
    return any((right - left).total_seconds() == 1 for left, right in zip(index, index[1:]))


def attach_observation_provenance(df: pd.DataFrame) -> pd.DataFrame:
    """Mark provider rows before gap fill; keep the actual cadence in parquet metadata."""
    df=df.copy()
    df['observed']=True
    df.attrs['native_interval_seconds']=1 if has_native_second_cadence(df) else 60
    return df


_PRICE_COLUMNS = ["open", "high", "low", "close"]


def clean_volume(df: pd.DataFrame) -> pd.DataFrame:
    """Return ``df`` with a trustworthy ``volume`` column (unchanged when it has none).

    Gap filling forward/back-fills every column, so a filled second would repeat the
    traded volume of its neighbour and a bar sum would overstate it.  Volume belongs
    to provider rows only: filled rows get 0.  Files saved before provenance was
    recorded carry no ``observed`` flag, so a filled row is recognised as a row
    identical to the previous one in all of open/high/low/close/volume (with volume),
    and the leading back-filled run as identical rows up to the first real change.
    Real zero-volume seconds are kept as 0.  Negative or missing values become 0.
    """
    if "volume" not in df.columns:
        return df
    df = df.copy()
    volume = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0).clip(lower=0.0)
    if "observed" in df.columns:
        filled = ~df["observed"].fillna(False).astype(bool).to_numpy()
    else:
        filled = pd.Series(False, index=df.index).to_numpy()
        columns = [c for c in _PRICE_COLUMNS if c in df.columns]
        if columns and len(df) > 1:
            values = pd.concat([df[columns], volume.rename("volume")], axis=1).to_numpy()
            same = (values[1:] == values[:-1]).all(axis=1)  # row i+1 equals row i
            filled[1:] = same & (volume.to_numpy()[1:] > 0)
            changed = ~same
            first_real = int(changed.argmax()) if changed.any() else len(values) - 1
            filled[:first_real] = True
            filled[first_real] = False  # the real row that the leading run was copied from
    df["volume"] = volume.where(~filled, 0.0)
    return df


def _is_index(symbol: str) -> bool:
    from app.config import SUPPORTED_SYMBOLS
    return bool(SUPPORTED_SYMBOLS.get(symbol, {}).get("options_only"))


def _select_columns(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    """OHLC plus a cleaned ``volume`` when the file has one.  Indices report no volume."""
    df = df.rename(columns=str.lower)
    if "volume" in df.columns and not _is_index(symbol):
        return clean_volume(df)[_PRICE_COLUMNS + ["volume"]]
    return df[_PRICE_COLUMNS]


def parquet_path(symbol: str, date: str) -> Path:
    """date format: YYYY-MM-DD  →  ohlcdata/SYMBOL-DD-MM-YYYY.parquet"""
    y, m, d = date.split("-")
    OHLCDATA_DIR.mkdir(parents=True, exist_ok=True)
    return OHLCDATA_DIR / f"{symbol}-{d}-{m}-{y}.parquet"


def pickle_path(symbol: str, date: str) -> Path:
    """date format: YYYY-MM-DD  →  SYMBOL-DD-MM-YYYY.pickle (legacy)"""
    y, m, d = date.split("-")
    return DATA_DIR / f"{symbol}-{d}-{m}-{y}.pickle"


def _load_breeze_dataframe(symbol: str, date: str) -> pd.DataFrame:
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

    df = _select_columns(df, symbol)
    if df.index.tzinfo is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")
    # Trim post-close data from stale cached parquets (SEBI 15:15 effective 03 Aug 2026)
    from app.config import get_market_close
    close = get_market_close(date)
    cutoff = pd.Timestamp(f"{date} {close}", tz="UTC")
    df = df[df.index < cutoff]
    return df


def validate_and_fill_gaps(df: pd.DataFrame, date: str, partial: bool = False) -> pd.DataFrame:
    """
    Ensure second-level OHLC data covers the expected trading window.

    When partial=False (historical complete day):
      - Checks leading, between, and trailing gaps against MARKET_CLOSE.
      - Gaps > 15 minutes raise RuntimeError.
      - Reindexes the full 09:15–15:29:59 range with ffill/bfill.

    When partial=True (today's live data, market still open):
      - Skips the trailing gap check (data up to "now" is always incomplete).
      - Only raises for gaps between existing rows > 15 minutes.
      - Reindexes only from MARKET_OPEN to the last available row.

    The DataFrame index must be tz-naive with IST wall-clock timestamps.
    """
    market_open = pd.Timestamp(f"{date} {MARKET_OPEN}")
    market_close_raw = pd.Timestamp(f"{date} {get_market_close(date)}")
    market_close = market_close_raw - pd.Timedelta(seconds=1)

    if df.empty:
        raise RuntimeError(f"No data for {date}.")

    sorted_idx = df.index.sort_values()

    leading_gap = max(0.0, (sorted_idx[0] - market_open).total_seconds())
    diffs = pd.Series(sorted_idx).diff().dt.total_seconds().dropna()
    max_between = max(0.0, float(diffs.max()) - 1.0) if len(diffs) > 0 else 0.0

    if partial:
        # Only validate internal consistency — trailing gap is expected for live data
        max_gap = max(leading_gap, max_between)
        end_ts = sorted_idx[-1]  # reindex only up to last available row
    else:
        trailing_gap = max(0.0, (market_close - sorted_idx[-1]).total_seconds())
        max_gap = max(leading_gap, max_between, trailing_gap)
        end_ts = market_close

    if max_gap > _MAX_GAP_SECONDS:
        gap_min = int(max_gap) // 60
        gap_sec = int(max_gap) % 60
        raise RuntimeError(
            f"Data for {date} has a gap of {gap_min}m {gap_sec}s "
            f"(limit: {_MAX_GAP_SECONDS // 60} minutes). "
            "Delete the cached file and re-fetch to get complete data."
        )

    full_index = pd.date_range(start=market_open, end=end_ts, freq="1s")
    observed = df["observed"].reindex(full_index).astype("boolean").fillna(False).astype(bool) if "observed" in df else None
    provider_rows = pd.Series(True, index=df.index[~df.index.duplicated()]).reindex(full_index, fill_value=False)
    df = df.drop(columns=["observed"],errors="ignore").reindex(full_index).ffill().bfill()
    if "volume" in df.columns:
        df["volume"] = df["volume"].where(provider_rows, 0.0)  # filled seconds traded nothing
    if observed is not None:
        df["observed"] = observed
    return df


def resample_to_candles(
    df: pd.DataFrame,
    interval_minutes: int = CANDLE_INTERVAL_MINUTES,
) -> pd.DataFrame:
    """Resample second-level data to interval_minutes-minute OHLC candles."""
    rule = f"{interval_minutes}min"
    aggregations = dict(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
    )
    if "volume" in df.columns:
        aggregations["volume"] = ("volume", "sum")
    return df.resample(rule).agg(**aggregations).dropna()


def _volume_field(row) -> dict:
    """``{"volume": n}`` when the row carries a usable volume, else nothing (indices, legacy files)."""
    value = row.get("volume") if hasattr(row, "get") else None
    if value is None or pd.isna(value):
        return {}
    return {"volume": int(round(float(value)))}


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
            **_volume_field(row),
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
    from app.services.historical_data_service import _require_replay_cadence, history_mode
    _require_replay_cadence(df, history_mode())

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
            **_volume_field(row),
        }


def load_dataframe(symbol: str, date: str) -> pd.DataFrame:
    from app.services.historical_data_service import history_mode, load_history
    if history_mode() == "live":
        frame = load_history(symbol, date).frame
        # Indices have no traded volume; report none rather than a column of zeros.
        return frame.drop(columns=["volume"]) if "volume" in frame.columns and _is_index(symbol) else frame
    return _load_breeze_dataframe(symbol, date)
