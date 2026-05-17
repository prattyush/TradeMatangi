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
    pre_session_candles,
    validate_and_fill_gaps,
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

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            result = load_dataframe("NIFTY", "2026-05-06")

        assert result.index.tz is not None
        assert str(result.index.tz) == "UTC"

    def test_first_timestamp_displays_as_0915(self, tmp_path):
        df = make_ist_df()
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
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

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            result = load_dataframe("NIFTY", "2026-05-06")

        assert set(["open", "high", "low", "close"]).issubset(result.columns)
        assert "volume" not in result.columns

    def test_raises_for_missing_file(self, tmp_path):
        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            with pytest.raises(FileNotFoundError):
                load_dataframe("NIFTY", "2026-05-07")


class TestResampleToCandles:
    def test_produces_correct_number_of_candles(self, tmp_path):
        # 360 seconds = exactly 2 × 3-min candles
        df = make_ist_df(n_seconds=360)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            raw = load_dataframe("NIFTY", "2026-05-06")

        candles = resample_to_candles(raw)
        assert len(candles) == 2

    def test_custom_interval_5min(self, tmp_path):
        # 600 seconds = exactly 2 × 5-min candles
        df = make_ist_df(n_seconds=600)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            raw = load_dataframe("NIFTY", "2026-05-06")

        candles = resample_to_candles(raw, interval_minutes=5)
        assert len(candles) == 2

    def test_custom_interval_1min(self, tmp_path):
        # 360 seconds = exactly 6 × 1-min candles
        df = make_ist_df(n_seconds=360)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            raw = load_dataframe("NIFTY", "2026-05-06")

        candles = resample_to_candles(raw, interval_minutes=1)
        assert len(candles) == 6

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

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
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

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
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

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            ticks = list(iter_ticks("NIFTY", "2026-05-06", start_time="09:15:00"))

        assert len(ticks) == n

    def test_start_time_filters_correctly(self, tmp_path):
        df = make_ist_df(n_seconds=600)  # 10 minutes from 09:15
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            # Start at 09:16 (1 minute in = 60 seconds skipped)
            ticks = list(iter_ticks("NIFTY", "2026-05-06", start_time="09:16:00"))

        assert len(ticks) == 540  # 600 - 60

    def test_tick_has_required_fields(self, tmp_path):
        df = make_ist_df(n_seconds=10)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            tick = next(iter_ticks("NIFTY", "2026-05-06"))

        assert tick["type"] == "tick"
        assert isinstance(tick["time"], int)
        for field in ("open", "high", "low", "close"):
            assert field in tick
            assert isinstance(tick[field], float)


class TestPreSessionCandles:
    def test_returns_candles_before_start_time(self, tmp_path):
        # 600s from 09:15 → data up to 09:25
        df = make_ist_df(n_seconds=600)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            # Start at 09:21 → pre-session covers 09:15–09:21 = 2 × 3-min candles
            records = pre_session_candles("NIFTY", "2026-05-06", "09:21:00")

        assert len(records) == 2
        # All candles must be before start_time timestamp
        start_unix = int(pd.Timestamp("2026-05-06 09:21:00", tz="UTC").timestamp())
        for r in records:
            assert r["time"] < start_unix

    def test_returns_empty_when_start_at_market_open(self, tmp_path):
        df = make_ist_df(n_seconds=300)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            records = pre_session_candles("NIFTY", "2026-05-06", "09:15:00")

        assert records == []

    def test_respects_custom_interval(self, tmp_path):
        # 600s from 09:15 → data up to 09:25
        df = make_ist_df(n_seconds=600)
        pickle_path = tmp_path / "NIFTY-06-05-2026.pickle"
        df.to_pickle(pickle_path)

        with patch("app.services.data_loader.DATA_DIR", tmp_path), patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            # Start at 09:25, 5-min interval → 09:15–09:25 = 2 × 5-min candles
            records = pre_session_candles("NIFTY", "2026-05-06", "09:25:00", interval_minutes=5)

        assert len(records) == 2


class TestValidateAndFillGaps:
    DATE = "2026-05-06"
    MARKET_OPEN = pd.Timestamp("2026-05-06 09:15:00")
    MARKET_CLOSE_LAST = pd.Timestamp("2026-05-06 15:29:59")

    def _full_day_df(self) -> pd.DataFrame:
        idx = pd.date_range(self.MARKET_OPEN, periods=22500, freq="s")
        return pd.DataFrame({"open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5}, index=idx)

    def test_complete_data_unchanged_length(self):
        df = self._full_day_df()
        result = validate_and_fill_gaps(df, self.DATE)
        assert len(result) == 22500

    def test_small_gap_is_filled(self):
        df = self._full_day_df()
        # Remove 5 minutes (300 rows) in the middle
        mask = (df.index >= pd.Timestamp("2026-05-06 10:00:00")) & \
               (df.index < pd.Timestamp("2026-05-06 10:05:00"))
        df = df[~mask]
        assert len(df) == 22200

        result = validate_and_fill_gaps(df, self.DATE)
        assert len(result) == 22500  # gap filled back to full day

    def test_gap_exactly_15_min_is_filled(self):
        df = self._full_day_df()
        # Remove exactly 900 rows (15 minutes)
        mask = (df.index >= pd.Timestamp("2026-05-06 11:00:00")) & \
               (df.index < pd.Timestamp("2026-05-06 11:15:00"))
        df = df[~mask]
        result = validate_and_fill_gaps(df, self.DATE)
        assert len(result) == 22500

    def test_gap_over_15_min_raises(self):
        df = self._full_day_df()
        # Remove 16 minutes (960 rows)
        mask = (df.index >= pd.Timestamp("2026-05-06 11:00:00")) & \
               (df.index < pd.Timestamp("2026-05-06 11:16:00"))
        df = df[~mask]
        with pytest.raises(RuntimeError, match="gap"):
            validate_and_fill_gaps(df, self.DATE)

    def test_empty_dataframe_raises(self):
        df = pd.DataFrame(columns=["open", "high", "low", "close"])
        with pytest.raises(RuntimeError):
            validate_and_fill_gaps(df, self.DATE)

    def test_forward_fill_propagates_last_known_price(self):
        df = self._full_day_df()
        # Set a distinctive close value just before the gap
        df.loc[pd.Timestamp("2026-05-06 10:00:00"), "close"] = 999.0
        # Remove the next 5 seconds
        gap_idx = pd.date_range("2026-05-06 10:00:01", periods=5, freq="s")
        df = df.drop(gap_idx, errors="ignore")

        result = validate_and_fill_gaps(df, self.DATE)
        # The gap seconds should be forward-filled from the 999.0 close
        assert result.loc[pd.Timestamp("2026-05-06 10:00:05"), "close"] == pytest.approx(999.0)
