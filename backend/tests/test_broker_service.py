import configparser
import pytest
import pandas as pd
import numpy as np
from pathlib import Path
from unittest.mock import patch, MagicMock

from app.services.broker_service import (
    fetch_historical,
    _breeze_to_dataframe,
    _fetch_day_paginated,
    BreezeTokenError,
    BreezeSymbolError,
)


def _make_breeze_records(n: int = 5) -> list[dict]:
    start = pd.Timestamp("2026-05-06 09:15:00")
    records = []
    for i in range(n):
        ts = start + pd.Timedelta(seconds=i)
        records.append({
            "datetime": str(ts),
            "open": "24200.0",
            "high": "24210.0",
            "low": "24190.0",
            "close": "24205.0",
            "volume": "100",
        })
    return records


def _make_full_day_df(date: str = "2026-05-06") -> pd.DataFrame:
    """Create a complete 22500-row second-level DataFrame for a trading day."""
    start = pd.Timestamp(f"{date} 09:15:00")
    idx = pd.date_range(start, periods=22500, freq="s")
    return pd.DataFrame({
        "open": 24200.0,
        "high": 24210.0,
        "low": 24190.0,
        "close": 24205.0,
        "volume": 0.0,
    }, index=idx)


def _chunk_side_effect(interval, from_date, to_date, stock_code, exchange_code, product_type):
    """Return 1-second records for the given time window — simulates a real Breeze response."""
    from_ts = pd.Timestamp(from_date)
    to_ts = pd.Timestamp(to_date)
    n = max(0, int((to_ts - from_ts).total_seconds()))
    records = [
        {
            "datetime": str(from_ts + pd.Timedelta(seconds=i)),
            "open": "24200.0",
            "high": "24210.0",
            "low": "24190.0",
            "close": "24205.0",
            "volume": "100",
        }
        for i in range(n)
    ]
    return {"Status": 200, "Error": None, "Success": records}


def _write_fake_ini(path: Path, section: str = "icicidirect", **kwargs) -> None:
    config = configparser.ConfigParser()
    config[section] = kwargs
    with open(path, "w") as f:
        config.write(f)


class TestBreezeToDatframe:
    def test_converts_records_to_dataframe(self):
        records = _make_breeze_records(10)
        df = _breeze_to_dataframe(records)
        assert len(df) == 10
        assert set(df.columns) >= {"open", "high", "low", "close"}

    def test_values_are_float(self):
        df = _breeze_to_dataframe(_make_breeze_records(3))
        assert df["open"].dtype == float

    def test_index_is_sorted(self):
        records = _make_breeze_records(5)
        df = _breeze_to_dataframe(records)
        assert df.index.is_monotonic_increasing

    def test_empty_records_returns_empty_df(self):
        df = _breeze_to_dataframe([])
        assert df.empty

    def test_deduplicates_chunk_boundary_overlap(self):
        records = _make_breeze_records(5) + _make_breeze_records(5)  # exact duplicates
        df = _breeze_to_dataframe(records)
        assert len(df) == 5


class TestFetchHistorical:
    def test_cache_hit_skips_breeze(self, tmp_path):
        """A complete cached parquet (>= _MIN_DAY_ROWS) must not trigger a Breeze call."""
        ohlc_dir = tmp_path / "ohlcdata"
        ohlc_dir.mkdir()
        pq = ohlc_dir / "NIFTY-06-05-2026.parquet"
        _make_full_day_df().to_parquet(pq)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze") as mock_breeze:
                result = fetch_historical("NIFTY", "2026-05-06")

        mock_breeze.assert_not_called()
        assert result == pq

    def test_incomplete_cache_triggers_refetch(self, tmp_path):
        """A cached parquet with < _MIN_DAY_ROWS rows must be discarded and re-fetched."""
        ohlc_dir = tmp_path / "ohlcdata"
        ohlc_dir.mkdir()
        pq = ohlc_dir / "NIFTY-06-05-2026.parquet"
        # Only 1000 rows — the old bug state
        pd.DataFrame({"open": [24200.0], "high": [24210.0], "low": [24190.0], "close": [24205.0]},
                     index=pd.date_range("2026-05-06 14:26:00", periods=1000, freq="s")).to_parquet(pq)

        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.side_effect = _chunk_side_effect

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze", return_value=mock_breeze):
                result = fetch_historical("NIFTY", "2026-05-06")

        assert mock_breeze.get_historical_data_v2.called
        df = pd.read_parquet(result)
        assert len(df) == 22500

    def test_legacy_pickle_migrated_to_parquet(self, tmp_path):
        """A complete legacy pickle should be converted to parquet without a Breeze call."""
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        _make_full_day_df().to_pickle(pkl)

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze") as mock_breeze:
                result = fetch_historical("NIFTY", "2026-05-06")

        mock_breeze.assert_not_called()
        assert result.suffix == ".parquet"
        assert result.exists()

    def test_incomplete_pickle_falls_through_to_breeze(self, tmp_path):
        """A legacy pickle with < _MIN_DAY_ROWS rows must trigger a Breeze fetch."""
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        pd.DataFrame({"open": [1.0], "high": [2.0], "low": [0.5], "close": [1.5]},
                     index=pd.to_datetime(["2026-05-06 09:15:00"])).to_pickle(pkl)

        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.side_effect = _chunk_side_effect

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze", return_value=mock_breeze):
                result = fetch_historical("NIFTY", "2026-05-06")

        assert mock_breeze.get_historical_data_v2.called

    def test_unsupported_symbol_raises(self, tmp_path):
        with pytest.raises(BreezeSymbolError):
            fetch_historical("UNKNOWN", "2026-05-06")

    def test_saves_full_day_parquet_on_success(self, tmp_path):
        """Paginated fetch must assemble all chunks and save 22500 rows (full trading day)."""
        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.side_effect = _chunk_side_effect

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze", return_value=mock_breeze):
                result = fetch_historical("NIFTY", "2026-05-06")

        assert result.exists()
        assert result.suffix == ".parquet"
        df = pd.read_parquet(result)
        assert len(df) == 22500
        # 375 minutes / 15-minute chunks = 25 API calls
        assert mock_breeze.get_historical_data_v2.call_count == 25

    def test_expired_token_raises_breeze_token_error(self, tmp_path):
        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.return_value = {
            "Status": 401,
            "Error": "session expired",
            "Success": [],
        }

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze", return_value=mock_breeze):
                with pytest.raises(BreezeTokenError):
                    fetch_historical("NIFTY", "2026-05-06")

    def test_no_data_returned_raises_runtime_error(self, tmp_path):
        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.return_value = {
            "Status": 200,
            "Error": None,
            "Success": [],
        }

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze", return_value=mock_breeze):
                with pytest.raises(RuntimeError):
                    fetch_historical("NIFTY", "2026-05-06")


class TestFetchDayPaginated:
    def test_makes_25_chunk_requests(self):
        """375-minute trading day ÷ 15-minute chunks = 25 API calls."""
        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.side_effect = _chunk_side_effect
        sym_info = {"breeze_stock_code": "NIFTY", "exchange_code": "NSE", "product_type": "cash"}

        records = _fetch_day_paginated(mock_breeze, sym_info, "2026-05-06")

        assert mock_breeze.get_historical_data_v2.call_count == 25
        assert len(records) == 22500

    def test_chunk_boundaries_are_contiguous(self):
        """Each chunk's from_date must equal the previous chunk's to_date."""
        calls_log = []

        def _log_and_return(interval, from_date, to_date, **kwargs):
            calls_log.append((from_date, to_date))
            return {"Status": 200, "Error": None, "Success": []}

        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.side_effect = _log_and_return
        sym_info = {"breeze_stock_code": "NIFTY", "exchange_code": "NSE", "product_type": "cash"}

        _fetch_day_paginated(mock_breeze, sym_info, "2026-05-06")

        # Every from_date (except first) equals the previous to_date
        for i in range(1, len(calls_log)):
            assert calls_log[i][0] == calls_log[i - 1][1]

    def test_auth_error_in_any_chunk_raises(self):
        call_count = [0]

        def _fail_on_third(**kwargs):
            call_count[0] += 1
            if call_count[0] == 3:
                return {"Status": 401, "Error": "session expired", "Success": []}
            return {"Status": 200, "Error": None, "Success": []}

        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.side_effect = _fail_on_third
        sym_info = {"breeze_stock_code": "NIFTY", "exchange_code": "NSE", "product_type": "cash"}

        with pytest.raises(BreezeTokenError):
            _fetch_day_paginated(mock_breeze, sym_info, "2026-05-06")
