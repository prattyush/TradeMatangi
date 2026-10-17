"""Reconstruct a snapshot's current candle from cached, observed seconds only."""

import math
from datetime import date

import numpy as np
import pandas as pd


def reconstruct_candle(snapshot: dict, instrument: str) -> dict | None:
    from app.config import SUPPORTED_SYMBOLS
    from app.services.data_loader import has_native_second_cadence, pickle_path
    from app.services.historical_data_service import _path

    symbol = snapshot.get("symbol")
    trading_date = snapshot.get("date", "")
    timestamp = float(snapshot.get("timestamp") or 0)
    if (
        symbol not in SUPPORTED_SYMBOLS
        or not math.isfinite(timestamp)
        or timestamp <= 0
    ):
        return None
    event_time = pd.Timestamp(math.floor(timestamp), unit="s", tz="UTC")
    if event_time.date().isoformat() != trading_date:
        return None
    date.fromisoformat(trading_date)
    strike = expiry = right = None
    if instrument != "underlying":
        captured = snapshot.get("snapshot", {})
        strike, expiry, right = (
            captured.get(f"strike_{instrument.lower()}"),
            captured.get("expiry"),
            instrument,
        )
        if snapshot.get("instrument_type") != "options" or not strike or not expiry:
            return None
        from app.services.instrument_identity import strike_number

        strike = strike_number(strike)
        if strike <= 0:
            return None
        date.fromisoformat(expiry)
        if trading_date > expiry:
            return None
    path = _path("breeze", symbol, trading_date, strike, expiry, right)
    if path.exists():
        frame = pd.read_parquet(path)
    elif right is None and pickle_path(symbol, trading_date).exists():
        frame = pd.read_pickle(pickle_path(symbol, trading_date))
    else:
        return None
    frame = frame.rename(columns=str.lower)
    if not isinstance(frame.index, pd.DatetimeIndex) or "observed" not in frame:
        return None
    frame.index = (
        frame.index.tz_localize("UTC")
        if frame.index.tz is None
        else frame.index.tz_convert("UTC")
    )
    frame = frame.sort_index()
    # Filled minute rows must never be mistaken for genuine second observations.
    if not has_native_second_cadence(frame[frame["observed"].eq(True)]):
        return None
    bar_time = math.floor(timestamp / 180) * 180
    start = pd.Timestamp(bar_time, unit="s", tz="UTC")
    window = frame[(frame.index >= start) & (frame.index <= event_time)]
    expected = pd.date_range(start, event_time, freq="1s")
    if not window.index.equals(expected) or not window["observed"].eq(True).all():
        return None
    columns = ["open", "high", "low", "close"]
    if not set(columns) <= set(window.columns):
        return None
    values = window[columns].apply(pd.to_numeric, errors="coerce")
    if not np.isfinite(values.to_numpy()).all() or (values <= 0).any().any():
        return None
    if (
        (values["low"] > values[["open", "close"]].min(axis=1))
        | (values["high"] < values[["open", "close"]].max(axis=1))
    ).any():
        return None
    return {
        "time": bar_time,
        "open": float(values.iloc[0]["open"]),
        "high": float(values["high"].max()),
        "low": float(values["low"].min()),
        "close": float(values.iloc[-1]["close"]),
    }
