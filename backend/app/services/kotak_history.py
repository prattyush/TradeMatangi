"""Read-only Kotak minute history; independent of trading auth and live feeds."""
from dataclasses import dataclass, field
from datetime import datetime
import logging
import math
import os
import threading
import time
from zoneinfo import ZoneInfo

import pandas as pd

logger = logging.getLogger(__name__)
_client_lock = threading.RLock()
_client = None
_consumer_key = None
_guard = threading.Lock()
_locks = {}
_pacers = {}
_MIN_INTERVAL = .05


@dataclass
class _Pacer:
    lock: threading.Lock = field(default_factory=threading.Lock)
    next_request: float = 0
    cooldown: float = 0


def _get_client():
    global _client, _consumer_key
    from app.services.kotak_service import _read_kotak_credentials, KotakError, KotakNeoService
    key = _read_kotak_credentials()["access_token"]
    if not key:
        raise KotakError("Kotak history requires the configured consumer key")
    with _client_lock:
        if _client is None or key != _consumer_key:
            from neo_api_client import NeoAPI
            new = NeoAPI(consumer_key=key, environment="prod")
            KotakNeoService._close_client(_client)
            _client, _consumer_key = new, key
        return _client


def _request(client, **kwargs):
    key = client.configuration.consumer_key
    with _guard:
        pacer = _pacers.setdefault(key, _Pacer())
    with pacer.lock:
        now = time.monotonic()
        if now < pacer.cooldown:
            raise RuntimeError("Kotak history rate limit cooldown; retry later")
        delay = pacer.next_request - now
        if delay > 0:
            time.sleep(delay)
        pacer.next_request = time.monotonic() + _MIN_INTERVAL
        try:
            response = client.historical_data(**kwargs)
        except Exception as exc:
            if (getattr(exc, "code", None) == 429 or getattr(getattr(exc, "response", None), "status_code", None) == 429) or any(t in str(exc).lower() for t in ("rate limit", "too many requests")):
                pacer.cooldown = time.monotonic() + 60
            raise
        fault = response.get("fault") if isinstance(response, dict) else None
        fault = fault if isinstance(fault, dict) else {}
        if (isinstance(response, dict) and
            (str(fault.get("code")) == "429" or str(response.get("StatusCode")) == "429")):
            try:
                cooldown = max(1, float((response.get("rateLimit") or {}).get("Retry-After", 60)))
            except (TypeError, ValueError):
                cooldown = 60
            if not math.isfinite(cooldown):
                cooldown = 60
            pacer.cooldown = time.monotonic() + cooldown
            logger.warning("kotak_history_throttled retry_after=%.0fs", cooldown)
            raise RuntimeError("Kotak history rate limit cooldown; retry later")
        if not isinstance(response, dict) or str(response.get("status", "")).lower() != "success":
            raise RuntimeError(f"Kotak historical data failed: {fault.get('message', 'invalid response')}")
        return response


def _frame(response, date):
    from app.config import MARKET_OPEN, get_market_close
    from app.services.historical_data_service import is_today
    data = response.get("data")
    rows = data.get("candles") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Kotak returned no historical candles; the contract may be inactive or expired")
    records = []
    start, end = pd.Timestamp(f"{date} {MARKET_OPEN}"), pd.Timestamp(f"{date} {get_market_close(date)}")
    now = pd.Timestamp(datetime.now(ZoneInfo("Asia/Kolkata")).replace(tzinfo=None)) if is_today(date) else None
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            raise RuntimeError("Malformed Kotak historical candle")
        timestamp = pd.Timestamp(row[0])
        if timestamp.tzinfo is not None:
            timestamp = timestamp.tz_convert("Asia/Kolkata").tz_localize(None)
        if not start <= timestamp < end or (now is not None and timestamp > now):
            continue
        prices = [float(value) for value in row[1:5]]
        # The live endpoint can return a full-day grid of untraded/future
        # placeholders. Those rows do not constitute historical prices.
        if all(value == 0 for value in prices):
            continue
        volume = float(row[5]) if row[5] not in (None, "") else 0.0
        if any(not math.isfinite(value) or value <= 0 for value in prices) or not math.isfinite(volume):
            raise RuntimeError("Invalid Kotak historical candle values")
        records.append([timestamp, *prices, max(0.0, volume)])
    if not records:
        raise RuntimeError("Kotak returned no usable market-hours candles for the requested day")
    frame = pd.DataFrame(records, columns=["datetime", "open", "high", "low", "close", "volume"]).set_index("datetime")
    frame["observed"] = True
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    if frame.empty:
        raise RuntimeError("Kotak returned no market-hours candles for the requested day")
    if any(ts.second or ts.microsecond for ts in frame.index):
        raise RuntimeError("Kotak historical response is not minute candles")
    return frame


def fetch_history(symbol, date, strike=None, expiry=None, right=None):
    from app.services.historical_data_service import _path, is_today, complete_day_cache
    from app.services.kotak_service import fetch_kotak_equity_instrument_token, fetch_kotak_options_instrument_token
    path = _path("kotak", symbol, date, strike, expiry, right)
    with _guard:
        lock = _locks.setdefault(str(path.resolve()), threading.Lock())
    with lock:
        if not is_today(date) and complete_day_cache(path, date):
            try:
                cached = pd.read_parquet(path)
                # Validate an existing file with the same conversion as API data.
                response = {"data": {"candles": [[idx, *row] for idx, row in cached[["open", "high", "low", "close", "volume"]].iterrows()]}}
                return _frame(response, date)
            except Exception:
                logger.warning("Kotak history cache unreadable symbol=%s date=%s", symbol, date)
        with _client_lock:
            client = _get_client()
            token, exchange = (fetch_kotak_options_instrument_token(symbol, expiry, strike, right, client=client)
                               if right else fetch_kotak_equity_instrument_token(symbol, client=client))
            response = _request(client, neosymbol=f"{exchange}|{token}", interval="1min", from_date=date, to_date=date)
        frame = _frame(response, date)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        try:
            frame.to_parquet(tmp)
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
        logger.info("kotak_history_fetched symbol=%s date=%s right=%s candles=%d", symbol, date, right, len(frame))
        return frame
