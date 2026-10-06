"""Historical provider policy, independent of live feeds.

Replay always uses Breeze. Live history uses the configured provider, preferring
complete Breeze caches for earlier days. Minute caches never become replay ticks.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Literal
import json
import logging
import threading
import time

import pandas as pd

logger = logging.getLogger(__name__)
_POLICY_KEY = "historical_data_policy"


@dataclass(frozen=True)
class HistoricalPolicy:
    source: str = "breeze"
    allow_fallback: bool = False


@dataclass(frozen=True)
class HistoricalResult:
    frame: pd.DataFrame
    path: Path
    selected_provider: str
    actual_provider: str
    interval_seconds: int
    stale: bool = False


_policy_cache: tuple[float, HistoricalPolicy] | None = None
_policy_lock = threading.Lock()
_results: dict[tuple, tuple[float, HistoricalResult]] = {}
_locks: dict[tuple, threading.Lock] = {}
_guard = threading.Lock()
_last_warning: dict[tuple, float] = {}


def is_today(date: str) -> bool:
    return date == datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()


def get_policy() -> HistoricalPolicy:
    global _policy_cache
    with _policy_lock:
        if _policy_cache and time.monotonic() - _policy_cache[0] < 10:
            return _policy_cache[1]
        from app.services import token_service
        raw = token_service.get_token(_POLICY_KEY)
        policy = HistoricalPolicy()
        if raw:
            try:
                value = json.loads(raw)
                if value.get("source") in ("breeze", "kite", "kotak") and isinstance(value.get("allow_fallback"), bool):
                    policy = HistoricalPolicy(value["source"], value["allow_fallback"])
            except (ValueError, TypeError, AttributeError):
                logger.warning("Invalid historical policy; using Breeze without fallback")
        _policy_cache = (time.monotonic(), policy)
        return policy


def set_policy(policy: HistoricalPolicy) -> None:
    global _policy_cache
    if policy.source not in ("breeze", "kite", "kotak"):
        raise ValueError("Historical source must be breeze, kite or kotak")
    from app.services import token_service
    token_service.set_token(_POLICY_KEY, json.dumps({"source": policy.source, "allow_fallback": policy.allow_fallback}), strict=True)
    with _policy_lock:
        _policy_cache = (time.monotonic(), policy)
    with _guard:
        _results.clear()
    logger.info("historical_policy_updated source=%s allow_fallback=%s", policy.source, policy.allow_fallback)


def _warn(key: tuple, message: str, *args) -> None:
    with _guard:
        now = time.monotonic()
        if now - _last_warning.get(key, -60) < 60:
            return
        _last_warning[key] = now
    logger.warning(message, *args)


def _path(provider: str, symbol: str, date: str, strike: int | None, expiry: str | None, right: str | None) -> Path:
    from app.services.data_loader import parquet_path
    from app.services.options_service import options_parquet_path
    if provider == "breeze":
        return options_parquet_path(symbol, date, strike, expiry, right) if right else parquet_path(symbol, date)
    from app.config import OHLCDATA_DIR
    y, m, d = date.split("-")
    name = f"{symbol}-{right}-{strike}-{expiry.replace('-', '')}-{d}-{m}-{y}" if right else f"{symbol}-{d}-{m}-{y}"
    return OHLCDATA_DIR / f"{name}-{provider}1m.parquet"


def _normalize(frame: pd.DataFrame, date: str) -> pd.DataFrame:
    from app.config import get_market_close
    columns = ["open", "high", "low", "close"] + (["observed"] if "observed" in frame.columns else [])
    frame = frame.rename(columns=str.lower)[columns].copy()
    if frame.index.tzinfo is None:
        frame.index = frame.index.tz_localize("UTC")
    else:
        frame.index = frame.index.tz_convert("UTC")
    frame = frame.sort_index()
    frame = frame[~frame.index.duplicated(keep="last")]
    return frame[frame.index < pd.Timestamp(f"{date} {get_market_close(date)}", tz="UTC")]


def _fetch(provider: str, symbol: str, date: str, strike, expiry, right) -> pd.DataFrame:
    if provider == "kite":
        from app.services.kite_service import fetch_kite_1min, fetch_kite_1min_options
        return fetch_kite_1min_options(symbol, date, strike, expiry, right) if right else fetch_kite_1min(symbol, date)
    if provider == "kotak":
        from app.services.kotak_history import fetch_history
        return fetch_history(symbol, date, strike, expiry, right)
    if right:
        from app.services.options_service import _fetch_breeze_options_historical, _load_breeze_options_dataframe
        _fetch_breeze_options_historical(symbol, date, strike, expiry, right)
        return _load_breeze_options_dataframe(symbol, date, strike, expiry, right)
    from app.services.broker_service import _fetch_breeze_historical
    from app.services.data_loader import _load_breeze_dataframe
    _fetch_breeze_historical(symbol, date)
    return _load_breeze_dataframe(symbol, date)


def complete_day_cache(path: Path, date: str) -> bool:
    """A file written before that day's close may contain an intraday partial day."""
    from app.config import get_market_close
    close = pd.Timestamp(f"{date} {get_market_close(date)}", tz="Asia/Kolkata")
    return path.exists() and path.stat().st_mtime >= close.timestamp()


def _require_replay_cadence(frame: pd.DataFrame, mode: str) -> None:
    from app.services.data_loader import has_native_second_cadence
    if mode == "replay" and not has_native_second_cadence(frame):
        raise RuntimeError("Replay/stepwise requires Breeze second-level data")


def _complete_breeze_cache(symbol, date, strike, expiry, right, selected):
    """Read-only cache reuse; never trigger a slow Breeze download on a live miss."""
    from app.services.data_loader import _load_breeze_dataframe, has_native_second_cadence
    from app.services.broker_service import _MIN_DAY_ROWS
    from app.services.options_service import _MIN_OPTIONS_DAY_ROWS
    from app.config import MARKET_OPEN, get_market_close
    path = _path("breeze", symbol, date, strike, expiry, right)
    try:
        if path.exists():
            raw = pd.read_parquet(path)
        elif not right:
            from app.services.data_loader import pickle_path
            if not pickle_path(symbol, date).exists():
                return None
            raw = _load_breeze_dataframe(symbol, date)
        else:
            return None
        frame = _normalize(raw, date)
        minimum = _MIN_OPTIONS_DAY_ROWS if right else _MIN_DAY_ROWS
        close = pd.Timestamp(f"{date} {get_market_close(date)}", tz="UTC")
        if (len(frame) < minimum or not has_native_second_cadence(frame)
            or frame.index.min() > pd.Timestamp(f"{date} {MARKET_OPEN}", tz="UTC")
            or frame.index.max() < close - pd.Timedelta(seconds=1)):
            return None
        # Reuse this validated snapshot without a second parquet read. The
        # legacy loader above already handles equity pickle migration.
        logger.info("historical_cache_reused provider=breeze selected=%s symbol=%s date=%s right=%s", selected, symbol, date, right)
        return HistoricalResult(frame, path, selected, "breeze", 1)
    except Exception:
        return None


def _remember(key: tuple, result: HistoricalResult) -> None:
    now = time.monotonic()
    for old in [old for old, (when, _) in _results.items() if now - when >= 10]:
        _results.pop(old, None)
    if len(_results) >= 128:
        _results.pop(next(iter(_results)))
    _results[key] = (now, result)


def load_history(symbol: str, date: str, strike: int | None = None, expiry: str | None = None,
                 right: str | None = None, *, policy: HistoricalPolicy | None = None,
                 force_refresh: bool = False, mode: Literal["live", "replay"] | None = None) -> HistoricalResult:
    """Resolve/fetch a single contract/day and return the exact selected frame.

    Brief request coalescing allows old ensure/load callers to share one result.
    Freshness TTL for provider files is preserved; force_refresh bypasses it.
    """
    requested_at = time.monotonic()
    operation = _operation.get()
    mode = mode or history_mode()
    if mode not in ("live", "replay"):
        raise ValueError("History mode must be live or replay")
    if mode == "live":
        if operation:
            with operation.policy_lock:
                if operation.policy is None:
                    operation.policy = policy or get_policy()
                snapshot = operation.policy
            policy = policy or snapshot
        else:
            policy = policy or get_policy()
    else:
        policy = HistoricalPolicy()
    if right:
        right = "CE" if right.upper() in ("CE", "CALL") else "PE"
    # Include the cache location: separate data roots must never share frames.
    cache_path = _path(policy.source, symbol, date, strike, expiry, right)
    key = (symbol, date, strike, expiry, right, policy, mode, str(cache_path),
           str(_path("breeze", symbol, date, strike, expiry, right)))
    if operation and key in operation.results:
        return operation.results[key]
    force_refresh = is_today(date) and (force_refresh or bool(operation and operation.force_refresh))
    with _guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        if operation and key in operation.results:
            return operation.results[key]
        with _guard:
            cached = _results.get(key)
        if cached and (not force_refresh or cached[0] >= requested_at) and time.monotonic() - cached[0] < 10:
            if operation:
                operation.results[key] = cached[1]
            return cached[1]
        if mode == "live" and not is_today(date):
            reused = _complete_breeze_cache(symbol, date, strike, expiry, right, policy.source)
            if reused is not None:
                with _guard:
                    _remember(key, reused)
                if operation:
                    operation.results[key] = reused
                return reused
        providers = [policy.source]
        if policy.allow_fallback:
            providers.extend({"breeze": ["kite"], "kite": ["breeze"], "kotak": ["kite", "breeze"]}[policy.source])
        stale_results = []
        last_error = None
        for provider in providers:
            path = _path(provider, symbol, date, strike, expiry, right)
            try:
                # Breeze supports explicit refresh; ordinary reads keep its cache TTL.
                if provider == "breeze" and force_refresh:
                    if right:
                        from app.services.options_service import _fetch_breeze_options_historical
                        _fetch_breeze_options_historical(symbol, date, strike, expiry, right, force_refresh=True)
                    else:
                        from app.services.broker_service import _fetch_breeze_historical
                        _fetch_breeze_historical(symbol, date, force_refresh=True)
                    frame = pd.read_parquet(path)
                else:
                    frame = _fetch(provider, symbol, date, strike, expiry, right)
                if frame.empty:
                    raise RuntimeError(f"{provider} returned no historical data")
                frame = _normalize(frame, date)
                if frame.empty:
                    raise RuntimeError(f"{provider} returned no market-hours historical data")
                _require_replay_cadence(frame, mode)
                stale = is_today(date) and path.exists() and time.time() - path.stat().st_mtime >= 600
                from app.services.data_loader import has_native_second_cadence
                result = HistoricalResult(frame, path, policy.source, provider,
                    1 if has_native_second_cadence(frame) else 60, stale)
                if stale:
                    stale_results.append(result)
                    continue
                if provider != policy.source:
                    _warn(key, "historical_fallback symbol=%s date=%s right=%s selected=%s actual=%s", symbol, date, right, policy.source, provider)
                with _guard:
                    _remember(key, result)
                if operation:
                    operation.results[key] = result
                return result
            except Exception as exc:
                last_error = exc
                if (is_today(date) or provider in ("kite", "kotak")) and path.exists():
                    try:
                        frame = _normalize(pd.read_parquet(path), date)
                        if not frame.empty:
                            _require_replay_cadence(frame, mode)
                            from app.services.data_loader import has_native_second_cadence
                            stale_results.append(HistoricalResult(frame, path, policy.source, provider,
                                1 if has_native_second_cadence(frame) else 60, True))
                    except Exception:
                        pass
        if stale_results:
            result = stale_results[0]
            _warn(key, "historical_stale_cache symbol=%s date=%s right=%s provider=%s", symbol, date, right, result.actual_provider)
            with _guard:
                _remember(key, result)
            if operation:
                operation.results[key] = result
            return result
        if last_error:
            raise last_error
        raise RuntimeError(f"No historical data for {symbol} on {date}")


# FastAPI's async dependency keeps one policy/result set through ensure + load,
# including asyncio.to_thread calls. Admin updates cannot split one chart request.
@dataclass
class HistoricalOperation:
    policy: HistoricalPolicy | None = None
    results: dict = field(default_factory=dict)
    force_refresh: bool = False
    mode: Literal["live", "replay"] = "replay"
    policy_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)


_operation: ContextVar[HistoricalOperation | None] = ContextVar("historical_operation", default=None)
_background_mode: ContextVar[Literal["live", "replay"]] = ContextVar("historical_background_mode", default="replay")


def refresh_requested() -> bool:
    operation = _operation.get()
    return bool(operation and operation.force_refresh)


def history_mode() -> Literal["live", "replay"]:
    operation = _operation.get()
    return operation.mode if operation else _background_mode.get()


@contextmanager
def historical_operation(*, force_refresh: bool = False, mode: Literal["live", "replay"] | None = None):
    parent = _operation.get()
    if parent is not None and (mode is None or mode == parent.mode) and (not force_refresh or parent.force_refresh):
        yield
        return
    selected_mode = mode or history_mode()
    token = _operation.set(HistoricalOperation(
        force_refresh=force_refresh or bool(parent and parent.force_refresh), mode=selected_mode))
    try:
        yield
    finally:
        _operation.reset(token)


async def historical_request_scope(force_refresh: bool = False,
                                   history_mode: Literal["live", "replay"] = "replay"):
    with historical_operation(force_refresh=force_refresh, mode=history_mode):
        yield


def detach_historical_operation(*, mode: Literal["live", "replay"] = "replay") -> None:
    """Keep only the engine's mode, never a long-lived HTTP result/policy cache."""
    _operation.set(None)
    _background_mode.set(mode)
