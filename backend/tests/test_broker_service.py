import configparser
import pytest
import pandas as pd
import numpy as np
from pathlib import Path
from unittest.mock import patch, MagicMock

from app.services.broker_service import (
    fetch_historical,
    _breeze_to_dataframe,
    BreezeTokenError,
    BreezeSymbolError,
)
from app.services.data_loader import pickle_path as _pickle_path


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


class TestFetchHistorical:
    def test_cache_hit_skips_breeze(self, tmp_path):
        """If pickle exists, Breeze should never be called."""
        pkl = tmp_path / "NIFTY-06-05-2026.pickle"
        pd.DataFrame().to_pickle(pkl)  # empty but present

        # pickle_path() lives in data_loader and references data_loader.DATA_DIR
        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service._get_breeze") as mock_breeze:
                result = fetch_historical("NIFTY", "2026-05-06")

        mock_breeze.assert_not_called()
        assert result == pkl

    def test_unsupported_symbol_raises(self, tmp_path):
        with pytest.raises(BreezeSymbolError):
            fetch_historical("UNKNOWN", "2026-05-06")

    def test_saves_pickle_on_success(self, tmp_path):
        mock_breeze = MagicMock()
        mock_breeze.get_historical_data_v2.return_value = {
            "Status": 200,
            "Error": None,
            "Success": _make_breeze_records(10),
        }

        with patch("app.services.data_loader.DATA_DIR", tmp_path):
            with patch("app.services.broker_service.DATA_DIR", tmp_path):
                with patch("app.services.broker_service._get_breeze", return_value=mock_breeze):
                    result = fetch_historical("NIFTY", "2026-05-06")

        assert result.exists()
        df = pd.read_pickle(result)
        assert len(df) == 10

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
