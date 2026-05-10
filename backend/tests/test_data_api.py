"""
Integration tests for the /api/data/* endpoints.
All Breeze calls are mocked so no real credentials are needed.
"""
import pytest
import pandas as pd
import numpy as np
from unittest.mock import patch, MagicMock
from httpx import AsyncClient, ASGITransport

from app.main import app


def make_ist_df(n_seconds: int = 600, base_price: float = 24200.0) -> pd.DataFrame:
    start = pd.Timestamp("2026-05-06 09:15:00")
    idx = pd.date_range(start, periods=n_seconds, freq="s")
    rng = np.random.default_rng(42)
    return pd.DataFrame(
        {
            "open": base_price + rng.uniform(-5, 5, n_seconds),
            "high": base_price + rng.uniform(0, 10, n_seconds),
            "low": base_price + rng.uniform(-10, 0, n_seconds),
            "close": base_price + rng.uniform(-5, 5, n_seconds),
            "volume": np.zeros(n_seconds),
        },
        index=idx,
    )


def write_pickle(tmp_path, symbol: str, date: str, n: int = 600):
    y, m, d = date.split("-")
    path = tmp_path / f"{symbol}-{d}-{m}-{y}.pickle"
    make_ist_df(n).to_pickle(path)
    return path


@pytest.mark.asyncio
class TestSymbolsEndpoint:
    async def test_returns_supported_symbols(self):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/data/symbols")
        assert resp.status_code == 200
        data = resp.json()
        symbols = [s["symbol"] for s in data["symbols"]]
        assert "NIFTY" in symbols
        assert "RELIND" in symbols

    async def test_each_symbol_has_display_name(self):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/data/symbols")
        for item in resp.json()["symbols"]:
            assert item["display_name"]


@pytest.mark.asyncio
class TestAvailableDatesEndpoint:
    async def test_returns_dates_for_cached_pickles(self, tmp_path):
        write_pickle(tmp_path, "NIFTY", "2026-05-04")
        write_pickle(tmp_path, "NIFTY", "2026-05-05")

        with patch("app.routers.data.DATA_DIR", tmp_path):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get("/api/data/available-dates?symbol=NIFTY")

        assert resp.status_code == 200
        dates = resp.json()["dates"]
        assert "2026-05-04" in dates
        assert "2026-05-05" in dates

    async def test_unsupported_symbol_returns_400(self):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get("/api/data/available-dates?symbol=FAKE")
        assert resp.status_code == 400


@pytest.mark.asyncio
class TestHistoricalEndpoint:
    async def test_returns_candles_for_prior_dates(self, tmp_path):
        # trading_date=2026-05-06 → prior dates = 2026-05-04, 2026-05-05
        write_pickle(tmp_path, "NIFTY", "2026-05-04")
        write_pickle(tmp_path, "NIFTY", "2026-05-05")

        with (
            patch("app.routers.data.DATA_DIR", tmp_path),
            patch("app.services.data_loader.DATA_DIR", tmp_path),
            patch("app.routers.data._ensure_data"),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get(
                    "/api/data/historical?symbol=NIFTY&trading_date=2026-05-06"
                )

        assert resp.status_code == 200
        data = resp.json()
        assert data["symbol"] == "NIFTY"
        assert len(data["candles"]) > 0
        assert data["dates"] == ["2026-05-04", "2026-05-05"]

    async def test_custom_interval_param(self, tmp_path):
        write_pickle(tmp_path, "NIFTY", "2026-05-04")
        write_pickle(tmp_path, "NIFTY", "2026-05-05")

        with (
            patch("app.routers.data.DATA_DIR", tmp_path),
            patch("app.services.data_loader.DATA_DIR", tmp_path),
            patch("app.routers.data._ensure_data"),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp3 = await client.get(
                    "/api/data/historical?symbol=NIFTY&trading_date=2026-05-06&interval_minutes=3"
                )
                resp5 = await client.get(
                    "/api/data/historical?symbol=NIFTY&trading_date=2026-05-06&interval_minutes=5"
                )

        # 5-min candles → fewer candles than 3-min
        assert len(resp5.json()["candles"]) < len(resp3.json()["candles"])

    async def test_omitting_trading_date_uses_default(self, tmp_path):
        # trading_date defaults to 2026-05-06 for backward compat with old frontend
        write_pickle(tmp_path, "NIFTY", "2026-05-04")
        write_pickle(tmp_path, "NIFTY", "2026-05-05")

        with (
            patch("app.routers.data.DATA_DIR", tmp_path),
            patch("app.services.data_loader.DATA_DIR", tmp_path),
            patch("app.routers.data._ensure_data"),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get("/api/data/historical?symbol=NIFTY")

        assert resp.status_code == 200

    async def test_unsupported_symbol_returns_400(self):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            resp = await client.get(
                "/api/data/historical?symbol=FAKE&trading_date=2026-05-06"
            )
        assert resp.status_code == 400


@pytest.mark.asyncio
class TestPreSessionEndpoint:
    async def test_returns_candles_before_start_time(self, tmp_path):
        write_pickle(tmp_path, "NIFTY", "2026-05-06", n=600)

        with (
            patch("app.routers.data.DATA_DIR", tmp_path),
            patch("app.services.data_loader.DATA_DIR", tmp_path),
            patch("app.routers.data._ensure_data"),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get(
                    "/api/data/pre-session"
                    "?symbol=NIFTY&trading_date=2026-05-06&start_time=09:21"
                )

        assert resp.status_code == 200
        data = resp.json()
        assert data["symbol"] == "NIFTY"
        assert len(data["candles"]) == 2  # 09:15–09:18 and 09:18–09:21

    async def test_empty_when_start_at_market_open(self, tmp_path):
        write_pickle(tmp_path, "NIFTY", "2026-05-06")

        with (
            patch("app.routers.data.DATA_DIR", tmp_path),
            patch("app.services.data_loader.DATA_DIR", tmp_path),
            patch("app.routers.data._ensure_data"),
        ):
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.get(
                    "/api/data/pre-session"
                    "?symbol=NIFTY&trading_date=2026-05-06&start_time=09:15"
                )

        assert resp.status_code == 200
        assert resp.json()["candles"] == []
