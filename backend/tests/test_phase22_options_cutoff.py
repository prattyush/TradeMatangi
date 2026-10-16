"""A replay chart may restore a partial bar only from cursor-bounded raw seconds."""
from unittest.mock import Mock

import pandas as pd
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.routers import data
from app.services import options_service


@pytest.fixture
def source(monkeypatch):
    df = pd.DataFrame({
        "open": [100, 120, 110, 200, 500],
        "high": [100, 120, 110, 200, 500],
        "low": [100, 120, 110, 200, 500],
        "close": [100, 120, 110, 200, 500],
    }, index=pd.to_datetime(["2026-10-06 09:24:00", "2026-10-06 09:24:30", "2026-10-06 09:24:59", "2026-10-06 09:25:00", "2026-10-06 09:25:01"], utc=True))
    fetch = Mock()
    monkeypatch.setattr(options_service, "fetch_options_historical", fetch)
    monkeypatch.setattr(options_service, "load_options_dataframe", lambda *args: df.copy())
    monkeypatch.setattr(data, "prior_trading_days", lambda *args, **kwargs: [])
    async def inline(fn, *args):
        return fn(*args)
    monkeypatch.setattr(data, "run_data_history", inline)
    return df, fetch


async def request(**params):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.get("/api/data/options-historical", params={"symbol": "NIFTY", "date": "2026-10-06", "strike": 24000, "expiry": "2026-10-08", "right": "CE", "interval_minutes": 3, **params})


@pytest.mark.asyncio
async def test_cutoff_filters_raw_seconds_before_resampling_and_echoes_normalized_time(source):
    response = await request(as_of_time="09:25")
    assert response.status_code == 200
    body = response.json()
    assert body["as_of_time"] == "09:25:00"
    assert body["candles"] == [{"time": int(pd.Timestamp("2026-10-06 09:24", tz="UTC").timestamp()), "open": 100, "high": 120, "low": 100, "close": 110}]


@pytest.mark.asyncio
async def test_omitting_cutoff_keeps_the_existing_full_day_response(source):
    response = await request()
    assert response.status_code == 200
    body = response.json()
    assert "as_of_time" not in body
    assert body["candles"][0]["high"] == body["candles"][0]["close"] == 500


@pytest.mark.asyncio
async def test_prior_days_are_not_truncated_by_the_selected_day_clock(source, monkeypatch):
    current, _ = source
    previous = current.iloc[:1].copy()
    previous.index = pd.to_datetime(["2026-10-05 15:29:00"], utc=True)
    monkeypatch.setattr(data, "prior_trading_days", lambda *args, **kwargs: ["2026-10-05"])
    monkeypatch.setattr(options_service, "load_options_dataframe", lambda symbol, day, *args: previous if day == "2026-10-05" else current)
    response = await request(as_of_time="09:25:00")
    assert response.status_code == 200
    assert response.json()["dates"] == ["2026-10-05", "2026-10-06"]
    assert len(response.json()["candles"]) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("clock", ["25:00", "12:99", "09:15:99", "not-time"])
async def test_invalid_cutoff_cannot_fetch_history(source, clock):
    _, fetch = source
    assert (await request(as_of_time=clock)).status_code == 422
    fetch.assert_not_called()
