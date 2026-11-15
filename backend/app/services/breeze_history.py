"""Bounded overlap, process-wide pacing and cooldown for Breeze history HTTP."""
from concurrent.futures import CancelledError, FIRST_COMPLETED, ThreadPoolExecutor, wait
import logging
import threading
import time

logger = logging.getLogger(__name__)

CHUNK_SECONDS = 990  # 16m30s, at most 991 inclusive one-second candles (<1000 cap).
# One history request may start every 1.5 s (40/minute, well below the documented 100 API/minute) and at most two are
# in flight. Both were 1.0 s and three until Nov 2026, when connect timeouts to breezeapi.icicidirect.com appeared.
_MIN_INTERVAL = 1.5
_COOLDOWN_SECONDS = 60.0
_MAX_IN_FLIGHT = 2
# A connect timeout means the request never reached Breeze, so repeating it is safe. Other failures are not retried.
_CONNECT_RETRIES = 2
_CONNECT_BACKOFF = 3.0  # seconds before the first retry, doubled for the second
_lock = threading.Lock()
_next_request = 0.0
_retry_after = 0.0
_in_flight = threading.BoundedSemaphore(_MAX_IN_FLIGHT)
_executor = ThreadPoolExecutor(max_workers=_MAX_IN_FLIGHT, thread_name_prefix="breeze-chunks")


class _HistoryRequests:
    """Add a timeout only to the SDK's history GET; leave its other calls alone."""
    def __init__(self, transport, history_url):
        self._transport = transport
        self._history_url = history_url

    def __getattr__(self, name):
        return getattr(self._transport, name)

    def get(self, *args, **kwargs):
        url = kwargs.get("url", args[0] if args else None)
        if url == self._history_url:
            kwargs.setdefault("timeout", (10, 30))
        return self._transport.get(*args, **kwargs)


def import_sdk():
    """Import the Breeze SDK, and leave nothing behind when the import fails.

    The SDK inserts its own folder at sys.path[1] and then downloads ICICI's security master (no timeout) while it is
    being imported. When that download fails (seen: "Connection timed out", 2026-11-10 08:57) the import is abandoned
    but the sys.path entry stays, so the next `import breeze_connect` finds the plain file breeze_connect/breeze_connect.py
    instead of the package: `from breeze_connect import BreezeConnect` seems to work and `breeze_connect.breeze_connect`
    fails with "'breeze_connect' is not a package" for every later call until the process restarts.
    """
    import os
    import sys
    existing = sys.modules.get("breeze_connect")
    if existing is not None and not hasattr(existing, "__path__") and getattr(existing, "__file__", None):
        # Already poisoned by an earlier failure: drop the stray module and the SDK folder that made it importable by
        # itself, so the package is found again.
        folder = os.path.dirname(os.path.abspath(existing.__file__))
        sys.path[:] = [entry for entry in sys.path if os.path.abspath(entry or os.getcwd()) != folder]
        for name in [n for n in sys.modules if n == "breeze_connect" or n.startswith("breeze_connect.")]:
            sys.modules.pop(name, None)
    before = list(sys.path)
    try:
        import breeze_connect.breeze_connect as sdk
        return sdk
    except BaseException:
        sys.path[:] = before
        for name in [n for n in sys.modules if n == "breeze_connect" or n.startswith("breeze_connect.")]:
            sys.modules.pop(name, None)
        raise


def install_history_timeout():
    # SDK 1.0.69 omits timeout and accepts no timeout argument. Wrap its module
    # reference, not requests.get globally; SDK validation/auth remain intact.
    sdk = import_sdk()
    if not isinstance(sdk.requests, _HistoryRequests):
        sdk.requests = _HistoryRequests(
            sdk.requests, sdk.config.BREEZE_NEW_URL + sdk.api_endpoint.HIST_CHART.value)


class BreezeHistoryRateLimitError(RuntimeError):
    pass


def _check_cancelled(cancelled):
    if cancelled is not None and cancelled.is_set():
        raise CancelledError()


def _wait_turn(cancelled):
    global _next_request
    while True:
        _check_cancelled(cancelled)
        with _lock:
            now = time.monotonic()
            if now < _retry_after:
                raise BreezeHistoryRateLimitError("Breeze history rate limit cooldown; retry later")
            delay = _next_request - now
            if delay <= 0:
                # Claim at dispatch, not a future reservation. Delayed workers
                # recheck the clock so waking together cannot release a burst.
                _next_request = now + _MIN_INTERVAL
                return
        if cancelled is None:
            time.sleep(delay)
        elif cancelled.wait(delay):
            raise CancelledError()


def _is_connect_failure(exc):
    # The SDK wraps the requests error in a plain Exception, so the text is all that is left to go on.
    text = str(exc).lower()
    return "connecttimeout" in text or "connect timeout" in text or "failed to establish a new connection" in text


def _backoff(delay, cancelled):
    if cancelled is None:
        time.sleep(delay)
    elif cancelled.wait(delay):
        raise CancelledError()


def request_history(breeze, *, _cancelled=None, **kwargs):
    global _retry_after
    _check_cancelled(_cancelled)
    with _in_flight:
        retries = 0
        while True:
            _wait_turn(_cancelled)
            _check_cancelled(_cancelled)
            try:
                response = breeze.get_historical_data_v2(**kwargs)
                break
            except Exception as exc:
                if "rate limit" in str(exc).lower():
                    with _lock:
                        _retry_after = max(_retry_after, time.monotonic() + _COOLDOWN_SECONDS)
                    raise BreezeHistoryRateLimitError("Breeze history rate limit; retry after cooldown") from exc
                if retries >= _CONNECT_RETRIES or not _is_connect_failure(exc):
                    raise
                retries += 1
                delay = _CONNECT_BACKOFF * 2 ** (retries - 1)
                logger.warning("breeze_history_connect_retry attempt=%d of %d in %.1fs: %s",
                               retries, _CONNECT_RETRIES, delay, str(exc)[:160])
                _backoff(delay, _cancelled)
        if isinstance(response, dict) and (
                str(response.get("Status")) == "429" or
                "rate limit" in str(response.get("Error") or "").lower()):
            with _lock:
                _retry_after = max(_retry_after, time.monotonic() + _COOLDOWN_SECONDS)
            raise BreezeHistoryRateLimitError("Breeze history rate limit; retry after cooldown")
        return response


def fetch_chunks(windows, fetch):
    """Overlap at most `_MAX_IN_FLIGHT` chunks per download on one shared worker pool.

    fetch(window, cancellation_event) validates the response. Return records in
    original window order even when HTTP requests complete out of order. Failures
    stop submission and cancel queued work; already sent reads may finish.
    """
    if not windows:
        return []
    cancelled = threading.Event()
    error_lock = threading.Lock()
    errors = []
    results = {}
    pending = {}
    remaining = iter(enumerate(windows))

    def invoke(window):
        try:
            _check_cancelled(cancelled)
            return fetch(window, cancelled)
        except Exception as exc:
            with error_lock:
                if not errors:
                    errors.append(exc)
            cancelled.set()
            raise

    def fill():
        while len(pending) < _MAX_IN_FLIGHT and not cancelled.is_set():
            entry = next(remaining, None)
            if entry is None:
                break
            index, window = entry
            pending[_executor.submit(invoke, window)] = index

    try:
        fill()
        while pending:
            completed, _ = wait(pending, return_when=FIRST_COMPLETED)
            if errors:
                raise errors[0]
            for future in completed:
                results[pending.pop(future)] = future.result()
            fill()
        if errors:
            raise errors[0]
        return [record for index in range(len(windows)) for record in results[index]]
    finally:
        cancelled.set()
        running = [future for future in pending if not future.cancel()]
        # Cancelled queued work cannot execute; only drain already running reads.
        wait(running)
