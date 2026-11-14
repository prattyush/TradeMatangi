"""Browse history: paged candles for an index or equity, up to a year back, from minute and daily files."""
import os
import threading
import time
from datetime import date

import pandas as pd
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import browse_history as bh
from app.services import minute_history as mh
from app.services import swing_charts, swing_market
from app.services.kite_service import KiteTokenError
from app.utils import is_trading_day

TODAY = "2026-10-12"   # a Monday
ANCHOR = date(2026, 10, 9)  # the Friday before


def rows(start, end, daily, minutes=6):
    stamps = []
    day = pd.Timestamp(start).normalize()
    while day <= pd.Timestamp(end):
        if is_trading_day(day.date()):
            stamps += [day] if daily else list(pd.date_range(day + pd.Timedelta(hours=9, minutes=15), periods=minutes, freq="min"))
        day += pd.Timedelta(days=1)
    return pd.DataFrame({"datetime": stamps, "open": 100.0, "high": 102.0, "low": 99.0, "close": 101.0, "volume": 10})


class Fetcher:
    def __init__(self, failures=None, delay=0.0):
        self.calls = []
        self.failures = failures or {}
        self.delay = delay

    def __call__(self, provider, item, start, end, daily):
        self.calls.append((provider, pd.Timestamp(start).date().isoformat(), pd.Timestamp(end).date().isoformat(), daily))
        if self.delay:
            time.sleep(self.delay)
        failure = self.failures.get(provider)
        if failure:
            raise failure
        return rows(start, end, daily)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(mh, "OHLCDATA_DIR", tmp_path)
    monkeypatch.setattr(swing_market, "today", lambda: TODAY)
    monkeypatch.setattr("app.services.historical_data_service._complete_breeze_cache", lambda *a: None)
    bh._locks.clear()
    bh._cooldown.clear()
    return tmp_path


@pytest.fixture
def fetch(monkeypatch):
    fetcher = Fetcher()
    monkeypatch.setattr(swing_charts, "_fetch", fetcher)
    return fetcher


def test_first_page_is_the_last_few_days_and_a_repeat_costs_nothing(fetch):
    first = bh.page("NIFTY", 3, ANCHOR)
    assert [c["time"] for c in first["candles"]] == sorted(c["time"] for c in first["candles"])
    assert first["oldest_date"] == "2026-10-07"           # the anchor day and the two trading days before it
    assert first["more"] is True and first["before"] == first["candles"][0]["time"]
    assert len(fetch.calls) == 1 and fetch.calls[0][0] == "kite"
    again = bh.page("NIFTY", 3, ANCHOR)
    assert again["candles"] == first["candles"] and len(fetch.calls) == 1


def test_scrolling_back_gives_older_days_without_overlap_and_ends_at_the_horizon(fetch):
    page = bh.page("NIFTY", 1, ANCHOR)
    seen = {c["time"] for c in page["candles"]}
    pages = 1
    while page["more"] and pages < 30:
        older = bh.page("NIFTY", 1, ANCHOR, before=page["before"])
        assert older["candles"], "a page with more=True must have candles"
        assert max(c["time"] for c in older["candles"]) < page["before"]
        assert not seen & {c["time"] for c in older["candles"]}
        seen |= {c["time"] for c in older["candles"]}
        page, pages = older, pages + 1
    assert page["more"] is False
    assert date.fromisoformat(page["oldest_date"]) >= date.fromisoformat("2026-10-09") - pd.Timedelta(days=bh.HORIZON_DAYS[1]).to_pytimedelta()
    # 1-minute: about 62 trading days in 90 calendar days, 5 per page.
    assert 12 <= pages <= 14


def test_a_sixty_day_window_is_one_provider_call(fetch):
    page = bh.page("NIFTY", 5, ANCHOR, days=40)
    assert len(fetch.calls) == 1
    provider, first, last, daily = fetch.calls[0]
    assert (provider, daily) == ("kite", False) and last == "2026-10-09"
    assert (date.fromisoformat(last) - date.fromisoformat(first)).days < 60
    assert len({c["time"] // 86400 for c in page["candles"]}) == 40


def test_holidays_and_weekends_are_skipped(fetch):
    page = bh.page("NIFTY", 3, date(2026, 10, 5), days=3)    # Mon 5 Oct, then 1 Oct and 30 Sep (2 Oct is a holiday)
    assert page["oldest_date"] == "2026-09-30"


def test_a_page_cut_at_the_open_starts_on_the_day_before(fetch):
    first = bh.page("NIFTY", 3, ANCHOR, days=2)
    calls = len(fetch.calls)
    older = bh.page("NIFTY", 3, ANCHOR, before=first["before"], days=1)
    day = lambda candle: pd.Timestamp(candle["time"], unit="s").date()
    assert day(older["candles"][-1]) < day(first["candles"][0])
    assert len(fetch.calls) == calls + 1                       # only the new day was fetched


def test_buckets_sit_on_clock_boundaries_like_the_other_browse_routes(fetch):
    page = bh.page("NIFTY", 15, ANCHOR, days=1)
    opening = int(pd.Timestamp("2026-10-09 09:15:00", tz="UTC").timestamp())
    assert page["candles"][0]["time"] == opening                  # 09:15 is a 15-minute boundary
    hour = bh.page("NIFTY", 60, ANCHOR, days=1)
    assert hour["candles"][0]["time"] == int(pd.Timestamp("2026-10-09 09:00:00", tz="UTC").timestamp())
    half = bh.page("NIFTY", 30, ANCHOR, days=1)
    assert half["candles"][0]["time"] == int(pd.Timestamp("2026-10-09 09:00:00", tz="UTC").timestamp())


def test_kite_failure_falls_back_to_breeze_in_two_day_windows(monkeypatch):
    fetcher = Fetcher(failures={"kite": ValueError("Instrument token not found")})
    monkeypatch.setattr(swing_charts, "_fetch", fetcher)
    page = bh.page("NIFTY", 5, ANCHOR, days=4)
    assert page["candles"]
    providers = [call[0] for call in fetcher.calls]
    assert providers[0] == "kite" and set(providers[1:]) == {"breeze"} and len(providers) == 3   # 1 kite, then 2 breeze windows
    for _, first, last, _ in fetcher.calls[1:]:
        assert (date.fromisoformat(last) - date.fromisoformat(first)).days < 2


def test_kotak_is_never_asked_for_an_index_but_is_the_last_resort_for_a_share(monkeypatch):
    fetcher = Fetcher(failures={"kite": ValueError("x"), "breeze": ValueError("y")})
    monkeypatch.setattr(swing_charts, "_fetch", fetcher)
    with pytest.raises(bh.BrowseUnavailable):
        bh.page("NIFTY", 5, ANCHOR, days=1)
    assert "kotak" not in {call[0] for call in fetcher.calls}
    share = Fetcher(failures={"kite": ValueError("x"), "breeze": ValueError("y")})
    monkeypatch.setattr(swing_charts, "_fetch", share)
    bh._locks.clear()
    page = bh.page("HDFCBANK", 5, ANCHOR, days=1)           # Kite and Breeze fail, Kotak answers
    assert page["candles"] and [call[0] for call in share.calls] == ["kite", "breeze", "kotak"]


def test_a_token_error_is_reported_in_words_and_the_provider_rests_for_a_minute(monkeypatch):
    fetcher = Fetcher(failures={"kite": KiteTokenError("expired"), "breeze": KiteTokenError("expired")})
    monkeypatch.setattr(swing_charts, "_fetch", fetcher)
    with pytest.raises(bh.BrowseUnavailable, match="session has expired"):
        bh.page("NIFTY", 5, ANCHOR, days=1)
    calls = len(fetcher.calls)
    with pytest.raises(bh.BrowseUnavailable, match="session has expired"):
        bh.page("NIFTY", 5, ANCHOR, days=1)
    assert len(fetcher.calls) == calls                           # no provider was asked again while it rests


def test_two_requests_for_the_same_days_make_one_provider_call(monkeypatch):
    fetcher = Fetcher(delay=0.3)
    monkeypatch.setattr(swing_charts, "_fetch", fetcher)
    results = []
    threads = [threading.Thread(target=lambda: results.append(bh.page("NIFTY", 5, ANCHOR, days=5))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(fetcher.calls) == 1 and results[0]["candles"] == results[1]["candles"]


def test_today_is_cached_for_a_minute_and_marked_partial(fetch, tmp_path, monkeypatch):
    monkeypatch.setattr(mh, "complete_day_cache", lambda path, day: False)   # the synthetic "today" is in the past on the clock
    monkeypatch.setattr(swing_market, "window", lambda now: True)
    today = date.fromisoformat(TODAY)
    first = bh.page("NIFTY", 3, today, days=1)
    assert first["partial"] is True
    bh.page("NIFTY", 3, today, days=1)
    assert len(fetch.calls) == 1
    for path in (tmp_path / "minute").rglob("*.parquet"):
        old = time.time() - 120
        os.utime(path, (old, old))
    bh.page("NIFTY", 3, today, days=1)
    assert len(fetch.calls) == 2


def test_daily_is_one_call_and_the_next_page_is_cached(fetch):
    page = bh.page("NIFTY", 1440, ANCHOR)
    assert page["interval"] == 1440 and len(page["candles"]) > 150   # about a year of daily bars
    assert [call[3] for call in fetch.calls] == [True] and len(fetch.calls) == 1
    midnight = int(pd.Timestamp("2026-10-09").tz_localize("UTC").timestamp())
    assert page["candles"][-1]["time"] == midnight
    bh.page("NIFTY", 1440, ANCHOR)
    assert len(fetch.calls) == 1


def test_files_are_shared_with_minute_history_and_never_second_level(fetch, tmp_path):
    bh.page("NIFTY", 3, ANCHOR, days=1)
    calls = len(fetch.calls)
    result = mh.load("NIFTY", ANCHOR.isoformat())
    assert result.interval_seconds == 60 and len(fetch.calls) == calls
    written = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert written and all(p.relative_to(tmp_path).parts[0] == "minute" for p in written)
    assert not list(tmp_path.rglob("*.tmp"))


def test_unsupported_input_is_a_value_error(fetch):
    with pytest.raises(ValueError):
        bh.page("NIFTY", 7, ANCHOR)
    with pytest.raises(ValueError):
        bh.page("NIFTY", 3, date(2026, 10, 13))


@pytest.mark.asyncio
class TestRoute:
    async def get(self, path, headers=None):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            return await client.get(path, headers=headers)

    async def test_website_and_app_routes_answer_with_the_page_contract(self, fetch):
        for prefix in ("/api/browse", "/api/desktop/v1/browse"):
            response = await self.get(f"{prefix}/history?symbol=NIFTY&interval=3&date=2026-10-09", {"X-User-Id": "u"})
            assert response.status_code == 200, response.text
            body = response.json()
            assert set(body) >= {"candles", "more", "before", "oldest_date", "interval", "provider", "partial", "stale"}
            assert {"time", "timestamp", "open", "high", "low", "close", "volume"} <= set(body["candles"][0])

    async def test_needs_credentials(self, fetch):
        assert (await self.get("/api/browse/history?symbol=NIFTY")).status_code == 401

    async def test_bad_input_is_422(self, fetch):
        headers = {"X-User-Id": "u"}
        assert (await self.get("/api/browse/history?symbol=NIFTY&interval=7", headers)).status_code == 422
        assert (await self.get("/api/browse/history?symbol=NIFTY&date=2099-01-01", headers)).status_code == 422
        assert (await self.get("/api/browse/history?symbol=NIFTY&date=nonsense", headers)).status_code == 422
        assert (await self.get("/api/browse/history?symbol=NOPE", headers)).status_code == 422

    async def test_a_token_problem_is_a_503_with_the_reason(self, monkeypatch):
        monkeypatch.setattr(swing_charts, "_fetch", Fetcher(failures={"kite": KiteTokenError("x"), "breeze": KiteTokenError("x")}))
        response = await self.get("/api/browse/history?symbol=NIFTY&date=2026-10-09&days=1", {"X-User-Id": "u"})
        assert response.status_code == 503 and "session has expired" in response.json()["detail"]


def test_max_price_search_accepts_the_websites_header_for_browse_only(monkeypatch):
    from fastapi.testclient import TestClient

    from app.services import desktop_preparation

    monkeypatch.setattr(desktop_preparation, "prepare", lambda mode, date, ref, panes: {"version": 1, "date": date, "reference_time": ref, "panes": []})
    pane = dict(id="ce", kind="option", symbol="NIFTY", interval="3", tradingDate="2026-10-08", expiry="2026-10-08", strike="24500", right="CE")
    client = TestClient(app)
    path = "/api/desktop/v1/trading/prepare-session"
    browse = client.post(path, headers={"X-User-Id": "u"}, json={"mode": "browse", "date": "2026-10-08", "panes": [pane]})
    assert browse.status_code == 200, browse.text
    for mode in ("replay", "stepwise", "paper", "real"):
        refused = client.post(path, headers={"X-User-Id": "u"}, json={"mode": mode, "date": "2026-10-08", "panes": [pane]})
        assert refused.status_code == 401, mode
    assert client.post(path, json={"mode": "browse", "date": "2026-10-08", "panes": [pane]}).status_code == 401


def test_a_window_the_provider_refuses_is_halved_until_it_is_accepted(monkeypatch):
    calls = []

    def fetch(provider, item, start, end, daily):
        span = (pd.Timestamp(end).normalize() - pd.Timestamp(start).normalize()).days
        calls.append((provider, span))
        if provider == "kite" and span > 20:
            raise ValueError("interval exceeds max limit")
        return rows(start, end, daily)

    monkeypatch.setattr(swing_charts, "_fetch", fetch)
    page = bh.page("NIFTY", 5, ANCHOR, days=40)
    assert len({c["time"] // 86400 for c in page["candles"]}) == 40
    assert {provider for provider, _ in calls} == {"kite"}          # never fell through to a slower source
    assert calls[0][1] > 20 and all(span <= 31 for _, span in calls[1:])
