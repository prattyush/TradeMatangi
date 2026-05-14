"""
Phase IV tests: options-historical endpoint fetches 2 prior trading days
plus the trading date itself (for pre-session candles).
"""
import pytest
import pandas as pd
import numpy as np
from unittest.mock import patch
from httpx import AsyncClient, ASGITransport

from app.main import app

TRADING_DATE = "2026-05-07"
BASE_PARAMS = dict(
    symbol="NIFTY",
    date=TRADING_DATE,
    strike=24000,
    expiry="2026-05-08",
    right="CE",
    interval_minutes=3,
)
# prior_trading_days("2026-05-07", n=2) → ["2026-05-05", "2026-05-06"]
# endpoint appends [date] → ["2026-05-05", "2026-05-06", "2026-05-07"] (3 total)
PRIOR_TWO = ["2026-05-05", "2026-05-06"]


def make_df(n: int = 300, base: float = 150.0, start: str = "2026-05-06 09:15:00") -> pd.DataFrame:
    idx = pd.date_range(pd.Timestamp(start), periods=n, freq="s")
    rng = np.random.default_rng(99)
    return pd.DataFrame(
        {
            "open": base + rng.uniform(-2, 2, n),
            "high": base + rng.uniform(0, 5, n),
            "low": base + rng.uniform(-5, 0, n),
            "close": base + rng.uniform(-2, 2, n),
            "volume": np.zeros(n),
        },
        index=idx,
    )


@pytest.mark.asyncio
class TestOptionsHistoricalTwoDays:

    async def _get(self, client, params=None):
        p = {**BASE_PARAMS, **(params or {})}
        return await client.get("/api/data/options-historical", params=p)

    async def test_fetches_prior_days_plus_trading_date(self):
        """2 prior days + trading date are all fetched; candles concatenated."""
        df1 = make_df(300, 150.0, "2026-05-05 09:15:00")
        df2 = make_df(300, 155.0, "2026-05-06 09:15:00")
        df3 = make_df(300, 160.0, "2026-05-07 09:15:00")

        with patch("app.routers.data.prior_trading_days", return_value=PRIOR_TWO), \
             patch("app.services.options_service.fetch_options_historical") as mock_fetch, \
             patch("app.services.options_service.load_options_dataframe") as mock_load:
            mock_load.side_effect = [df1, df2, df3]
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await self._get(client)

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["candles"]) > 0
        # 3 fetch calls: prior-2, prior-1, and trading date
        assert mock_fetch.call_count == 3

    async def test_skips_prior_day_if_file_not_found(self):
        """FileNotFoundError on a prior day is skipped; subsequent days still returned."""
        df2 = make_df(300, 155.0, "2026-05-06 09:15:00")
        df3 = make_df(300, 160.0, "2026-05-07 09:15:00")

        with patch("app.routers.data.prior_trading_days", return_value=PRIOR_TWO), \
             patch("app.services.options_service.fetch_options_historical"), \
             patch("app.services.options_service.load_options_dataframe") as mock_load:
            mock_load.side_effect = [FileNotFoundError("no data"), df2, df3]
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await self._get(client)

        assert resp.status_code == 200
        assert len(resp.json()["candles"]) > 0

    async def test_returns_404_when_no_days_have_data(self):
        """If all days fail, return 404."""
        with patch("app.routers.data.prior_trading_days", return_value=PRIOR_TWO), \
             patch("app.services.options_service.fetch_options_historical"), \
             patch("app.services.options_service.load_options_dataframe") as mock_load:
            mock_load.side_effect = FileNotFoundError("no data")
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await self._get(client)

        assert resp.status_code == 404

    async def test_breeze_token_error_propagates(self):
        """BreezeTokenError raises 503 immediately."""
        from app.services.broker_service import BreezeTokenError

        with patch("app.routers.data.prior_trading_days", return_value=PRIOR_TWO), \
             patch("app.services.options_service.fetch_options_historical",
                   side_effect=BreezeTokenError("expired")):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await self._get(client)

        assert resp.status_code == 503

    async def test_trading_date_included_even_if_prior_days_missing(self):
        """If prior days have no data but the trading date does, return 200."""
        df3 = make_df(300, 160.0, "2026-05-07 09:15:00")

        with patch("app.routers.data.prior_trading_days", return_value=PRIOR_TWO), \
             patch("app.services.options_service.fetch_options_historical"), \
             patch("app.services.options_service.load_options_dataframe") as mock_load:
            mock_load.side_effect = [FileNotFoundError(), FileNotFoundError(), df3]
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await self._get(client)

        assert resp.status_code == 200
        assert len(resp.json()["candles"]) > 0

    async def test_invalid_right_returns_400(self):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await self._get(client, {"right": "INVALID"})
        assert resp.status_code == 400

    async def test_unsupported_symbol_returns_400(self):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await self._get(client, {"symbol": "UNKNOWN"})
        assert resp.status_code == 400

    async def test_response_symbol_includes_right_and_strike(self):
        """Symbol in response is formatted as SYMBOL-RIGHT-STRIKE."""
        df = make_df(300, 150.0)

        with patch("app.routers.data.prior_trading_days", return_value=[]), \
             patch("app.services.options_service.fetch_options_historical"), \
             patch("app.services.options_service.load_options_dataframe", return_value=df):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                resp = await self._get(client)

        assert resp.status_code == 200
        assert resp.json()["symbol"] == "NIFTY-CE-24000"
