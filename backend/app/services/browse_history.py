"""Paged candles for Browse: an index or equity, 1 minute to daily, up to about a year back.

Read-only and portfolio-free (the Swing chart history is bound to a portfolio and to the admin source policy). A page is
a run of whole trading days ending at the anchor day, or just before `before` when the client scrolls back; the client
asks again with the oldest time it has until `more` is false. Data comes from the cheapest sources first:

* **Per-day 1-minute files** shared with ``minute_history`` (``OHLCDATA_DIR/minute/<provider>/<id>/<date>.parquet``, final
  once written after that day's close, 60 s for today). Missing days are fetched in **one provider call per window**
  (Kite: up to 60 days per call; Breeze: 2 days, its ~1000-record cap; Kotak: 30 days) and split into per-day files, so a
  year costs a handful of calls instead of one per day, and a neighbouring page is already cached.
* **One rolling daily file** per instrument for 1D (a single provider call per refresh).
* 3m to 60m are derived from the 1-minute files on clock boundaries (09:00, 10:00 for 60 minutes), the same bars the other
  Browse and Analysis routes draw, so a scrolled-back page joins the first page without a seam.

Fixed provider order Kite, Breeze, Kotak (equities only; Kotak returns placeholders for indices), not the admin policy
(whose default is the slowest source). Nothing here writes the second-level files replay uses.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from datetime import date as Date
from datetime import timedelta
from pathlib import Path

import pandas as pd

from app.config import OHLCDATA_DIR, get_market_close
from app.services import minute_history, swing_charts, swing_market
from app.services.historical_data_service import complete_day_cache
from app.utils import is_trading_day

logger = logging.getLogger(__name__)

INTERVALS = (1, 3, 5, 15, 30, 60, 1440)

#: Calendar days back from the anchor a pane can scroll (bounds memory and the chart's indicator cost). The pane's own
#: date lets the user jump anywhere, so a deeper look at minutes is a date change away.
HORIZON_DAYS = {1: 90, 3: 365, 5: 365, 15: 550, 30: 550, 60: 550, 1440: 550}
#: Trading days in a page after the first, by interval (roughly 1,000 to 2,000 bars).
PAGE_DAYS = {1: 5, 3: 15, 5: 20, 15: 60, 30: 120, 60: 120, 1440: 400}
#: Trading days in the first page: today's Browse view (the day and two before) for fine intervals, more for coarse ones.
FIRST_PAGE_DAYS = {1: 3, 3: 3, 5: 3, 15: 10, 30: 20, 60: 40, 1440: 250}
#: Calendar days one provider call may span.
WINDOW_DAYS = {"kite": 60, "breeze": 2, "kotak": 30}
_COOLDOWN_SECONDS = 60
_TODAY_TTL_SECONDS = 60

_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()
_cooldown: dict[str, tuple[float, str]] = {}


class BrowseUnavailable(Exception):
    """No source could answer; the message says why in words fit for a banner."""


def _lock(key: str) -> threading.Lock:
    with _guard:
        return _locks.setdefault(key, threading.Lock())


def _providers(item: dict) -> list[str]:
    return ["kite", "breeze"] + (["kotak"] if item["kind"] == "equity" else [])


def _token_reason(provider: str, exc: Exception) -> str | None:
    name = type(exc).__name__
    if name in ("KiteTokenError", "BreezeTokenError"):
        return f"The {provider.capitalize()} session has expired. Sign in to {provider.capitalize()} again."
    return None


def _cooling(provider: str) -> str | None:
    entry = _cooldown.get(provider)
    if entry and entry[0] > time.monotonic():
        return entry[1]
    return None


def trading_days_back(end_day: Date, count: int, lower: Date) -> list[Date]:
    """Up to `count` trading days ending at `end_day`, newest first, none before `lower`."""
    found: list[Date] = []
    day = end_day
    while len(found) < count and day >= lower:
        if is_trading_day(day):
            found.append(day)
        day -= timedelta(days=1)
    return found


def _identity(item: dict) -> str:
    return hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()[:24]


def _day_path(provider: str, item: dict, day: Date) -> Path:
    return minute_history._path(provider, item, day.isoformat())


def _cached_day(item: dict, day: Date) -> pd.DataFrame | None:
    for provider in _providers(item):
        path = _day_path(provider, item, day)
        if minute_history._usable(path, day.isoformat()):
            try:
                return pd.read_parquet(path)
            except Exception:  # noqa: BLE001 - a damaged file is simply refetched
                logger.warning("browse_history unreadable cache file %s", path)
    return None


def _write_day(provider: str, item: dict, day: Date, rows: pd.DataFrame) -> pd.DataFrame:
    frame = minute_history._to_frame(rows, day.isoformat())
    if frame.empty:
        return frame
    path = _day_path(provider, item, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    frame.to_parquet(temporary)
    os.replace(temporary, path)
    return frame


def _windows(days: list[Date], span: int) -> list[tuple[Date, Date]]:
    """Group sorted days into calendar windows of at most `span` days (one provider call each)."""
    windows: list[tuple[Date, Date]] = []
    start = last = None
    for day in sorted(days):
        if start is None:
            start = last = day
        elif (day - start).days < span:
            last = day
        else:
            windows.append((start, last))
            start = last = day
    if start is not None:
        windows.append((start, last))
    return windows


def _fetch_window(provider: str, item: dict, first: Date, last: Date) -> pd.DataFrame:
    start = pd.Timestamp(f"{first.isoformat()} 09:15:00")
    end = pd.Timestamp(f"{last.isoformat()} 15:30:00")
    return swing_charts.normalize(swing_charts._fetch(provider, item, start, end, False), False)


def _fetch_span(provider: str, item: dict, days: list[Date], span: int) -> pd.DataFrame:
    """Rows for the days in one call; if the provider refuses the window as too long, halve it (down to a week) and ask again."""
    try:
        return _fetch_window(provider, item, min(days), max(days))
    except Exception as exc:  # noqa: BLE001
        if _token_reason(provider, exc) or span <= 7 or (max(days) - min(days)).days < 7:
            raise
        logger.info("browse_history provider=%s refused a %s-day window, halving: %s", provider, span, exc)
        parts = [_fetch_span(provider, item, [d for d in days if first <= d <= last], span // 2) for first, last in _windows(days, max(7, span // 2))]
        return pd.concat(parts).sort_index() if parts else pd.DataFrame()


def _fill_days(item: dict, wanted: list[Date]) -> dict[Date, pd.DataFrame]:
    """The 1-minute frame of every wanted day that any source can give, fetching missing days in windows."""
    have: dict[Date, pd.DataFrame] = {}
    missing: list[Date] = []
    for day in wanted:
        frame = _cached_day(item, day)
        if frame is not None:
            have[day] = frame
        else:
            missing.append(day)
    failure: str | None = None
    for provider in _providers(item):
        if not missing:
            break
        cooling = _cooling(provider)
        if cooling:
            failure = failure or cooling
            continue
        for first, last in _windows(missing, WINDOW_DAYS[provider]):
            key = f"{provider}:{_identity(item)}:{first}:{last}"
            with _lock(key):
                # Another request may have filled these days while this one waited for the lock.
                todo = [day for day in missing if first <= day <= last and day not in have]
                for day in list(todo):
                    frame = _cached_day(item, day)
                    if frame is not None:
                        have[day] = frame
                        todo.remove(day)
                if not todo:
                    continue
                try:
                    rows = _fetch_span(provider, item, todo, WINDOW_DAYS[provider])
                except Exception as exc:  # noqa: BLE001 - try the next source
                    reason = _token_reason(provider, exc)
                    if reason:
                        _cooldown[provider] = (time.monotonic() + _COOLDOWN_SECONDS, reason)
                        failure = failure or reason
                        break
                    logger.warning("browse_history provider=%s %s..%s failed: %s", provider, first, last, exc)
                    failure = failure or "Historical provider failed. Try again."
                    continue
                for day in todo:
                    day_rows = rows[rows.index.date == day]
                    if day_rows.empty:
                        continue
                    frame = _write_day(provider, item, day, day_rows)
                    if not frame.empty:
                        have[day] = frame
        missing = [day for day in missing if day not in have]
    if not have and failure:
        raise BrowseUnavailable(failure)
    return have


def _daily_paths(provider: str, item: dict) -> tuple[Path, Path]:
    folder = minute_history.minute_folder() / provider / _identity(item)
    return folder / "daily.parquet", folder / "daily.json"


def _daily_final(fetched_at: float, last_day: Date) -> bool:
    """A daily file is final for days before today; today's bar changes until the close."""
    if last_day < Date.fromisoformat(swing_market.today()):
        return True
    close = pd.Timestamp(f"{last_day.isoformat()} {get_market_close(last_day.isoformat())}", tz="Asia/Kolkata").timestamp()
    return fetched_at >= close or time.time() - fetched_at < _TODAY_TTL_SECONDS


def _daily_rows(item: dict, first: Date, last: Date) -> pd.DataFrame:
    """Daily candles between the dates from one rolling file per instrument, refreshed with a single provider call."""
    failure: str | None = None
    for provider in [name for name in _providers(item) if name != "kotak"]:
        cooling = _cooling(provider)
        if cooling:
            failure = failure or cooling
            continue
        data_path, meta_path = _daily_paths(provider, item)
        with _lock(f"daily:{provider}:{_identity(item)}"):
            cached = None
            meta: dict = {}
            if data_path.exists() and meta_path.exists():
                try:
                    cached = pd.read_parquet(data_path)
                    meta = json.loads(meta_path.read_text())
                except Exception:  # noqa: BLE001
                    cached, meta = None, {}
            covered = bool(meta) and meta["from"] <= first.isoformat() and meta["to"] >= last.isoformat() and _daily_final(meta["at"], last)
            if not covered:
                low = min(first, Date.fromisoformat(meta["from"])) if meta else first
                high = max(last, Date.fromisoformat(meta["to"])) if meta else last
                try:
                    fresh = swing_charts.normalize(
                        swing_charts._fetch(provider, item, pd.Timestamp(low.isoformat()), pd.Timestamp(f"{high.isoformat()} 15:30:00"), True), True)
                except Exception as exc:  # noqa: BLE001
                    reason = _token_reason(provider, exc)
                    if reason:
                        _cooldown[provider] = (time.monotonic() + _COOLDOWN_SECONDS, reason)
                    logger.warning("browse_history daily provider=%s failed: %s", provider, exc)
                    failure = failure or reason or "Historical provider failed. Try again."
                    continue
                if fresh.empty:
                    continue
                merged = fresh if cached is None else pd.concat([cached[~cached.index.isin(fresh.index)], fresh]).sort_index()
                data_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = data_path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
                merged.to_parquet(temporary)
                os.replace(temporary, data_path)
                meta_path.write_text(json.dumps({"from": low.isoformat(), "to": high.isoformat(), "at": time.time()}))
                cached = merged
            if cached is not None and not cached.empty:
                return cached[(cached.index >= pd.Timestamp(first.isoformat())) & (cached.index <= pd.Timestamp(last.isoformat()))]
    if failure:
        raise BrowseUnavailable(failure)
    return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])


def _records(frame: pd.DataFrame) -> list[dict]:
    return [
        {"time": int(stamp), "timestamp": int(stamp), **{key: float(row[key]) for key in ("open", "high", "low", "close", "volume")}}
        for stamp, row in frame.iterrows()
    ]


def _bucketed(frames: list[pd.DataFrame], interval: int) -> pd.DataFrame:
    frame = pd.concat(frames).sort_index()
    frame = frame[~frame.index.duplicated(keep="last")]
    seconds = [int(stamp.timestamp()) for stamp in frame.index]
    if interval == 1:
        out = frame[["open", "high", "low", "close", "volume"]].copy()
        out.index = seconds
        return out
    stamps = [second // (interval * 60) * (interval * 60) for second in seconds]
    return frame.groupby(stamps).agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})


def page(symbol: str, interval: int, anchor: Date, before: int | None = None, days: int | None = None) -> dict:
    """One page of candles ending at `anchor` (or just before `before`, epoch seconds IST-as-UTC)."""
    if interval not in INTERVALS:
        raise ValueError("Unsupported interval")
    item = swing_charts.instrument(symbol)
    if item["kind"] not in ("index", "equity"):
        raise ValueError("Browse history is for indices and equities")
    today = Date.fromisoformat(swing_market.today())
    if anchor > today:
        raise ValueError("Browse cannot use a future date")
    lower = anchor - timedelta(days=HORIZON_DAYS[interval])
    end_day = anchor
    cutoff = None
    if before is not None:
        cutoff = pd.Timestamp(int(before), unit="s", tz="UTC")
        # The client sends the open time of its oldest candle: that candle's day is already loaded when it is at or before
        # the 09:15 open (always for daily bars), so the next page starts on the day before.
        opening = cutoff.hour * 60 + cutoff.minute <= 9 * 60 + 15
        end_day = min(anchor, cutoff.date() - timedelta(days=1) if opening else cutoff.date())
    count = max(1, min(days or (PAGE_DAYS[interval] if before is not None else FIRST_PAGE_DAYS[interval]), 500))
    wanted = trading_days_back(end_day, count, lower)
    result = {"interval": interval, "date": anchor.isoformat(), "candles": [], "more": False, "before": None, "oldest_date": None,
              "provider": "cache", "partial": False, "stale": False}
    if not wanted:
        return result
    result["oldest_date"] = wanted[-1].isoformat()
    older = trading_days_back(wanted[-1] - timedelta(days=1), 1, lower)
    result["more"] = bool(older)
    if interval == 1440:
        frame = _daily_rows(item, wanted[-1], wanted[0])
        if cutoff is not None and not frame.empty:
            frame = frame[frame.index < cutoff.tz_localize(None)]
        if frame.empty:
            return result
        frame = frame.copy()
        frame.index = [int(stamp.tz_localize("UTC").timestamp()) for stamp in frame.index]
        result["candles"] = _records(frame)
    else:
        have = _fill_days(item, wanted)
        frames = [have[day] for day in sorted(have)]
        if not frames:
            return result
        merged = _bucketed(frames, interval)
        if cutoff is not None:
            merged = merged[merged.index < int(cutoff.timestamp())]
        result["candles"] = _records(merged)
    if result["candles"]:
        result["before"] = result["candles"][0]["time"]
    result["partial"] = wanted[0] == today and bool(swing_market.window(swing_market.now()))
    return result
