"""
Tests for the Breeze security master loader.
"""
import csv
from datetime import datetime, time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.services import breeze_master


def _write_master_csv(path: Path, rows: list[dict]) -> None:
    """Helper to write a fake Breeze master file for tests."""
    fields = ["Token", "InstrumentName", "ShortName", "Series",
              "ExpiryDate", "StrikePrice", "OptionType"]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


class TestDailyRefreshCutoff:
    def test_returns_today_8am(self):
        cutoff = breeze_master._daily_refresh_cutoff()
        assert cutoff.time() == time(8, 0)
        assert cutoff.date() == datetime.now().date()


class TestIsCacheFresh:
    def test_missing_file_is_stale(self, tmp_path):
        assert breeze_master._is_cache_fresh(tmp_path / "nope.zip") is False

    def test_today_before_8am_with_file_from_yesterday_is_stale(self, tmp_path):
        zip_path = tmp_path / "master.zip"
        zip_path.write_bytes(b"x")
        import os
        yesterday = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp() - 86400
        os.utime(zip_path, (yesterday, yesterday))
        assert breeze_master._is_cache_fresh(zip_path) is False

    def test_file_from_after_today_8am_is_fresh(self, tmp_path):
        zip_path = tmp_path / "master.zip"
        zip_path.write_bytes(b"x")
        nine_am_today = datetime.combine(datetime.now().date(), time(9, 0))
        import os
        ts = nine_am_today.timestamp()
        os.utime(zip_path, (ts, ts))
        assert breeze_master._is_cache_fresh(zip_path) is True

    def test_file_from_before_today_8am_is_stale(self, tmp_path):
        zip_path = tmp_path / "master.zip"
        zip_path.write_bytes(b"x")
        seven_am_today = datetime.combine(datetime.now().date(), time(7, 0))
        import os
        ts = seven_am_today.timestamp()
        os.utime(zip_path, (ts, ts))
        assert breeze_master._is_cache_fresh(zip_path) is False


class TestEnsureDownloaded:
    def test_uses_existing_txt_when_fresh(self, tmp_path, monkeypatch):
        master_txt = tmp_path / "FOBSEScripMaster.txt"
        master_txt.write_text("Token\n1\n")
        zip_path = tmp_path / "SecurityMaster.zip"
        zip_path.write_bytes(b"zip")

        monkeypatch.setattr(breeze_master, "_master_cache_dir", lambda: tmp_path)
        with patch.object(breeze_master, "_is_cache_fresh", return_value=True):
            result = breeze_master.ensure_security_master_downloaded("BFO")
        assert result == master_txt

    def test_downloads_when_cache_stale(self, tmp_path, monkeypatch):
        master_txt = tmp_path / "FOBSEScripMaster.txt"
        zip_path = tmp_path / "SecurityMaster.zip"
        # Create a real zip with the target file inside
        import zipfile
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("FOBSEScripMaster.txt", "Token\n123\n")

        monkeypatch.setattr(breeze_master, "_master_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(breeze_master, "_is_cache_fresh", lambda _p: False)
        with patch("urllib.request.urlretrieve", return_value=None):
            result = breeze_master.ensure_security_master_downloaded("BFO")
        assert result == master_txt
        assert master_txt.exists()


class TestLoadSecurityMaster:
    def test_returns_empty_when_no_master(self, tmp_path, monkeypatch):
        monkeypatch.setattr(breeze_master, "_master_cache_dir", lambda: tmp_path)
        monkeypatch.setattr(
            breeze_master, "ensure_security_master_downloaded", lambda _x: None,
        )
        result = breeze_master.load_breeze_security_master(
            stock_code="BSESEN", exchange_code="BFO",
            strike=77000, right="CE", expiry_breeze="20-Aug-2026",
        )
        assert result == {}

    def test_matches_requested_strike_right_expiry(self, tmp_path):
        master_txt = tmp_path / "FOBSEScripMaster.txt"
        _write_master_csv(master_txt, [
            {"Token": "111", "ShortName": "BSESEN", "Series": "OPTION",
             "ExpiryDate": "20-Aug-2026", "StrikePrice": "77000", "OptionType": "CE"},
            {"Token": "222", "ShortName": "BSESEN", "Series": "OPTION",
             "ExpiryDate": "20-Aug-2026", "StrikePrice": "77000", "OptionType": "PE"},
            {"Token": "333", "ShortName": "BSESEN", "Series": "OPTION",
             "ExpiryDate": "27-Aug-2026", "StrikePrice": "77000", "OptionType": "CE"},
            {"Token": "444", "ShortName": "BSESEN", "Series": "OPTION",
             "ExpiryDate": "20-Aug-2026", "StrikePrice": "77100", "OptionType": "CE"},
            {"Token": "555", "ShortName": "NIFTY", "Series": "OPTION",
             "ExpiryDate": "20-Aug-2026", "StrikePrice": "77000", "OptionType": "CE"},
        ])

        with patch.object(breeze_master, "_master_txt_path", return_value=master_txt):
            result = breeze_master.load_breeze_security_master(
                stock_code="BSESEN", exchange_code="BFO",
                strike=77000, right="CE", expiry_breeze="20-Aug-2026",
            )
        assert result == {"111": (77000, "CE")}

        with patch.object(breeze_master, "_master_txt_path", return_value=master_txt):
            result = breeze_master.load_breeze_security_master(
                stock_code="BSESEN", exchange_code="BFO",
                strike=77000, right="PE", expiry_breeze="20-Aug-2026",
            )
        assert result == {"222": (77000, "PE")}