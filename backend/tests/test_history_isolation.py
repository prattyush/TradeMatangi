"""Bound traffic and keep website work responsive during desktop downloads."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
import threading

import pytest

from app.services import breeze_history, options_service
from app.services.history_workers import run_history


def test_history_requests_are_paced_across_contracts(monkeypatch):
    clock = [100.0]
    sleeps = []
    def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay
    monkeypatch.setattr(breeze_history, "time", SimpleNamespace(monotonic=lambda: clock[0], sleep=sleep))
    monkeypatch.setattr(breeze_history, "_MIN_INTERVAL", 1.0)
    broker = MagicMock()
    broker.get_historical_data_v2.return_value = {"Status": 200, "Success": []}
    for strike in (70800, 70900, 71000):
        breeze_history.request_history(broker, strike_price=str(strike))
    assert sleeps == [1.0, 1.0]
    assert broker.get_historical_data_v2.call_count == 3


@pytest.mark.parametrize("response", [
    {"Status": 200, "Error": "Rate limit exceeded"}, {"Status": 429},
    RuntimeError("Rate limit exceeded"),
])
def test_rate_limit_stops_chunks_and_blocks_other_history_keys(monkeypatch, response):
    clock = [100.0]
    monkeypatch.setattr(breeze_history, "time", SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda _: None))
    broker = MagicMock()
    if isinstance(response, Exception):
        broker.get_historical_data_v2.side_effect = response
    else:
        broker.get_historical_data_v2.return_value = response
    with pytest.raises(breeze_history.BreezeHistoryRateLimitError):
        options_service._fetch_options_day_paginated(broker, "BSESEN", "2026-09-29", 70800, "2026-10-08", "PE")
    with pytest.raises(breeze_history.BreezeHistoryRateLimitError):
        breeze_history.request_history(broker, stock_code="NIFTY")
    assert broker.get_historical_data_v2.call_count == 1
    clock[0] += 61
    broker.get_historical_data_v2.side_effect = None
    broker.get_historical_data_v2.return_value = {"Status": 200, "Success": []}
    assert breeze_history.request_history(broker)["Status"] == 200
    assert broker.get_historical_data_v2.call_count == 2


def test_empty_option_failure_is_shared_and_retryable_after_cooldown(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(options_service, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    fetch = MagicMock(side_effect=RuntimeError("Breeze returned no options data for contract"))
    monkeypatch.setattr(options_service, "_fetch_options_historical_unlocked", fetch)
    args = ("BSESEN", "2026-09-29", 70800, "2026-10-08", "PE")
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(options_service._fetch_breeze_options_historical, *args) for _ in range(12)]
        for future in futures:
            with pytest.raises(RuntimeError, match="no options data"):
                future.result()
    assert fetch.call_count == 1
    # An explicit desktop refresh must not bypass a recent failure either.
    with pytest.raises(RuntimeError):
        options_service._fetch_breeze_options_historical(*args, force_refresh=True)
    assert fetch.call_count == 1
    clock[0] += 601
    fetch.side_effect = None
    fetch.return_value = Path("contract.parquet")
    assert options_service._fetch_breeze_options_historical(*args) == Path("contract.parquet")
    assert fetch.call_count == 2


@pytest.mark.asyncio
async def test_desktop_workers_do_not_starve_website_pool_and_preserve_context():
    loop = asyncio.get_running_loop()
    loop.set_default_executor(ThreadPoolExecutor(max_workers=1))
    release = threading.Event()
    started = asyncio.Queue()
    context = ContextVar("history-test-context")
    context.set("policy")
    def blocked_download():
        loop.call_soon_threadsafe(started.put_nowait, threading.current_thread().name)
        release.wait(5)
        return context.get()
    tasks = [asyncio.create_task(run_history(blocked_download)) for _ in range(2)]
    try:
        for _ in range(2):
            assert (await asyncio.wait_for(started.get(), 1)).startswith("desktop-history")
        assert await asyncio.wait_for(asyncio.to_thread(lambda: "website funds"), 1) == "website funds"
    finally:
        release.set()
        assert await asyncio.gather(*tasks) == ["policy", "policy"]
