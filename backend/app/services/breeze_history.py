"""Process-wide pacing and cooldown for Breeze historical HTTP requests."""
import threading
import time

_MIN_INTERVAL = 1.0
_COOLDOWN_SECONDS = 60.0
_lock = threading.Lock()
_next_request = 0.0
_retry_after = 0.0


class BreezeHistoryRateLimitError(RuntimeError):
    pass


def request_history(breeze, **kwargs):
    global _next_request, _retry_after
    with _lock:
        now = time.monotonic()
        if now < _retry_after:
            raise BreezeHistoryRateLimitError("Breeze history rate limit cooldown; retry later")
        slot = max(now, _next_request)
        _next_request = slot + _MIN_INTERVAL
    delay = slot - now
    if delay > 0:
        time.sleep(delay)
    with _lock:
        # Respect rate limits reported by another in-flight history request.
        if time.monotonic() < _retry_after:
            raise BreezeHistoryRateLimitError("Breeze history rate limit cooldown; retry later")
    try:
        response = breeze.get_historical_data_v2(**kwargs)
    except Exception as exc:
        if "rate limit" not in str(exc).lower():
            raise
        with _lock:
            _retry_after = max(_retry_after, time.monotonic() + _COOLDOWN_SECONDS)
        raise BreezeHistoryRateLimitError("Breeze history rate limit; retry after cooldown") from exc
    if isinstance(response, dict) and (
            str(response.get("Status")) == "429" or
            "rate limit" in str(response.get("Error") or "").lower()):
        with _lock:
            _retry_after = max(_retry_after, time.monotonic() + _COOLDOWN_SECONDS)
        raise BreezeHistoryRateLimitError("Breeze history rate limit; retry after cooldown")
    return response
