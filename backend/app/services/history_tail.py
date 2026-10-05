"""Reuse daily Breeze parquets while downloading a bounded, overlapping tail."""
from datetime import datetime
from zoneinfo import ZoneInfo
import pandas as pd


def fetch_window(date, cached=None):
    from app.config import MARKET_OPEN, get_market_close
    from app.services.historical_data_service import is_today
    start = pd.Timestamp(f"{date} {MARKET_OPEN}")
    end = pd.Timestamp(f"{date} {get_market_close(date)}")
    if is_today(date):
        end = min(end, pd.Timestamp(datetime.now(ZoneInfo("Asia/Kolkata")).replace(tzinfo=None)))
        if cached is not None and not cached.empty:
            last = cached.index.max().tz_localize(None)
            # One completed chunk before the last cached partial chunk.
            chunks = max(0, int((last - start).total_seconds() // 900) - 1)
            start += pd.Timedelta(minutes=15 * chunks)
    return start, end


def merge_tail(cached, fresh):
    if cached is None or cached.empty:
        return fresh
    from app.services.data_loader import has_native_second_cadence
    if has_native_second_cadence(cached) != has_native_second_cadence(fresh):
        raise RuntimeError("Breeze historical cadence changed; preserving existing cache")
    cached = cached.copy()
    cached.index = cached.index.tz_localize(None)
    frame = pd.concat([cached, fresh])
    return frame[~frame.index.duplicated(keep="last")].sort_index()
