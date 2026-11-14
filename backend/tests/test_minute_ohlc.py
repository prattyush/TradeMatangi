"""Patterns, Chart Structures and Fine Structures read minute data, never Breeze second-level downloads.

``minute_history.load`` is replaced everywhere, so no test can reach a broker. The second-level loaders are replaced by
functions that fail the test if they are called.
"""
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services import minute_ohlc
from app.services.broker_service import BreezeTokenError
from app.services.historical_data_service import HistoricalResult

DATE = "2026-05-06"  # a Wednesday; the two trading days before it are 05-04 and 05-05


def minute_frame(date, minutes=30, price=100.0, volume=250):
    index = pd.date_range(pd.Timestamp(f"{date} 09:15:00", tz="UTC"), periods=minutes, freq="1min")
    return pd.DataFrame({
        "open": [price + i for i in range(minutes)],
        "high": [price + i + 2 for i in range(minutes)],
        "low": [price + i - 2 for i in range(minutes)],
        "close": [price + i + 1 for i in range(minutes)],
        "volume": [float(volume)] * minutes,
        "observed": [True] * minutes,
    }, index=index)


class FakeMinuteHistory:
    """Stands in for ``minute_history.load``; records every request."""

    def __init__(self, missing=(), error=None):
        self.calls = []
        self.missing = set(missing)
        self.error = error

    def __call__(self, symbol, date, strike=None, expiry=None, right=None):
        self.calls.append((symbol, date, strike, expiry, right))
        if date in self.missing:
            raise FileNotFoundError(f"No minute data for {symbol} on {date}")
        if self.error is not None and date == DATE:
            raise self.error
        return HistoricalResult(minute_frame(date), Path("unused.parquet"), "minute", "kite", 60)


def no_second_level(*args, **kwargs):
    raise AssertionError("a second-level download or load was attempted")


def patched(fake_history):
    """Minute data faked, second-level paths forbidden, structure/flow lookups empty (no DynamoDB)."""
    stack = ExitStack()
    stack.enter_context(patch("app.services.minute_history.load", fake_history))
    stack.enter_context(patch("app.services.broker_service.fetch_historical", no_second_level))
    stack.enter_context(patch("app.services.options_service.fetch_options_historical", no_second_level))
    stack.enter_context(patch("app.services.data_loader.load_dataframe", no_second_level))
    stack.enter_context(patch("app.services.options_service.load_options_dataframe", no_second_level))
    stack.enter_context(patch("app.routers.chart_structures.svc.list_structures", return_value=[]))
    stack.enter_context(patch("app.routers.fine_structures.svc.list_flows", return_value=[]))
    return stack


async def get(path, **params):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.get(path, params=params)


class TestCandleRecords:
    def test_prior_days_and_selected_day_are_stitched_and_resampled(self):
        fake = FakeMinuteHistory()
        with patch("app.services.minute_history.load", fake):
            records = minute_ohlc.candle_records("RELIND", DATE, 3, 2)
        assert [call[1] for call in fake.calls] == ["2026-05-04", "2026-05-05", DATE]
        assert len(records) == 3 * (30 // 3)
        # IST wall-clock labelled UTC: 09:15 of the first day is its own epoch second.
        assert records[0]["time"] == int(pd.Timestamp("2026-05-04 09:15:00", tz="UTC").timestamp())
        assert records[-1]["time"] == int(pd.Timestamp(f"{DATE} 09:42:00", tz="UTC").timestamp())
        assert [r["time"] for r in records] == sorted(r["time"] for r in records)
        assert records[0]["volume"] == 750  # three 1-minute bars of 250

    def test_option_contract_is_passed_through(self):
        fake = FakeMinuteHistory()
        with patch("app.services.minute_history.load", fake):
            minute_ohlc.candle_records("NIFTY", DATE, 1, 1, strike=24500, expiry="2026-05-12", right="CE")
        assert fake.calls[-1] == ("NIFTY", DATE, 24500, "2026-05-12", "CE")

    def test_a_prior_day_without_data_is_skipped(self):
        fake = FakeMinuteHistory(missing={"2026-05-04"})
        with patch("app.services.minute_history.load", fake):
            records = minute_ohlc.candle_records("RELIND", DATE, 3, 2)
        assert len(records) == 2 * (30 // 3)

    def test_a_prior_day_whose_provider_failed_is_skipped(self):
        calls = []

        def load(symbol, date, *args):
            calls.append(date)
            if date == "2026-05-05":
                raise RuntimeError("Historical provider failed")
            return HistoricalResult(minute_frame(date), Path("x"), "minute", "kite", 60)

        with patch("app.services.minute_history.load", load):
            records = minute_ohlc.candle_records("RELIND", DATE, 3, 2)
        assert len(records) == 2 * (30 // 3)

    def test_the_selected_day_without_data_raises(self):
        with patch("app.services.minute_history.load", FakeMinuteHistory(missing={DATE})):
            with pytest.raises(FileNotFoundError):
                minute_ohlc.candle_records("RELIND", DATE, 3, 2)

    def test_an_index_has_no_volume_but_a_stock_keeps_it(self):
        with patch("app.services.minute_history.load", FakeMinuteHistory()):
            index = minute_ohlc.candle_records("NIFTY", DATE, 3, 1)
            stock = minute_ohlc.candle_records("RELIND", DATE, 3, 1)
        assert all("volume" not in record for record in index)
        assert all("volume" in record for record in stock)

    def test_an_index_option_keeps_its_volume(self):
        with patch("app.services.minute_history.load", FakeMinuteHistory()):
            records = minute_ohlc.candle_records("NIFTY", DATE, 3, 1, strike=24500, expiry="2026-05-12", right="CE")
        assert records and all("volume" in record for record in records)


class TestPatternRoutes:
    @pytest.mark.asyncio
    async def test_equity_candles_come_from_minute_data(self):
        fake = FakeMinuteHistory()
        with patched(fake):
            response = await get("/api/pattern/ohlc/equity", symbol="RELIND", date=DATE, interval_minutes=3)
        assert response.status_code == 200
        body = response.json()
        assert body["interval_minutes"] == 3 and len(body["candles"]) == 30
        assert {call[1] for call in fake.calls} == {"2026-05-04", "2026-05-05", DATE}

    @pytest.mark.asyncio
    async def test_options_candles_come_from_minute_data(self):
        fake = FakeMinuteHistory()
        with patched(fake):
            response = await get(
                "/api/pattern/ohlc/options", symbol="NIFTY", date=DATE, strike=24500, expiry="2026-05-12", right="ce",
                interval_minutes=1, days_back=1,
            )
        assert response.status_code == 200
        body = response.json()
        assert body["right"] == "CE" and body["strike"] == 24500 and len(body["candles"]) == 60
        assert fake.calls[-1] == ("NIFTY", DATE, 24500, "2026-05-12", "CE")

    @pytest.mark.asyncio
    async def test_missing_day_is_a_404_with_the_old_messages(self):
        with patched(FakeMinuteHistory(missing={DATE})):
            equity = await get("/api/pattern/ohlc/equity", symbol="RELIND", date=DATE)
            options = await get("/api/pattern/ohlc/options", symbol="NIFTY", date=DATE, strike=24500,
                                expiry="2026-05-12", right="PE")
        assert equity.status_code == 404 and "RELIND" in equity.json()["detail"]
        assert options.status_code == 404 and options.json()["detail"] == f"No options data for NIFTY PE 24500 on {DATE}"

    @pytest.mark.asyncio
    async def test_expired_breeze_session_is_a_503(self):
        with patched(FakeMinuteHistory(error=BreezeTokenError("Breeze session expired"))):
            response = await get("/api/pattern/ohlc/equity", symbol="RELIND", date=DATE)
        assert response.status_code == 503

    @pytest.mark.asyncio
    async def test_provider_failure_is_a_404_and_unsupported_symbol_is_not_a_500(self):
        with patched(FakeMinuteHistory(error=RuntimeError("Historical provider failed"))):
            failed = await get("/api/pattern/ohlc/equity", symbol="RELIND", date=DATE)
        assert failed.status_code == 404 and failed.json()["detail"] == "Historical provider failed"
        # The real instrument lookup, no fake: an unknown symbol must be answered 422, not turned into a 500.
        with patch("app.services.broker_service.fetch_historical", no_second_level):
            unknown = await get("/api/pattern/ohlc/equity", symbol="NOPE", date=DATE)
        assert unknown.status_code == 422


class TestStructureRoutes:
    @pytest.mark.asyncio
    async def test_chart_structures_ohlc(self):
        fake = FakeMinuteHistory()
        with patched(fake):
            response = await get(f"/api/chart-structures/ohlc/nifty/{DATE}", interval_minutes=3)
        assert response.status_code == 200
        body = response.json()
        assert body["symbol"] == "NIFTY" and len(body["candles"]) == 30
        assert fake.calls[-1][0] == "NIFTY"

    @pytest.mark.asyncio
    async def test_chart_structures_missing_data(self):
        with patched(FakeMinuteHistory(missing={DATE})):
            response = await get(f"/api/chart-structures/ohlc/NIFTY/{DATE}")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_fine_structures_ohlc(self):
        fake = FakeMinuteHistory()
        with patched(fake):
            response = await get(f"/api/fine-structures/ohlc/NIFTY/{DATE}", interval_minutes=3)
        assert response.status_code == 200 and len(response.json()["candles"]) == 30

    @pytest.mark.asyncio
    async def test_fine_structures_options_ohlc_derives_the_expiry(self):
        fake = FakeMinuteHistory()
        with patched(fake):
            response = await get(f"/api/fine-structures/ohlc-options/NIFTY/{DATE}", strike=24500, right="CE",
                                 interval_minutes=3)
        assert response.status_code == 200
        symbol, date, strike, expiry, right = fake.calls[-1]
        assert (symbol, date, strike, right) == ("NIFTY", DATE, 24500, "CE") and expiry

    @pytest.mark.asyncio
    async def test_fine_structures_options_missing_data_keeps_its_message(self):
        with patched(FakeMinuteHistory(missing={DATE})):
            response = await get(f"/api/fine-structures/ohlc-options/NIFTY/{DATE}", strike=24500, right="PE",
                                 expiry="2026-05-12")
        assert response.status_code == 404
        assert response.json()["detail"] == f"No options data for NIFTY PE 24500 on {DATE}"


def minute_result(prices, date=DATE, opens=None, start="09:15:00"):
    index = pd.date_range(pd.Timestamp(f"{date} {start}", tz="UTC"), periods=len(prices), freq="1min")
    frame = pd.DataFrame({"open": opens or prices, "high": prices, "low": prices, "close": prices, "observed": True}, index=index)
    return HistoricalResult(frame, Path("unused.parquet"), "minute", "kite", 60)


class TestDataRoutesMinuteGranularity:
    @pytest.mark.asyncio
    async def test_price_at_minute_is_the_open_of_the_bar_and_never_downloads_seconds(self):
        result = minute_result([24510.0, 24520.0], opens=[24500.0, 24511.0])
        with patch("app.routers.data._load_minute", return_value=result), \
             patch("app.routers.data._ensure_data", no_second_level), \
             patch("app.routers.data.load_dataframe", no_second_level):
            response = await get("/api/data/price-at", symbol="NIFTY", date=DATE, time="09:15", granularity="minute")
        assert response.status_code == 200
        assert response.json()["price"] == 24500.0 and response.json()["time"] == "09:15:00"

    @pytest.mark.asyncio
    async def test_price_at_minute_without_data_at_that_time_is_a_404(self):
        with patch("app.routers.data._load_minute", return_value=minute_result([24510.0], start="09:20:00")):
            response = await get("/api/data/price-at", symbol="NIFTY", date=DATE, time="09:15", granularity="minute")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_price_at_without_granularity_still_uses_second_level_data(self):
        seconds = pd.DataFrame(
            {"open": [1.0], "high": [1.0], "low": [1.0], "close": [24123.456]},
            index=pd.to_datetime([f"{DATE} 09:15:00"], utc=True),
        )
        with patch("app.routers.data._ensure_data", return_value=None), \
             patch("app.routers.data.load_dataframe", return_value=seconds), \
             patch("app.routers.data._load_minute", side_effect=AssertionError("minute data was requested")):
            response = await get("/api/data/price-at", symbol="NIFTY", date=DATE, time="09:15")
        assert response.status_code == 200 and response.json()["price"] == 24123.46

    @pytest.mark.asyncio
    async def test_find_strike_minute_uses_the_shared_resolver_at_the_reference_time(self):
        # ATM 24500 (interval 50); the CE premium falls 10 per strike: 120 at 24500, 100 at 24600.
        def load(symbol, date, strike=None, *args):
            if strike is None:
                return minute_result([24510.0] * 20)
            return minute_result([120.0 - (strike - 24500) / 50 * 10] * 20)

        with patch("app.services.desktop_preparation._load_minute", side_effect=load), \
             patch("app.services.options_service.find_strike_by_max_price", no_second_level):
            response = await get("/api/data/options/find-strike-by-price", symbol="NIFTY", date=DATE, expiry="2026-05-12",
                                 right="ce", max_price=100, reference_time="09:30", granularity="minute")
        assert response.status_code == 200
        assert response.json() == {"strike": 24600, "price": 100.0, "symbol": "NIFTY", "date": DATE, "right": "CE"}

    @pytest.mark.asyncio
    async def test_find_strike_minute_miss_is_a_404_with_the_reason_and_no_atm_fallback(self):
        def load(symbol, date, strike=None, *args):
            return minute_result([24510.0 if strike is None else 500.0] * 20)

        with patch("app.services.desktop_preparation._load_minute", side_effect=load):
            response = await get("/api/data/options/find-strike-by-price", symbol="NIFTY", date=DATE, expiry="2026-05-12",
                                 right="PE", max_price=10, reference_time="09:30:00", granularity="minute")
        assert response.status_code == 404
        assert response.json()["detail"] == "No observed premium at or below the cap within 30 strikes"

    @pytest.mark.asyncio
    async def test_find_strike_minute_rejects_a_bad_cap_and_an_unknown_symbol_before_loading_anything(self):
        refuse = AssertionError("minute data was requested")
        with patch("app.services.desktop_preparation._load_minute", side_effect=refuse):
            bad_cap = await get("/api/data/options/find-strike-by-price", symbol="NIFTY", date=DATE, expiry="2026-05-12",
                                right="CE", max_price=0, granularity="minute")
            unknown = await get("/api/data/options/find-strike-by-price", symbol="NOPE", date=DATE, expiry="2026-05-12",
                                right="CE", max_price=100, granularity="minute")
        assert bad_cap.status_code == 422 and unknown.status_code == 400

    @pytest.mark.asyncio
    async def test_find_strike_without_granularity_keeps_the_second_level_scan(self):
        with patch("app.services.options_service.find_strike_by_max_price", return_value={"strike": 24550, "price": 99.0}), \
             patch("app.services.desktop_preparation._load_minute", side_effect=AssertionError("minute data was requested")):
            response = await get("/api/data/options/find-strike-by-price", symbol="NIFTY", date=DATE, expiry="2026-05-12",
                                 right="CE", max_price=100)
        assert response.status_code == 200 and response.json()["strike"] == 24550
