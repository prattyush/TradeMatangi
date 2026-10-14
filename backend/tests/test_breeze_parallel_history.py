"""Bounded HTTP overlap, chronological assembly, cancellation and pacing."""
from concurrent.futures import CancelledError, ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock
import threading
import time

import pytest
from app.services import breeze_history as history
from app.services.broker_service import BreezeTokenError, _fetch_day_paginated


def test_chunks_complete_out_of_order_but_return_in_window_order():
    def fetch(index, cancelled):
        time.sleep(.005 * (3 - index % 3))
        return [index]
    assert history.fetch_chunks(list(range(12)), fetch) == list(range(12))


def test_one_global_three_worker_limit_across_downloads():
    lock = threading.Lock()
    active = maximum = 0
    def fetch(index, cancelled):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(.015)
        with lock:
            active -= 1
        return [index]
    with ThreadPoolExecutor(max_workers=4) as callers:
        results = list(callers.map(lambda _: history.fetch_chunks(list(range(8)), fetch), range(4)))
    assert maximum == 3
    assert all(value == list(range(8)) for value in results)


def test_auth_failure_stops_submitting_and_preserves_original_error():
    calls = []
    def fetch(index, cancelled):
        calls.append(index)
        if index == 0:
            raise BreezeTokenError("expired")
        time.sleep(.02)
        return [index]
    with pytest.raises(BreezeTokenError, match="expired"):
        history.fetch_chunks(list(range(50)), fetch)
    assert len(calls) <= 3
    # All remaining reads completed/cancelled before fetch_chunks returned.
    before = len(calls)
    time.sleep(.03)
    assert len(calls) == before


def test_waiting_workers_recheck_dispatch_clock_after_delayed_wakeup(monkeypatch):
    clock = [100.]
    clock_lock = threading.Lock()
    starts = []
    def monotonic():
        with clock_lock:
            return clock[0]
    def sleep(delay):
        with clock_lock:
            clock[0] += delay + 2  # oversleep: workers must not use stale reservations
    def request(**kwargs):
        starts.append(monotonic())
        return {"Status": 200, "Success": []}
    monkeypatch.setattr(history, "time", SimpleNamespace(monotonic=monotonic, sleep=sleep))
    monkeypatch.setattr(history, "_MIN_INTERVAL", 1)
    broker = SimpleNamespace(get_historical_data_v2=request)
    for _ in range(5):
        history.request_history(broker)
    assert all(second - first >= 1 for first, second in zip(starts, starts[1:]))


def test_cancelled_batch_does_not_call_sdk():
    cancelled = threading.Event()
    cancelled.set()
    broker = Mock()
    with pytest.raises(CancelledError):
        history.request_history(broker, _cancelled=cancelled)
    broker.get_historical_data_v2.assert_not_called()


@pytest.mark.parametrize("date, expected_calls", [("2026-05-06", 23), ("2026-10-13", 22)])
def test_inclusive_windows_stay_below_1000_cap_and_cover_day(date, expected_calls):
    import pandas as pd
    requests = []
    lock = threading.Lock()
    def response(**kwargs):
        start, end = pd.Timestamp(kwargs['from_date']), pd.Timestamp(kwargs['to_date'])
        with lock:
            requests.append((start, end))
        assert (end - start).total_seconds() + 1 <= 1000
        return {"Status": 200, "Success": [{"datetime": stamp.isoformat()} for stamp in pd.date_range(start, end, freq='s')]}
    rows = _fetch_day_paginated(SimpleNamespace(get_historical_data_v2=response),
        {"breeze_stock_code": "NIFTY", "exchange_code": "NSE", "product_type": "cash"}, date)
    assert len(requests) == expected_calls
    requests.sort()
    assert all(left[1] == right[0] for left, right in zip(requests, requests[1:]))
    stamps = sorted(set(row['datetime'] for row in rows))
    assert stamps[0] == date + 'T09:15:00'
    assert stamps[-1] == date + ('T15:30:00' if date < '2026-08-03' else 'T15:15:00')
    assert len(stamps) == (22501 if date < '2026-08-03' else 21601)


def test_cancel_interrupts_a_waiting_pacing_slot(monkeypatch):
    monkeypatch.setattr(history, "_next_request", time.monotonic() + 60)
    cancelled = threading.Event()
    broker = Mock()
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(history.request_history, broker, _cancelled=cancelled)
        time.sleep(.01)
        cancelled.set()
        with pytest.raises(CancelledError):
            pending.result(timeout=1)
    broker.get_historical_data_v2.assert_not_called()


def test_delayed_concurrent_waiters_cannot_start_together(monkeypatch):
    clock = [100.]
    lock = threading.Lock()
    wake_together = threading.Barrier(2)
    sleeps = [0]
    starts = []
    first_dispatch = threading.Event()
    def now():
        with lock:
            return clock[0]
    def sleep(delay):
        with lock:
            sleeps[0] += 1
            number = sleeps[0]
        if number <= 2:
            wake_together.wait(timeout=2)
            with lock:
                clock[0] = max(clock[0], 105.)  # both delayed beyond reserved slots
        else:
            assert first_dispatch.wait(timeout=2)
            with lock:
                clock[0] += delay
    def request(**kwargs):
        with lock:
            starts.append(clock[0])
            if len(starts) == 2:
                first_dispatch.set()
        return {"Status": 200, "Success": []}
    monkeypatch.setattr(history, "time", SimpleNamespace(monotonic=now, sleep=sleep))
    monkeypatch.setattr(history, "_MIN_INTERVAL", 1)
    broker = SimpleNamespace(get_historical_data_v2=request)
    history.request_history(broker)
    with ThreadPoolExecutor(max_workers=2) as workers:
        jobs = [workers.submit(history.request_history, broker) for _ in range(2)]
        for job in jobs:
            job.result(timeout=3)
    assert starts == [100., 105., 106.]
