"""Live volume (Phase 24, Track C, step 1): the shared cumulative-volume guard and the Kite adapter.

Field names and behaviour come from the 2026-11-16 probe of the real Kite and Breeze feeds
(docs/spec-phase24.md, "Track A, probe findings"): ``volume_traded`` is a cumulative day total that only rises, the
index packets have none, LTP mode has none, and ``last_traded_quantity`` goes up and down.
"""
import asyncio
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app import config
from app.services import kite_service
from app.services.kite_service import KiteBroadcaster, _OHLCAccumulator
from app.services.volume_delta import VolumeDelta, clean_total

BASE = datetime(2026, 11, 16, 4, 0, 0, tzinfo=timezone.utc)  # 09:30 IST; the stream adds 19800 s (IST-as-UTC)


def at(seconds):
    return BASE + timedelta(seconds=seconds)


# ------------------------------------------------------------------ the guard
def test_first_total_is_only_a_baseline_then_differences():
    guard = VolumeDelta()
    assert guard.delta(236_498_275) == 0
    assert guard.delta(236_498_275) == 0  # nothing traded
    assert guard.delta(236_655_640) == 157_365
    assert guard.baseline == 236_655_640


def test_a_lower_total_is_a_reset_not_a_negative_volume():
    guard = VolumeDelta()
    guard.delta(1000); guard.delta(1500)
    assert guard.delta(200) == 0 and guard.baseline == 200
    assert guard.delta(260) == 60


@pytest.mark.parametrize("bad", [None, "", "abc", float("nan"), float("inf"), -5, True, False, [], {}])
def test_unusable_values_are_ignored_and_keep_the_baseline(bad):
    guard = VolumeDelta()
    guard.delta(1000)
    assert guard.delta(bad) is None and guard.baseline == 1000
    assert guard.delta(1040) == 40  # one bad packet does not turn the next good one into a jump


def test_numbers_as_strings_and_floats_are_accepted_and_reset_forgets():
    guard = VolumeDelta()
    assert guard.delta("500") == 0 and guard.delta(530.0) == 30
    guard.reset()
    assert guard.baseline is None and guard.delta(900) == 0
    assert clean_total(12.9) == 12 and clean_total(0) == 0 and clean_total(None) is None


# ------------------------------------------------------------------ the accumulator
def test_accumulator_sums_volume_inside_a_second_and_reports_it_once_complete():
    acc = _OHLCAccumulator()
    assert acc.update(100.0, 1000, 0) is None          # baseline tick
    assert acc.update(101.0, 1000, 25) is None
    assert acc.update(99.5, 1000, 15) is None
    first = acc.update(100.5, 1001, 7)
    assert first == {"type": "tick", "time": 1000, "open": 100.0, "high": 101.0, "low": 99.5, "close": 99.5, "volume": 40}
    second = acc.update(100.0, 1002, 3)
    assert second["time"] == 1001 and second["volume"] == 7


def test_a_feed_without_volume_never_gets_a_volume_key():
    acc = _OHLCAccumulator()
    acc.update(100.0, 1000)
    candle = acc.update(101.0, 1001)
    assert candle == {"type": "tick", "time": 1000, "open": 100.0, "high": 100.0, "low": 100.0, "close": 100.0}
    assert "volume" not in acc.candle()


def test_zero_volume_seconds_are_zero_not_missing_and_unusable_updates_do_not_hide_volume():
    acc = _OHLCAccumulator()
    acc.update(100.0, 1000, 0)
    assert acc.update(100.0, 1001, 5)["volume"] == 0
    acc.update(100.0, 1001, None)  # a packet whose volume was unusable: price still counts, volume unchanged
    assert acc.update(100.0, 1002, 0)["volume"] == 5


# ------------------------------------------------------------------ the Kite adapter
def make_broadcaster():
    bc = KiteBroadcaster()
    published = []
    bc._publish_candle = lambda token, candle, sessions: published.append((token, candle))
    bc._queue_quotes = lambda *args, **kwargs: None
    loop = asyncio.new_event_loop()
    with patch.object(bc, "_start"), patch.object(bc, "_subscribe_more"):
        bc._connected = True
        bc.register("s1", [11624962, 256265], ["CE", None], asyncio.Queue(), loop)
    return bc, published, loop


def option_tick(seconds, price, total, **extra):
    return {"instrument_token": 11624962, "last_price": price, "volume_traded": total, "last_traded_quantity": 65,
            "exchange_timestamp": at(seconds), **extra}


def test_cumulative_volume_becomes_per_second_volume_on_published_candles():
    bc, published, loop = make_broadcaster()
    bc._on_ticks(None, [option_tick(0, 17.3, 236_498_275)])          # baseline
    bc._on_ticks(None, [option_tick(0, 17.4, 236_498_340)])          # +65 in the same second
    bc._on_ticks(None, [option_tick(1, 17.35, 236_498_470)])         # +130, next second: closes second 0
    bc._on_ticks(None, [option_tick(3, 17.3, 236_498_470)])          # nothing traded: closes second 1
    assert [(c["time"], c["volume"]) for _, c in published] == [(int(at(0).timestamp()) + 19800, 65), (int(at(1).timestamp()) + 19800, 130)]
    loop.close()


def test_an_index_never_gets_a_volume_key_not_even_zero():
    bc, published, loop = make_broadcaster()
    for second, price in enumerate([25000.0, 25001.5, 25002.0]):
        bc._on_ticks(None, [{"instrument_token": 256265, "last_price": price, "exchange_timestamp": at(second)}])
    assert published and all("volume" not in candle for _, candle in published)
    loop.close()


def test_last_traded_quantity_is_never_summed_into_volume():
    bc, published, loop = make_broadcaster()
    # Per-trade quantities jump around while the cumulative total grows by 10 a second.
    for second, (ltq, total) in enumerate([(975, 1000), (65, 1010), (455, 1020), (1, 1030)]):
        bc._on_ticks(None, [option_tick(second, 17.0, total, last_traded_quantity=ltq)])
    assert [c["volume"] for _, c in published] == [0, 10, 10]
    loop.close()


def test_a_total_that_goes_backwards_resets_the_baseline_without_negative_volume():
    bc, published, loop = make_broadcaster()
    for second, total in enumerate([5000, 5200, 100, 130, 130]):
        bc._on_ticks(None, [option_tick(second, 17.0, total)])
    volumes = [c["volume"] for _, c in published]
    assert volumes == [0, 200, 0, 30] and min(volumes) >= 0
    loop.close()


def test_a_late_or_ignored_tick_does_not_lose_its_volume():
    bc, published, loop = make_broadcaster()
    bc._on_ticks(None, [option_tick(5, 17.0, 1000)])
    bc._on_ticks(None, [option_tick(6, 17.1, 1050)])           # closes second 5 (volume 0: baseline); second 6 has +50
    bc._on_ticks(None, [option_tick(5, 17.2, 1080)])           # late: second 5 is already published, the tick is dropped before the guard sees it
    bc._on_ticks(None, [option_tick(7, 17.3, 1100)])           # closes second 6 (50); second 7 carries +50, the 30 that was dropped included
    bc._on_ticks(None, [option_tick(8, 17.3, 1100)])
    assert [c["volume"] for _, c in published] == [0, 50, 50]
    loop.close()


def test_reconnect_makes_the_next_total_a_baseline_again():
    bc, published, loop = make_broadcaster()
    bc._on_ticks(None, [option_tick(0, 17.0, 1000)])
    bc._on_ticks(None, [option_tick(1, 17.0, 1040)])
    ws = MagicMock(); bc._ticker = ws
    bc._on_connect(ws, None)                                  # new connection: guards cleared
    bc._on_ticks(None, [option_tick(2, 17.0, 9000)])          # the gap's volume is not guessed
    bc._on_ticks(None, [option_tick(3, 17.0, 9025)])
    assert [c["volume"] for _, c in published] == [0, 40, 0]
    loop.close()


def test_unregistering_the_last_session_drops_the_guard():
    bc, published, loop = make_broadcaster()
    bc._on_ticks(None, [option_tick(0, 17.0, 1000)])
    assert 11624962 in bc._volume_guards
    bc._ticker = MagicMock()
    bc.unregister("s1")
    assert 11624962 not in bc._volume_guards
    loop.close()


def test_flush_publishes_the_volume_of_a_finished_second():
    bc, published, loop = make_broadcaster()
    bc._on_ticks(None, [option_tick(0, 17.0, 1000)])
    bc._on_ticks(None, [option_tick(0, 17.1, 1090)])
    bc.flush_completed(int(at(5).timestamp()) + 19800)
    assert published[-1][1]["volume"] == 90
    loop.close()


# ------------------------------------------------------------------ stream mode
def test_quote_mode_is_the_default_and_ltp_stays_available_as_a_switch(monkeypatch):
    ticker = MagicMock(MODE_LTP="ltp", MODE_QUOTE="quote", MODE_FULL="full")
    assert config.KITE_STREAM_MODE == "quote" and kite_service._stream_mode(ticker) == "quote"
    monkeypatch.setattr(kite_service, "KITE_STREAM_MODE", "ltp")
    assert kite_service._stream_mode(ticker) == "ltp"


def test_both_subscription_sites_use_the_chosen_mode():
    source = Path(kite_service.__file__).read_text()
    assert "set_mode(ticker.MODE_LTP" not in source and "set_mode(ws.MODE_LTP" not in source
    assert len(re.findall(r"set_mode\(_stream_mode\(", source)) == 2


def test_volume_reaches_session_consumers_through_the_hub_unchanged():
    from app.services.market_data import MarketDataHub  # noqa: F401  (import guard: the hub passes the whole tick dict on)
    hub_source = (Path(kite_service.__file__).parent / "market_data.py").read_text()
    assert 'payload = {**tick, "provider"' in hub_source
