"""Opt-in bounded feed diagnostics; no payload logging, storage or broker calls."""
import asyncio
from functools import wraps
import inspect
import json
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)
ENABLED = os.getenv("TRADING_PERFORMANCE_DIAGNOSTICS") == "1"
_lock = threading.Lock()
_counts = {}
_maxima = {}
_last_batch = 0.0
_last_callback_sample = 0.0
_measuring_feed = False
_stream_samples = {}  # capped: session/stream identities are diagnostic-only
_last_warning = {}


def count(name, value=1):
    if ENABLED:
        with _lock:
            _counts[name] = _counts.get(name, 0) + value


def observe(name, value):
    if ENABLED:
        with _lock:
            _maxima[name] = max(_maxima.get(name, 0), value)


def kite_batch(size):
    global _last_batch, _last_callback_sample
    now = time.monotonic()
    with _lock:
        _counts["kite_batches"] = _counts.get("kite_batches", 0) + 1
        _counts["kite_ticks"] = _counts.get("kite_ticks", 0) + size
        if size:
            if _measuring_feed and _last_batch:
                _maxima["kite_arrival_gap_ms"] = max(_maxima.get("kite_arrival_gap_ms", 0), (now - _last_batch) * 1000)
            _last_batch = now
        if now - _last_callback_sample >= 1:
            _last_callback_sample = now
            return now
    return None


def timed(name):
    """Measure existing operations only when enabled; preserve return/errors."""
    def decorate(function):
        if inspect.iscoroutinefunction(function):
            @wraps(function)
            async def asynchronous(*args, **kwargs):
                if not ENABLED:
                    return await function(*args, **kwargs)
                started = time.monotonic()
                try:
                    return await function(*args, **kwargs)
                finally:
                    count(name + "_calls")
                    observe(name + "_ms", (time.monotonic() - started) * 1000)
            return asynchronous
        @wraps(function)
        def synchronous(*args, **kwargs):
            if not ENABLED:
                return function(*args, **kwargs)
            started = time.monotonic()
            try:
                return function(*args, **kwargs)
            finally:
                count(name + "_calls")
                observe(name + "_ms", (time.monotonic() - started) * 1000)
        return synchronous
    return decorate


def sample_sse(event, event_id, scope):
    """Only sampled tick frames get correlation metadata; never change stored events."""
    if not ENABLED:
        return event
    now = time.monotonic()
    if now - _stream_samples.get(scope, float("-inf")) < 1:
        return event
    try:
        payload = json.loads(event)
    except (ValueError, TypeError):
        return event
    if not isinstance(payload, dict) or payload.get("type") not in ("tick", "candle"):
        return event
    if scope not in _stream_samples and len(_stream_samples) >= 128:
        _stream_samples.pop(next(iter(_stream_samples)))
    _stream_samples[scope] = now
    payload["_feed_diagnostic"] = {"event_id": event_id, "sent_at_ms": time.time() * 1000}
    return json.dumps(payload)


def snapshot():
    with _lock:
        result = {**_counts, **_maxima}
        _counts.clear()
        _maxima.clear()
    return result


async def monitor_loop_lag():
    global _measuring_feed, _last_batch
    if not ENABLED:
        return
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from app.config import get_market_close
    from app.services.kite_service import get_broadcaster
    # Never start a reactor for diagnostics; probe only an already running one.
    from twisted.internet import reactor
    probe = None
    next_summary = time.monotonic() + 30
    while True:
        expected = time.monotonic() + 1
        await asyncio.sleep(1)
        now = time.monotonic()
        observe("loop_lag_ms", max(0, now - expected) * 1000)
        broadcaster = get_broadcaster()
        local = datetime.now(ZoneInfo("Asia/Kolkata"))
        trading = local.weekday() < 5 and "09:15:00" <= local.strftime("%H:%M:%S") < get_market_close(local.date().isoformat())
        active = broadcaster._connected and bool(broadcaster._token_sessions)
        with _lock:
            if active and trading and not _measuring_feed:
                _last_batch = now
            _measuring_feed = active and trading
            last_batch = _last_batch
        if _measuring_feed and last_batch:
            observe("kite_arrival_gap_ms", (now - last_batch) * 1000)
        if probe:
            sent, done, arrived = probe
            if done.is_set():
                observe("kite_reactor_lag_ms", (arrived[0] - sent) * 1000)
                probe = None
            elif active and reactor.running:
                observe("kite_reactor_lag_ms", (now - sent) * 1000)
        if active and reactor.running and probe is None:
            done, arrived = threading.Event(), []
            probe = (time.monotonic(), done, arrived)
            def finish(done=done, arrived=arrived):
                arrived.append(time.monotonic())
                done.set()
            reactor.callFromThread(finish)
        if now >= next_summary:
            metrics = snapshot()
            logger.info("trading_performance %s", json.dumps(metrics, sort_keys=True))
            for name, value in metrics.items():
                threshold = 2000 if name == "kite_arrival_gap_ms" else 500
                if name.endswith("_ms") and value > threshold and now - _last_warning.get(name, float("-inf")) >= 30:
                    _last_warning[name] = now
                    logger.warning("trading_performance_delay category=%s max_ms=%.1f connected=%s active=%s market_open=%s", name, value, broadcaster._connected, active, trading)
            next_summary = now + 30
