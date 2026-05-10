import pytest
import pandas as pd
import numpy as np
from pathlib import Path
from unittest.mock import patch

from app.services.data_loader import (
    load_dataframe,
    resample_to_candles,
    candles_to_records,
    iter_ticks,
)


def make_ist_df(n_seconds: int = 360, base_price: float = 24200.0) -> pd.DataFrame:
    """Create a tz-naive IST second-level DataFrame like the real pickle files."""
    start = pd.Timestamp("2026-05-06 09:15:00")
    idx = pd.date_range(start, periods=n_seconds, freq="s")
    rng = np.random.default_rng(0)
    data = {
        "open": base_price + rng.uniform(-5, 5, n_seconds),
        "high": base_price + rng.uniform(0, 10, n_seconds),
        "low": base_price + rng.uniform(-10, 0, n_seconds),
        "close": base_price + rng.uniform(-5, 5, n_seconds),
        "volume": np.zeros(n_seconds),
    }
    return pd.DataFrame(data, index=idx)


class TestLoadDataframe:
    def test_converts_to_utc(self, tmp_path):
        df = make_ist_df()
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            result = load_dataframe("NIFTY", "2026-05-06")

        assert result.index.tz is not None
        assert str(result.index.tz) == "UTC"

    def test_first_timestamp_displays_as_0915(self, tmp_path):
        df = make_ist_df()
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            result = load_dataframe("NIFTY", "2026-05-06")

        # Index is labelled UTC with IST wall-clock values so charts show 09:15
        first_ts = result.index[0]
        assert first_ts.hour == 9
        assert first_ts.minute == 15
        assert first_ts.second == 0

    def test_has_required_columns(self, tmp_path):
        df = make_ist_df()
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            result = load_dataframe("NIFTY", "2026-05-06")

        assert set(["open", "high", "low", "close"]).issubset(result.columns)
        assert "volume" not in result.columns

    def test_raises_for_missing_file(self, tmp_path):
        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with pytest.raises(FileNotFoundError):
                load_dataframe("NIFTY", "2026-05-07")


class TestResampleToCandles:
    def test_produces_correct_number_of_candles(self, tmp_path):
        # 360 seconds = exactly 2 × 3-min candles
        df = make_ist_df(n_seconds=360)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            raw = load_dataframe("NIFTY", "2026-05-06")

        candles = resample_to_candles(raw)
        assert len(candles) == 2

    def test_ohlc_aggregation_correct(self, tmp_path):
        # 360 seconds = 2 × 3-min candles (0-179 = first, 180-359 = second)
        start = pd.Timestamp("2026-05-06 09:15:00")
        idx = pd.date_range(start, periods=360, freq="s")
        opens = [100.0] * 360
        opens[0] = 50.0     # open of first candle
        highs = [110.0] * 360
        highs[270] = 200.0  # high in second candle
        lows = [90.0] * 360
        lows[0] = 10.0      # low in first candle
        closes = [105.0] * 360
        closes[359] = 150.0  # last close of second candle

        df = pd.DataFrame(
            {"open": opens, "high": highs, "low": lows, "close": closes, "volume": [0]*360},
            index=idx,
        )
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            raw = load_dataframe("NIFTY", "2026-05-06")

        candles = resample_to_candles(raw)
        assert len(candles) == 2
        # First candle: open=50, high=110, low=10, close=105
        c1 = candles.iloc[0]
        assert c1["open"] == pytest.approx(50.0)
        assert c1["high"] == pytest.approx(110.0)
        assert c1["low"] == pytest.approx(10.0)
        assert c1["close"] == pytest.approx(105.0)
        # Second candle: high=200, close=150
        c2 = candles.iloc[1]
        assert c2["high"] == pytest.approx(200.0)
        assert c2["close"] == pytest.approx(150.0)


class TestCandlesToRecords:
    def test_records_have_unix_timestamps(self, tmp_path):
        df = make_ist_df(n_seconds=360)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            raw = load_dataframe("NIFTY", "2026-05-06")

        candles = resample_to_candles(raw)
        records = candles_to_records(candles)

        assert all(isinstance(r["time"], int) for r in records)
        # Timestamp encodes IST wall-clock as UTC so chart displays 09:15
        expected = pd.Timestamp("2026-05-06 09:15:00", tz="UTC")
        assert records[0]["time"] == int(expected.timestamp())


class TestIterTicks:
    def test_yields_correct_count(self, tmp_path):
        n = 180
        df = make_ist_df(n_seconds=n)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            ticks = list(iter_ticks("NIFTY", "2026-05-06", start_time="09:15:00"))

        assert len(ticks) == n

    def test_start_time_filters_correctly(self, tmp_path):
        df = make_ist_df(n_seconds=600)  # 10 minutes from 09:15
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            # Start at 09:16 (1 minute in = 60 seconds skipped)
            ticks = list(iter_ticks("NIFTY", "2026-05-06", start_time="09:16:00"))

        assert len(ticks) == 540  # 600 - 60

    def test_tick_has_required_fields(self, tmp_path):
        df = make_ist_df(n_seconds=10)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            tick = next(iter_ticks("NIFTY", "2026-05-06"))

        assert tick["type"] == "tick"
        assert isinstance(tick["time"], int)
        for field in ("open", "high", "low", "close"):
            assert field in tick
            assert isinstance(tick[field], float)
