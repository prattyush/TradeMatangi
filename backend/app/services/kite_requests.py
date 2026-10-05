"""API-key scoped REST pacing, independent of Kite's live socket."""
import logging
import threading
import time
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)
_INTERVALS = {"historical": .35, "general": .11, "instruments": 1.05, "quote": 1.05}


@dataclass
class _Pacer:
    lock: threading.Lock = field(default_factory=threading.Lock)
    next_request: float = 0
    slow_until: float = 0
    interval: float = 0


_guard = threading.Lock()
_pacers = {}


def is_auth_error(exc):
    return getattr(exc, "code", None) in (401, 403) or type(exc).__name__ == "TokenException"


def request(kite, category, method, **kwargs):
    key = (kite.api_key, category)
    with _guard:
        pacer = _pacers.setdefault(key, _Pacer())
    base = _INTERVALS[category]
    # Pace actual request starts; queued callers cannot overtake a backoff.
    with pacer.lock:
        for attempt in range(4):
            now = time.monotonic()
            delay = max(0, pacer.next_request - now)
            if delay:
                time.sleep(delay)
            now = time.monotonic()
            interval = max(base, pacer.interval) if now < pacer.slow_until else base
            pacer.next_request = now + interval
            try:
                return getattr(kite, method)(**kwargs)
            except Exception as exc:
                limited = (getattr(exc, "code", None) == 429 or
                           any(s in str(exc).lower() for s in ("too many requests", "rate limit")))
                if not limited:
                    if is_auth_error(exc):
                        # Clear only the failing instance, never a newer token's client.
                        from app.services.kite_service import _invalidate_kite
                        _invalidate_kite(kite)
                    raise
                retry = 2 ** min(attempt, 2)
                headers = getattr(getattr(exc, "response", None), "headers", {}) or {}
                try:
                    retry = max(retry, float(headers.get("Retry-After", 0)))
                except (ValueError, TypeError):
                    pass
                pacer.interval = max(interval, retry)
                pacer.slow_until = time.monotonic() + 60
                pacer.next_request = time.monotonic() + retry
                logger.warning("kite_rest_throttled endpoint=%s retry_in=%.1fs attempt=%d", category, retry, attempt + 1)
                if attempt == 3:
                    raise
