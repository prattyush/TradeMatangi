"""Live volume (Phase 24, Track C, step 2): Breeze ``ttq`` and the shared accumulator.

Packet shapes are from the 2026-11-16 probe (docs/spec-phase24.md): ``ttq`` is a cumulative total that only rises,
``ltq`` is one trade's size and goes up and down, the NIFTY 50 index packet carries no usable volume.
"""
import asyncio
from types import SimpleNamespace

import pytest

from app.services import breeze_service, kite_service
from app.services.breeze_service import BreezeStreamManager
from app.services.ohlc_accumulator import OHLCAccumulator

OPTION = {"symbol": "4.1!45410", "open": 36.4, "last": 22, "high": 48.2, "low": 16.6, "ltq": 65, "ttq": 214741540,
          "totalBuyQt": 6426355, "totalSellQ": 2502240, "ttv": "60235C", "OI": 16397030, "right": "Call", "strike_price": "25500",
          "expiry_date": "17-Nov-2026", "product_type": "Options", "stock_name": "NIFTY 50", "exchange": "NSE Futures & Options"}
STOCK = {"symbol": "4.1!13751", "last": 1234.5, "ltq": 9, "ttq": 300433, "stock_name": "NAUKRI", "exchange": "NSE Equity"}
INDEX = {"symbol": "4.1!NIFTY 50", "last": 25000.0, "ltq": 0, "ttq": 0, "ttv": "", "stock_name": "NIFTY 50", "exchange": "NSE Equity"}


def test_the_adapters_share_one_accumulator_class():
    assert kite_service._OHLCAccumulator is OHLCAccumulator and breeze_service._OHLCAccumulator is OHLCAccumulator


def test_ttq_becomes_per_feed_volume_and_ltq_is_ignored():
    mgr = BreezeStreamManager()
    totals = [300433, 300433, 300500, 301786]
    ltqs = [9, 44, 3, 700]
    volumes = [mgr._tick_volume("NAUKRI_EQ", {**STOCK, "ttq": t, "ltq": q}) for t, q in zip(totals, ltqs)]
    assert volumes == [0, 0, 67, 1286]


def test_ttq_arrives_as_text_sometimes_and_bad_values_are_skipped():
    mgr = BreezeStreamManager()
    assert mgr._tick_volume("k", {"ttq": "1000"}) == 0
    assert mgr._tick_volume("k", {"ttq": "1250"}) == 250
    for bad in (None, "", "n/a", -4, float("nan")):
        assert mgr._tick_volume("k", {"ttq": bad}) is None
    assert mgr._tick_volume("k", {"ttq": 1300}) == 50  # the bad packets did not move the baseline
    assert mgr._tick_volume("k", {}) is None


def test_an_index_and_an_untraded_contract_have_no_volume_not_a_series_of_zeros():
    mgr = BreezeStreamManager()
    assert [mgr._tick_volume("NIFTY 50_EQ", INDEX) for _ in range(5)] == [None] * 5
    assert "NIFTY 50_EQ" not in mgr._volume_guards
    assert mgr._tick_volume("opt", {"ttq": 0}) is None
    assert mgr._tick_volume("opt", {"ttq": 10}) == 0     # first trade of the day is the baseline
    assert mgr._tick_volume("opt", {"ttq": 25}) == 15


def test_a_lower_total_resets_and_feeds_are_independent():
    mgr = BreezeStreamManager()
    mgr._tick_volume("a", {"ttq": 5000}); mgr._tick_volume("b", {"ttq": 90})
    assert mgr._tick_volume("a", {"ttq": 4000}) == 0
    assert mgr._tick_volume("a", {"ttq": 4100}) == 100
    assert mgr._tick_volume("b", {"ttq": 100}) == 10


@pytest.mark.asyncio
async def test_candles_pushed_to_the_queue_carry_the_second_volume(monkeypatch):
    clock = {"now": 1_800_000_000}
    monkeypatch.setattr(breeze_service, "_time", SimpleNamespace(time=lambda: clock["now"]))
    mgr = BreezeStreamManager()
    queue = asyncio.Queue()
    mgr._breeze = True
    mgr._queue = queue
    mgr._loop = asyncio.get_running_loop()
    mgr._instruments = [{"exchange_code": "NSE", "stock_code": "NAUKRI", "product_type": "cash"}]
    for now, price, total in [(0, 1234.5, 300433), (0, 1235.0, 300450), (1, 1234.0, 300500), (2, 1234.5, 300500)]:
        clock["now"] = 1_800_000_000 + now
        mgr._on_ticks([{**STOCK, "last": price, "ttq": total}])
    await asyncio.sleep(0)
    candles = [queue.get_nowait() for _ in range(queue.qsize())]
    assert [c["volume"] for c in candles] == [17, 50]
    assert all(c["type"] == "tick" for c in candles)


@pytest.mark.asyncio
async def test_an_index_candle_has_no_volume_key(monkeypatch):
    clock = {"now": 1_800_000_000}
    monkeypatch.setattr(breeze_service, "_time", SimpleNamespace(time=lambda: clock["now"]))
    mgr = BreezeStreamManager()
    queue = asyncio.Queue()
    mgr._breeze = True
    mgr._queue = queue
    mgr._loop = asyncio.get_running_loop()
    mgr._instruments = [{"exchange_code": "NSE", "stock_code": "NIFTY", "product_type": "cash"}]
    for now in range(3):
        clock["now"] = 1_800_000_000 + now
        mgr._on_ticks([{**INDEX, "last": 25000.0 + now}])
    await asyncio.sleep(0)
    candles = [queue.get_nowait() for _ in range(queue.qsize())]
    assert candles and all("volume" not in c for c in candles)


def test_a_restarted_manager_starts_with_fresh_baselines():
    mgr = BreezeStreamManager()
    mgr._tick_volume("k", {"ttq": 1000}); mgr._tick_volume("k", {"ttq": 1100})
    mgr._volume_guards.clear()  # what start() does
    assert mgr._tick_volume("k", {"ttq": 5000}) == 0
