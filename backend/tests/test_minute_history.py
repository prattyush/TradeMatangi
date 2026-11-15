"""Minute-level history for read-only screens (phone Browse): provider order, caching and replay isolation."""
import os
import time
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import minute_history as mh
from app.services import swing_charts, swing_market
from app.services.historical_data_service import HistoricalResult, _require_replay_cadence

PAST = "2026-10-08"      # a Thursday, a trading day
TODAY = "2026-10-12"


def rows(date=PAST, count=5, start="09:15:00", price=100.0):
    index = pd.date_range(f"{date} {start}", periods=count, freq="min")
    return pd.DataFrame({"datetime": index, "open": price, "high": price + 2, "low": price - 1, "close": price + 1, "volume": 10})


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(mh, "OHLCDATA_DIR", tmp_path)
    monkeypatch.setattr(swing_market, "today", lambda: TODAY)
    mh._locks.clear()
    # No second-level cache unless a test provides one.
    monkeypatch.setattr("app.services.historical_data_service._complete_breeze_cache", lambda *a: None)
    return tmp_path


def fetcher(calls, answers):
    def fetch(provider, item, start, end, daily):
        calls.append(provider)
        answer = answers[provider]
        if isinstance(answer, Exception):
            raise answer
        return answer
    return fetch


def test_index_prefers_kite_and_stores_only_under_the_minute_folder(tmp_path):
    calls = []
    with patch.object(swing_charts, "_fetch", fetcher(calls, {"kite": rows(), "breeze": rows()})):
        result = mh.load("NIFTY", PAST)
    assert calls == ["kite"]
    assert result.interval_seconds == 60 and result.actual_provider == "kite"
    assert result.frame.index.tz is not None and str(result.frame.index[0]) == f"{PAST} 09:15:00+00:00"
    assert result.frame["observed"].all()
    written = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert written and all(p.relative_to(tmp_path).parts[0] == "minute" for p in written)


def test_kite_failure_falls_back_to_breeze_minutes():
    calls = []
    with patch.object(swing_charts, "_fetch", fetcher(calls, {"kite": ValueError("Instrument token not found"), "breeze": rows()})):
        result = mh.load("NIFTY", PAST)
    assert calls == ["kite", "breeze"] and result.actual_provider == "breeze"


def test_expired_option_goes_straight_to_breeze_because_kite_has_no_expired_contracts():
    calls = []
    with patch.object(swing_charts, "_fetch", fetcher(calls, {"breeze": rows()})):
        result = mh.load("NIFTY", PAST, 24500, "2026-10-08", "CE")
    assert calls == ["breeze"] and result.actual_provider == "breeze"


def test_live_option_tries_kite_first():
    calls = []
    with patch.object(swing_charts, "_fetch", fetcher(calls, {"kite": rows(TODAY), "breeze": rows(TODAY)})):
        mh.load("NIFTY", TODAY, 24500, "2026-10-13", "PE")
    assert calls == ["kite"]


def test_a_finished_day_is_fetched_once(tmp_path):
    calls = []
    answers = {"kite": rows()}
    with patch.object(swing_charts, "_fetch", fetcher(calls, answers)):
        mh.load("NIFTY", PAST)
        # Mark the file as written after that day's close, as a real run would be.
        for path in (tmp_path / "minute").rglob("*.parquet"):
            later = pd.Timestamp("2026-10-09", tz="Asia/Kolkata").timestamp()
            os.utime(path, (later, later))
        mh.load("NIFTY", PAST)
    assert calls == ["kite"]


def test_a_past_day_saved_during_the_session_is_fetched_again(tmp_path):
    calls = []
    with patch.object(swing_charts, "_fetch", fetcher(calls, {"kite": rows()})):
        mh.load("NIFTY", PAST)
        for path in (tmp_path / "minute").rglob("*.parquet"):
            earlier = pd.Timestamp(f"{PAST} 11:00", tz="Asia/Kolkata").timestamp()
            os.utime(path, (earlier, earlier))
        mh.load("NIFTY", PAST)
    assert calls == ["kite", "kite"]


def test_today_is_cached_for_a_minute_only(tmp_path, monkeypatch):
    calls = []
    # The synthetic "today" is in the past on the clock, so say explicitly that its session has not closed yet.
    monkeypatch.setattr(mh, "complete_day_cache", lambda path, date: False)
    with patch.object(swing_charts, "_fetch", fetcher(calls, {"kite": rows(TODAY)})):
        mh.load("NIFTY", TODAY)
        mh.load("NIFTY", TODAY)
        for path in (tmp_path / "minute").rglob("*.parquet"):
            old = time.time() - 120
            os.utime(path, (old, old))
        mh.load("NIFTY", TODAY)
    assert calls == ["kite", "kite"]


def test_a_complete_second_level_cache_is_reused_without_any_download(monkeypatch):
    index = pd.date_range(f"{PAST} 09:15:00", periods=180, freq="s", tz="UTC")
    seconds = pd.DataFrame({"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5, "volume": 1.0, "observed": True}, index=index)
    cached = HistoricalResult(seconds, Path("x.parquet"), "minute", "breeze", 1)
    monkeypatch.setattr("app.services.historical_data_service._complete_breeze_cache", lambda *a: cached)
    calls = []
    with patch.object(swing_charts, "_fetch", fetcher(calls, {})):
        result = mh.load("NIFTY", PAST)
    assert calls == [] and len(result.frame) == 3 and result.interval_seconds == 60
    assert result.frame.volume.iloc[0] == 60.0


def test_nothing_found_is_not_found_but_a_failing_last_source_is_a_failure():
    with patch.object(swing_charts, "_fetch", fetcher([], {"kite": pd.DataFrame(), "breeze": pd.DataFrame()})):
        with pytest.raises(FileNotFoundError):
            mh.load("NIFTY", PAST)
    with patch.object(swing_charts, "_fetch", fetcher([], {"kite": pd.DataFrame(), "breeze": TimeoutError("slow")})):
        with pytest.raises(RuntimeError, match="provider failed"):
            mh.load("NIFTY", PAST)


def test_a_breeze_token_error_is_reported_as_such():
    from app.services.broker_service import BreezeTokenError

    with patch.object(swing_charts, "_fetch", fetcher([], {"kite": ValueError("x"), "breeze": BreezeTokenError("expired")})):
        with pytest.raises(BreezeTokenError):
            mh.load("NIFTY", PAST)


def test_minute_frames_can_never_feed_replay():
    with patch.object(swing_charts, "_fetch", fetcher([], {"kite": rows()})):
        result = mh.load("NIFTY", PAST)
    with pytest.raises(RuntimeError, match="second-level"):
        _require_replay_cadence(result.frame, "replay")


@pytest.mark.asyncio
class TestRoutes:
    async def get(self, path):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.get(path)

    async def test_historical_minute_returns_candles_without_touching_second_level_loaders(self):
        with patch.object(swing_charts, "_fetch", fetcher([], {"kite": rows(count=10), "breeze": rows(count=10)})), \
             patch("app.routers.data.fetch_historical", side_effect=AssertionError("second-level fetch")):
            response = await self.get(f"/api/data/historical?symbol=NIFTY&trading_date={TODAY}&interval_minutes=5&historical_days=1&granularity=minute")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["dates"] == [PAST] or body["dates"]  # the previous trading day
        assert len(body["candles"]) == 2 and body["candles"][0]["volume"] == 50

    async def test_pre_session_minute_stops_before_the_start_time(self):
        with patch.object(swing_charts, "_fetch", fetcher([], {"kite": rows(PAST, count=30)})), \
             patch("app.routers.data.fetch_historical", side_effect=AssertionError("second-level fetch")):
            response = await self.get(f"/api/data/pre-session?symbol=NIFTY&trading_date={PAST}&start_time=09:30:00&interval_minutes=3&granularity=minute")
        assert response.status_code == 200, response.text
        candles = response.json()["candles"]
        assert len(candles) == 5  # 09:15 .. 09:29 in 3-minute candles
        assert max(c["time"] for c in candles) < int(pd.Timestamp(f"{PAST} 09:30:00", tz="UTC").timestamp())

    async def test_options_minute_clamps_to_expiry_and_uses_breeze_for_expired_contracts(self):
        calls = []
        with patch.object(swing_charts, "_fetch", fetcher(calls, {"breeze": rows(count=10)})), \
             patch("app.services.options_service.fetch_options_historical", side_effect=AssertionError("second-level fetch")):
            response = await self.get(
                f"/api/data/options-historical?symbol=NIFTY&date={PAST}&strike=24500&expiry={PAST}&right=CE"
                "&interval_minutes=5&historical_days=1&granularity=minute")
        assert response.status_code == 200, response.text
        assert set(calls) == {"breeze"} and response.json()["candles"]

    async def test_a_breeze_session_problem_is_a_503(self):
        from app.services.broker_service import BreezeTokenError

        with patch.object(swing_charts, "_fetch", fetcher([], {"breeze": BreezeTokenError("expired")})):
            response = await self.get(
                f"/api/data/options-historical?symbol=NIFTY&date={PAST}&strike=24500&expiry={PAST}&right=CE"
                "&interval_minutes=5&historical_days=1&granularity=minute")
        assert response.status_code == 503

    async def test_default_requests_still_use_the_second_level_path(self):
        with patch("app.routers.data.fetch_historical", side_effect=RuntimeError("second-level used")):
            response = await self.get(f"/api/data/historical?symbol=NIFTY&trading_date={PAST}&historical_days=1")
        assert response.status_code == 404  # skipped day: the second-level loader was called

    async def test_granularity_other_than_minute_is_rejected(self):
        response = await self.get(f"/api/data/historical?symbol=NIFTY&trading_date={PAST}&granularity=second")
        assert response.status_code == 422


def test_browse_max_price_scans_with_minute_candles_and_never_asks_for_second_level_history():
    from app.services import desktop_preparation as prep

    date = "2026-10-08"
    pane = dict(id="ce", kind="option", symbol="BSESEN", interval="3", tradingDate=date, expiry=date,
                strike="71700", right="CE", selection_mode="max_price", max_price=105)
    calls = []

    def fetch(provider, item, start, end, daily):
        calls.append((provider, item["kind"], item.get("strike")))
        price = 71700.0 if item["kind"] == "index" else 120.0 if item.get("strike") == 71700 else 100.0
        return rows(date, 40, price=price)

    with patch.object(swing_charts, "_fetch", fetch), patch.object(prep, "load_history", side_effect=AssertionError("second-level")):
        result = prep.prepare("browse", date, "09:30:00", [pane])
    chosen = result["panes"][0]
    assert chosen["availability"] == "available", chosen
    assert chosen["pane"]["strike"] == "71800" and chosen["premium"] == 101.0   # ATM at 120 is above the cap, the next strike is not
    assert all(kind in ("index", "option") for _, kind, _ in calls)


@pytest.mark.asyncio
class TestDesktopBrowsePages:
    """The Windows app's Browse pages (Bearer routes) use the same minute data."""

    async def get(self, path):
        from app.dependencies import get_desktop_user_id

        app.dependency_overrides[get_desktop_user_id] = lambda: "user-1"
        try:
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                return await client.get(path)
        finally:
            app.dependency_overrides.pop(get_desktop_user_id, None)

    async def test_historical_page_minute_makes_no_second_level_request(self):
        with patch.object(swing_charts, "_fetch", fetcher([], {"kite": rows(count=10)})), \
             patch("app.routers.data.fetch_historical", side_effect=AssertionError("second-level fetch")):
            response = await self.get(f"/api/desktop/v1/historical/pages?symbol=NIFTY&trading_date={PAST}&interval_minutes=5&context_days=0&granularity=minute")
        assert response.status_code == 200, response.text
        assert len(response.json()["candles"]) == 2

    async def test_option_page_minute_uses_breeze_for_an_expired_contract(self):
        calls = []
        with patch.object(swing_charts, "_fetch", fetcher(calls, {"breeze": rows(count=10)})), \
             patch("app.services.options_service.fetch_options_historical", side_effect=AssertionError("second-level fetch")):
            response = await self.get(
                f"/api/desktop/v1/options/historical/pages?symbol=NIFTY&trading_date={PAST}&expiry={PAST}&strike=24500&right=CE"
                "&interval_minutes=5&context_days=0&granularity=minute")
        assert response.status_code == 200, response.text
        assert response.json()["available"] is True and set(calls) == {"breeze"}

    async def test_older_pages_minute_scrolls_back_without_second_level_data(self):
        with patch.object(swing_charts, "_fetch", fetcher([], {"kite": rows(count=10)})), \
             patch("app.routers.data.fetch_historical", side_effect=AssertionError("second-level fetch")):
            response = await self.get(f"/api/desktop/v1/historical/underlying-pages?symbol=NIFTY&trading_date=2026-10-09&interval_minutes=5&granularity=minute")
        assert response.status_code == 200, response.text
        assert response.json()["candles"]

    async def test_default_pages_are_unchanged(self):
        with patch("app.routers.data.fetch_historical", side_effect=RuntimeError("second-level used")):
            response = await self.get(f"/api/desktop/v1/historical/pages?symbol=NIFTY&trading_date={PAST}&context_days=0")
        assert response.status_code == 404
