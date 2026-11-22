"""Cache-only market data for the Games (Phase 25, G1): ``/availability`` and ``/window``.

Hard rules (spec 3.2): this module reads parquet files that already exist in the OHLC cache and nothing else. It
never downloads, never opens a broker or history-provider session and never calls the loaders that can (those
are named in ``test_games_data.py``, which fails if they are used here). A missing file is ``NotCached``.

Only observed rows are returned (G0-close answer 2): gap filling copies a neighbour's price into seconds that had no
print, and a game must not treat that as a real quote. Files saved before provenance was recorded have no
``observed`` column; for those the leading back-filled run is dropped with the project's ``infer_observed``.
Prices leave as integer paise. Times are seconds of the day on the IST wall clock (the cache index is tz-naive
IST that the backend labels UTC, see CLAUDE.md), so ``34200`` is 09:30:00 IST.
"""
from __future__ import annotations

import gzip
import json
import threading
import time
from collections import OrderedDict
from datetime import date as calendar_date
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd

from app import config
from app.services import games_index
from app.services.games_index import GAMES_SYMBOLS

INTERVALS = (1, 60)
DAY_SECONDS = 86_400
INDEX_TTL_SECONDS = 600
FRAME_CACHE_SIZE = 4
# Responses under this many bytes are sent as they are: the gzip header would cost more than it saves.
GZIP_MIN_BYTES = 512


class InvalidWindow(ValueError):
    """The request parameters are not acceptable (HTTP 422)."""


class NotCached(Exception):
    """The day or contract is not in the cache (HTTP 404). Never turned into a download."""


# ---------------------------------------------------------------- availability
_index_lock = threading.Lock()
_index_cache: dict = {"path": None, "stamp": None, "loaded_at": 0.0, "document": None}


def load_index() -> dict | None:
    """The index document, cached for ``INDEX_TTL_SECONDS``; a changed file is picked up at once (the script replaces it atomically)."""
    path = Path(config.GAMES_INDEX_PATH)
    try:
        info = path.stat()
        stamp = (info.st_mtime_ns, info.st_size)
    except OSError:
        stamp = None
    now = time.monotonic()
    with _index_lock:
        cache = _index_cache
        fresh = cache["path"] == str(path) and cache["stamp"] == stamp and now - cache["loaded_at"] < INDEX_TTL_SECONDS
        if not fresh:
            cache.update(path=str(path), stamp=stamp, loaded_at=now, document=games_index.read_index_file(path) if stamp else None)
        return cache["document"]


def clear_caches() -> None:
    with _index_lock:
        _index_cache.update(path=None, stamp=None, loaded_at=0.0, document=None)
    with _frame_lock:
        _frames.clear()


def availability() -> dict:
    """The public view of the index: dates, option contracts, and lot size and strike step taken from the live config."""
    from app.services.options_service import STRIKE_INTERVALS  # constants only; the module is already loaded by the app
    document = load_index()
    if document is None:
        return {"version": games_index.INDEX_VERSION, "generated_at": None, "index_missing": True, "symbols": {}}
    symbols: dict[str, dict] = {}
    for symbol in GAMES_SYMBOLS:
        entry = document["symbols"].get(symbol)
        if not isinstance(entry, dict):
            continue
        symbols[symbol] = {
            "lot_size": config.LOT_SIZES.get(symbol),
            "strike_step": STRIKE_INTERVALS.get(symbol),
            "dates": entry.get("dates", []),
            "options": entry.get("options", {}),
        }
    return {"version": document["version"], "generated_at": document.get("generated_at"), "index_missing": False, "symbols": symbols}


# ---------------------------------------------------------------- window
def _validate(symbol: str, date: str, start_sec: int, duration_sec: int, interval_seconds: int,
              expiry: str | None, strike: float | None, right: str | None) -> None:
    if symbol not in GAMES_SYMBOLS:
        raise InvalidWindow(f"symbol must be one of {', '.join(GAMES_SYMBOLS)}")
    for label, value in (("date", date), ("expiry", expiry)):
        if value is None:
            continue
        try:
            if calendar_date.fromisoformat(value).isoformat() != value:
                raise ValueError
        except ValueError:
            raise InvalidWindow(f"{label} must be YYYY-MM-DD") from None
    if interval_seconds not in INTERVALS:
        raise InvalidWindow("interval_seconds must be 1 or 60 (5 and 15 second candles are built by the client)")
    if not 0 <= start_sec < DAY_SECONDS:
        raise InvalidWindow("start_sec must be a second of the day")
    longest = config.GAMES_MAX_WINDOW_SECONDS if interval_seconds == 1 else DAY_SECONDS
    if not 1 <= duration_sec <= longest:
        raise InvalidWindow(f"duration_sec must be between 1 and {longest}")
    given = [value is not None for value in (expiry, strike, right)]
    if any(given) and not all(given):
        raise InvalidWindow("expiry, strike and right go together (omit all three for the underlying)")
    if right is not None:
        if right not in ("CE", "PE"):
            raise InvalidWindow("right must be CE or PE")
        if not (float(strike) > 0 and float(strike) < 1_000_000):
            raise InvalidWindow("strike must be a positive number")
        if expiry < date:
            raise InvalidWindow("expiry cannot be before the date")


_frame_lock = threading.Lock()
_frames: OrderedDict[tuple, pd.DataFrame] = OrderedDict()


def _observed_rows(raw: pd.DataFrame, date: str) -> pd.DataFrame:
    """Observed rows of one day, index tz-aware UTC (the IST wall clock under the project's labelling), sorted."""
    from app.services.desktop_preparation import infer_observed, observed_frame
    raw = raw.copy()
    raw.columns = [str(column).lower() for column in raw.columns]
    columns = games_index._PRICE_COLUMNS + (["observed"] if "observed" in raw.columns else [])
    frame = observed_frame(SimpleNamespace(frame=raw[columns]), date)
    if "observed" not in raw.columns and len(frame):
        frame = frame[infer_observed(frame)]
    frame = frame[~frame.index.duplicated(keep="last")]
    values = frame[games_index._PRICE_COLUMNS].apply(pd.to_numeric, errors="coerce")
    good = np.isfinite(values.to_numpy()).all(axis=1)
    return values[good]


def _read_frame(path: Path, date: str) -> pd.DataFrame:
    """One observed day, with a two-or-four entry LRU so the underlying and one option of a round are not re-read."""
    try:
        info = path.stat()
    except OSError:
        raise NotCached(path.name) from None
    key = (str(path), info.st_mtime_ns, info.st_size, date)
    with _frame_lock:
        if key in _frames:
            _frames.move_to_end(key)
            return _frames[key]
    try:
        frame = _observed_rows(pd.read_parquet(path), date)
    except (OSError, ValueError, KeyError) as error:
        raise NotCached(f"{path.name}: unreadable ({error})") from None
    with _frame_lock:
        _frames[key] = frame
        while len(_frames) > FRAME_CACHE_SIZE:
            _frames.popitem(last=False)
    return frame


def _seconds_of_day(index: pd.DatetimeIndex) -> np.ndarray:
    return (index.hour * 3600 + index.minute * 60 + index.second).to_numpy(dtype=np.int64)


def get_window(symbol: str, date: str, start_sec: int, duration_sec: int, interval_seconds: int = 1, *,
               expiry: str | None = None, strike: float | None = None, right: str | None = None) -> dict:
    """A slice of one cached day as struct-of-arrays (integer paise). Raises ``InvalidWindow`` or ``NotCached``."""
    _validate(symbol, date, start_sec, duration_sec, interval_seconds, expiry, strike, right)
    directory = games_index.ohlc_dir()
    name = (games_index.option_filename(symbol, date, expiry, right, strike) if right
            else games_index.day_filename(symbol, date))
    frame = _read_frame(directory / name, date)

    if interval_seconds == 60 and len(frame):
        # Whole minutes, then the ones that start inside the window; resampling a cut-out would make partial first candles.
        from app.services.data_loader import resample_to_candles
        frame = resample_to_candles(frame, 1)
    sod = _seconds_of_day(frame.index) if len(frame) else np.empty(0, dtype=np.int64)
    inside = (sod >= start_sec) & (sod < start_sec + duration_sec)
    chosen = frame[inside]
    paise = np.rint(chosen[games_index._PRICE_COLUMNS].to_numpy(dtype=float) * 100).astype(np.int64)
    result = {
        "symbol": symbol, "date": date, "interval_seconds": interval_seconds,
        "start_sec": start_sec, "duration_sec": duration_sec, "count": int(len(chosen)),
        "t": sod[inside].tolist(),
        "o": paise[:, 0].tolist(), "h": paise[:, 1].tolist(), "l": paise[:, 2].tolist(), "c": paise[:, 3].tolist(),
    }
    if right:
        result.update(expiry=expiry, strike=int(strike) if float(strike).is_integer() else float(strike), right=right)
    return result


# ---------------------------------------------------------------- response encoding
def encode_json(payload: dict, accept_encoding: str = "") -> tuple[bytes, dict[str, str]]:
    """Compact JSON, gzip-compressed when the client says it can read it (the compression is in this route only, not app-wide)."""
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Vary": "Accept-Encoding"}
    accepted = {part.split(";")[0].strip().lower() for part in accept_encoding.split(",")}
    if "gzip" in accepted and len(body) >= GZIP_MIN_BYTES:
        body = gzip.compress(body, compresslevel=6, mtime=0)
        headers["Content-Encoding"] = "gzip"
    return body, headers
