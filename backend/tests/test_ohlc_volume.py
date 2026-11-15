"""Volume through the historical OHLC pipeline (Phase 24, B1).

Volume belongs to provider rows only: gap-filled seconds carry none, indices report none,
and files saved without a volume column still load.
"""
import numpy as np
import pandas as pd
import pytest
from unittest.mock import patch

from app.models.schemas import OHLCCandle
from app.routers.desktop import DesktopCandle
from app.services.data_loader import (
    candles_to_records,
    clean_volume,
    iter_ticks,
    load_dataframe,
    resample_to_candles,
    validate_and_fill_gaps,
)
from app.services.historical_data_service import _normalize
from app.services.options_service import load_options_dataframe, options_iter_ticks, options_parquet_path

DATE = "2026-05-06"


def frame(n=360, volume=10.0, price=100.0, start=f"{DATE} 09:15:00"):
    index = pd.date_range(start, periods=n, freq="s")
    return pd.DataFrame({"open": price, "high": price + 1, "low": price - 1, "close": price,
                         "volume": volume}, index=index)


class TestCleanVolume:
    def test_frame_without_volume_is_unchanged(self):
        df = frame().drop(columns="volume")
        assert clean_volume(df) is df

    def test_observed_flag_zeroes_filled_rows(self):
        df = frame(4)
        df["observed"] = [True, False, True, False]
        assert clean_volume(df)["volume"].tolist() == [10.0, 0.0, 10.0, 0.0]

    def test_legacy_file_filled_rows_are_rows_identical_to_the_previous_one(self):
        df = frame(5)
        df["close"] = [100.0, 101.0, 101.0, 101.0, 102.0]
        df["high"] = df["close"] + 1
        df["volume"] = [10.0, 20.0, 20.0, 20.0, 30.0]
        # seconds 3 and 4 repeat second 2 in every column: forward-filled, not traded
        assert clean_volume(df)["volume"].tolist() == [10.0, 20.0, 0.0, 0.0, 30.0]

    def test_legacy_file_leading_back_filled_run_keeps_one_row(self):
        df = frame(5)
        df.loc[df.index[4], ["open", "high", "low", "close"]] = [105.0, 106.0, 104.0, 105.0]
        df["volume"] = [40.0, 40.0, 40.0, 40.0, 50.0]
        # first four rows are the back-filled copy of the first real row (the 4th)
        assert clean_volume(df)["volume"].tolist() == [0.0, 0.0, 0.0, 40.0, 50.0]

    def test_real_zero_volume_second_is_kept_and_bad_values_become_zero(self):
        df = frame(4)
        df["close"] = [100.0, 101.0, 102.0, 103.0]
        df["volume"] = [5.0, 0.0, -3.0, np.nan]
        assert clean_volume(df)["volume"].tolist() == [5.0, 0.0, 0.0, 0.0]

    def test_input_is_not_modified(self):
        df = frame(3)
        df["observed"] = [True, False, True]
        clean_volume(df)
        assert df["volume"].tolist() == [10.0, 10.0, 10.0]


def test_gap_fill_gives_filled_seconds_no_volume():
    df = frame(1200).drop(index=pd.date_range(f"{DATE} 09:20:00", periods=60, freq="s"))
    df["observed"] = True
    filled = validate_and_fill_gaps(df, DATE, partial=True)
    gap = filled.loc[f"{DATE} 09:20:00":f"{DATE} 09:20:59"]
    assert len(gap) == 60 and (gap["volume"] == 0).all()
    assert (filled.loc[f"{DATE} 09:21:00":f"{DATE} 09:21:10", "volume"] == 10).all()
    assert filled["volume"].sum() == 10.0 * (1200 - 60)


def test_gap_fill_does_not_leak_first_row_volume_into_the_leading_gap():
    df = frame(600, start=f"{DATE} 09:15:10")
    filled = validate_and_fill_gaps(df, DATE, partial=True)
    assert (filled.loc[f"{DATE} 09:15:00":f"{DATE} 09:15:09", "volume"] == 0).all()
    assert filled["volume"].sum() == 10.0 * 600


def test_resample_sums_volume_and_records_carry_integer_volume():
    df = frame(360)
    df.index = df.index.tz_localize("UTC")
    records = candles_to_records(resample_to_candles(df, 3))
    assert [r["volume"] for r in records] == [1800, 1800]
    assert isinstance(records[0]["volume"], int)


def test_resample_and_records_without_volume_keep_the_old_shape():
    df = frame(360).drop(columns="volume")
    df.index = df.index.tz_localize("UTC")
    records = candles_to_records(resample_to_candles(df, 3))
    assert "volume" not in records[0]


class TestEquityLoader:
    def write(self, tmp_path, df, symbol):
        directory = tmp_path / "ohlcdata"
        directory.mkdir(exist_ok=True)
        df.to_parquet(directory / f"{symbol}-06-05-2026.parquet")

    def load(self, tmp_path, symbol):
        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
                patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            return load_dataframe(symbol, DATE)

    def test_equity_keeps_cleaned_volume_and_ticks_carry_it(self, tmp_path):
        df = frame(60)
        df["observed"] = [True, False] * 30
        self.write(tmp_path, df, "NAUKRI")
        with patch("app.services.data_loader.DATA_DIR", tmp_path), \
                patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
                patch("app.services.historical_data_service.history_mode", return_value="replay"):
            result = load_dataframe("NAUKRI", DATE)
            ticks = list(iter_ticks("NAUKRI", DATE))
        assert result["volume"].sum() == 300.0
        assert ticks[0]["volume"] == 10 and ticks[1]["volume"] == 0

    def test_index_reports_no_volume(self, tmp_path):
        self.write(tmp_path, frame(60, volume=0.0), "NIFTY")
        result = self.load(tmp_path, "NIFTY")
        assert "volume" not in result.columns

    def test_file_saved_without_volume_still_loads(self, tmp_path):
        self.write(tmp_path, frame(60).drop(columns="volume"), "NAUKRI")
        result = self.load(tmp_path, "NAUKRI")
        assert list(result.columns) == ["open", "high", "low", "close"]


class TestOptionsLoader:
    def write(self, tmp_path, df):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            (tmp_path / "ohlcdata").mkdir(exist_ok=True)
            df.to_parquet(options_parquet_path("NIFTY", DATE, 24000, "2026-05-19", "CE"))

    def load(self, tmp_path):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
                patch("app.services.historical_data_service.history_mode", return_value="replay"):
            return load_options_dataframe("NIFTY", DATE, 24000, "2026-05-19", "CE")

    def test_index_option_keeps_volume_even_though_the_index_has_none(self, tmp_path):
        df = frame(60)
        df["observed"] = [True, False] * 30
        self.write(tmp_path, df)
        result = self.load(tmp_path)
        assert result["volume"].sum() == 300.0

    def test_legacy_option_file_does_not_double_count_filled_seconds(self, tmp_path):
        df = frame(60)
        df["close"] = [100.0 + i // 3 for i in range(60)]  # every third second repeats
        df["high"] = df["close"] + 1
        df["low"] = df["close"] - 1
        df["open"] = df["close"]
        self.write(tmp_path, df)
        assert self.load(tmp_path)["volume"].sum() < 600.0

    def test_option_ticks_carry_volume(self, tmp_path):
        df = frame(60)
        df["close"] = [100.0 + i for i in range(60)]
        self.write(tmp_path, df)
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
                patch("app.services.historical_data_service.history_mode", return_value="replay"):
            ticks = list(options_iter_ticks("NIFTY", DATE, 24000, "2026-05-19", "CE"))
        assert ticks[0]["volume"] == 10


def test_normalize_keeps_volume_for_provider_minute_frames():
    df = frame(3)
    df.index = pd.date_range(f"{DATE} 09:15:00", periods=3, freq="min")
    df["observed"] = True
    result = _normalize(df, DATE)
    assert result["volume"].tolist() == [10.0, 10.0, 10.0]
    assert list(result.columns) == ["open", "high", "low", "close", "volume", "observed"]


def test_normalize_still_accepts_frames_without_volume():
    result = _normalize(frame(3).drop(columns="volume"), DATE)
    assert list(result.columns) == ["open", "high", "low", "close"]


def test_api_models_accept_missing_volume_and_carry_it_when_present():
    assert OHLCCandle(time=1, open=1, high=2, low=1, close=2).volume is None
    assert OHLCCandle(time=1, open=1, high=2, low=1, close=2, volume=7).volume == 7
    assert DesktopCandle(timestamp=1, open=1, high=2, low=1, close=2).volume is None
    assert DesktopCandle(timestamp=1, open=1, high=2, low=1, close=2, volume=7).volume == 7
