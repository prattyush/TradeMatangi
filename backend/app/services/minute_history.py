"""Minute-level candles for read-only screens (phone Browse, Max price).

Replay and stepwise sessions need Breeze *second-level* data and keep using it. Screens that only draw candles of one
minute or more (the phone's Browse) do not, and Breeze second-level downloads are slow (calls are paced 1.5 s apart,
about 25 per option day). This module answers them from minute data instead, in this order:

1. A **complete second-level cache that already exists** (read-only): resampled to minutes, so a day that was already
   downloaded for a session costs nothing and looks exactly as before.
2. This module's own **minute cache**, ``OHLCDATA_DIR/minute/<provider>/<contract id>/<date>.parquet``.
3. **Kite** minute candles (index, equity and option contracts that are still listed; Kite has no expired options).
4. **Breeze ``1minute``** candles (also for expired options; one request per day).

Minute data is never written to the second-level file names and ``historical_data_service._require_replay_cadence``
still rejects it as replay input, so nothing here can reach a replay or stepwise session.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from pathlib import Path

import pandas as pd

from app.config import OHLCDATA_DIR, get_market_close
from app.services import swing_charts, swing_market
from app.services.historical_data_service import HistoricalResult, complete_day_cache

logger = logging.getLogger(__name__)

_TODAY_TTL_SECONDS = 60
_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


def minute_folder() -> Path:
    return Path(OHLCDATA_DIR) / "minute"


def _item(symbol, strike, expiry, right) -> dict:
    if right:
        return swing_charts.instrument(symbol, "options", right, strike, expiry)
    return swing_charts.instrument(symbol)


def _path(provider: str, item: dict, date: str) -> Path:
    identity = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[:24]
    return minute_folder() / provider / identity / f"{date}.parquet"


def _providers(item: dict, date: str) -> list[str]:
    # Kite's instrument list only holds contracts that are still listed.
    if item["kind"] == "option" and item["expiry"] < swing_market.today():
        return ["breeze"]
    return ["kite", "breeze"]


def _usable(path: Path, date: str) -> bool:
    """A file written after that day's close is final; one written during the session only lives for a minute."""
    if not path.exists():
        return False
    if complete_day_cache(path, date):
        return True
    return date == swing_market.today() and time.time() - path.stat().st_mtime < _TODAY_TTL_SECONDS


def _to_frame(frame: pd.DataFrame, date: str) -> pd.DataFrame:
    """Provider rows (tz-naive IST) → the project's IST-as-UTC index, 09:15 to close, with provenance."""
    frame = frame[["open", "high", "low", "close", "volume"]].copy()
    frame["observed"] = True  # every minute row is a real provider bar
    frame.index = frame.index.tz_localize("UTC")
    close = pd.Timestamp(f"{date} {get_market_close(date)}", tz="UTC")
    return frame[frame.index < close].sort_index()


def _from_second_level(symbol, date, strike, expiry, right) -> HistoricalResult | None:
    from app.services.historical_data_service import _complete_breeze_cache

    cached = _complete_breeze_cache(symbol, date, strike, expiry, right, "minute")
    if cached is None:
        return None
    seconds = cached.frame
    parts = {
        "open": ("open", "first"), "high": ("high", "max"), "low": ("low", "min"), "close": ("close", "last"),
    }
    if "volume" in seconds:
        parts["volume"] = ("volume", "sum")
    if "observed" in seconds:
        parts["observed"] = ("observed", "max")
    minutes = seconds.resample("1min").agg(**parts).dropna(subset=["open"])
    if "observed" in minutes:
        minutes["observed"] = minutes["observed"].astype(bool)
    return HistoricalResult(minutes, cached.path, "minute", "breeze-cache", 60)


def _from_provider(provider: str, item: dict, symbol, date: str) -> pd.DataFrame:
    path = _path(provider, item, date)
    with _guard:
        lock = _locks.setdefault(str(path), threading.Lock())
    with lock:
        if _usable(path, date):
            return pd.read_parquet(path)
        start = pd.Timestamp(f"{date} 09:15:00")
        end = pd.Timestamp(f"{date} 15:30:00")
        frame = swing_charts.normalize(swing_charts._fetch(provider, item, start, end, False), False)
        if frame.empty:
            return frame
        frame = _to_frame(frame, date)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        frame.to_parquet(temporary)
        os.replace(temporary, path)
        return frame


def load(symbol: str, date: str, strike=None, expiry: str | None = None, right: str | None = None) -> HistoricalResult:
    """One contract or underlying for one day as minute rows (index: IST wall-clock labelled UTC).

    Raises ``FileNotFoundError`` when no source has data for the day, and re-raises a Breeze token error so the route
    can answer 503; any other provider failure becomes ``RuntimeError``.
    """
    reused = _from_second_level(symbol, date, strike, expiry, right)
    if reused is not None:
        return reused
    item = _item(symbol, strike, expiry, right)
    providers = _providers(item, date)
    failures: dict[str, Exception] = {}
    for provider in providers:
        try:
            frame = _from_provider(provider, item, symbol, date)
        except Exception as exc:  # noqa: BLE001 - fall through to the next source
            logger.warning("minute_history provider=%s symbol=%s date=%s failed: %s", provider, symbol, date, exc)
            failures[provider] = exc
            continue
        if not frame.empty:
            return HistoricalResult(frame, _path(provider, item, date), "minute", provider, 60)
    from app.services.broker_service import BreezeTokenError

    for failure in failures.values():
        if isinstance(failure, BreezeTokenError):
            raise failure
    # Nothing found. If the last source in the chain answered (even with no rows) the day has no data; if it failed
    # (timeout, rate limit, bad session) the day may well have data, so say "failed", never "not found".
    if providers[-1] in failures:
        raise RuntimeError("Historical provider failed")
    raise FileNotFoundError(f"No minute data for {symbol} on {date}")
