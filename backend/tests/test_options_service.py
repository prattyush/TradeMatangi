"""
Tests for options_service.py: expiry calculation, ATM strike, cache paths,
options data fetch, and margin computation.
"""
import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from app.services.options_service import (
    NSE_HOLIDAYS,
    _is_trading_day,
    _prev_trading_day,
    _expiry_weekday,
    get_weekly_expiry,
    get_monthly_expiry,
    get_expiry_date,
    get_atm_strike,
    options_parquet_path,
    compute_short_margin,
    _validate_options_gaps,
    _fetch_options_day_paginated,
    fetch_options_historical,
    load_options_dataframe,
    options_iter_ticks,
    get_underlying_price_at,
    STRIKE_INTERVALS,
)


# ---------------------------------------------------------------------------
# _is_trading_day / _prev_trading_day
# ---------------------------------------------------------------------------

class TestIsTradingDay:
    def test_weekday_not_holiday(self):
        assert _is_trading_day(datetime.date(2025, 5, 6)) is True  # Tuesday

    def test_saturday(self):
        assert _is_trading_day(datetime.date(2025, 5, 3)) is False  # Saturday

    def test_sunday(self):
        assert _is_trading_day(datetime.date(2025, 5, 4)) is False  # Sunday

    def test_nse_holiday(self):
        # May 1 2025 is Maharashtra Day (NSE holiday)
        assert _is_trading_day(datetime.date(2025, 5, 1)) is False

    def test_non_holiday_weekday(self):
        assert _is_trading_day(datetime.date(2025, 5, 2)) is True  # Friday, no holiday


class TestPrevTradingDay:
    def test_simple_prev_day(self):
        # Prev trading day before Thursday 2025-05-08 is Wednesday 2025-05-07
        result = _prev_trading_day(datetime.date(2025, 5, 8))
        assert result == datetime.date(2025, 5, 7)

    def test_skips_weekend(self):
        # Prev trading day before Monday 2025-05-05 should skip weekend to Friday 2025-05-02
        result = _prev_trading_day(datetime.date(2025, 5, 5))
        assert result == datetime.date(2025, 5, 2)

    def test_skips_holiday(self):
        # May 1 is a holiday; prev trading day before May 2 (Friday) should be Apr 30 (Wednesday)
        result = _prev_trading_day(datetime.date(2025, 5, 2))
        assert result == datetime.date(2025, 4, 30)


# ---------------------------------------------------------------------------
# _expiry_weekday
# ---------------------------------------------------------------------------

class TestExpiryWeekday:
    def test_before_cutoff_thursday(self):
        assert _expiry_weekday(datetime.date(2025, 8, 31)) == 3  # Thursday

    def test_on_cutoff_tuesday(self):
        assert _expiry_weekday(datetime.date(2025, 9, 1)) == 1  # Tuesday

    def test_after_cutoff_tuesday(self):
        assert _expiry_weekday(datetime.date(2026, 5, 6)) == 1  # Tuesday


# ---------------------------------------------------------------------------
# get_weekly_expiry — pre-cutoff (Thursdays)
# ---------------------------------------------------------------------------

class TestGetWeeklyExpiryPreCutoff:
    def test_from_tuesday_to_thursday(self):
        # Trading on Tuesday 2025-05-06 → next Thursday is 2025-05-08
        assert get_weekly_expiry("2025-05-06") == "2025-05-08"

    def test_from_expiry_day_itself(self):
        # Trading on Thursday 2025-05-08 (expiry day) → same day
        assert get_weekly_expiry("2025-05-08") == "2025-05-08"

    def test_day_after_expiry(self):
        # Trading on Friday 2025-05-09 → next Thursday 2025-05-15
        assert get_weekly_expiry("2025-05-09") == "2025-05-15"

    def test_holiday_shifts_back(self):
        # Oct 2 2025 is Thursday AND NSE holiday (Gandhi Jayanti / Dussehra)
        # BUT Oct 2025 is AFTER cutoff (Sep 1), so expiry weekday is Tuesday
        # Let's use a pre-cutoff holiday on Thursday instead
        # Aug 15 2025 is Friday (Independence Day) — not a Thursday
        # Use Mar 31 2025 (Monday, Eid) - not a Thursday
        # Manually check: in 2025, Thursdays: let's check if any holiday falls on Thursday pre-cutoff
        # Feb 26 2025 is Wednesday (Mahashivratri), not Thursday
        # Mar 14 2025 is Friday (Holi), not Thursday
        # Apr 18 2025 is Friday (Good Friday), not Thursday
        # Aug 27 2025 is Wednesday (Ganesh Chaturthi), not Thursday
        # So no pre-cutoff Thursday holiday in our list. Use a synthetic test via patching.
        from unittest.mock import patch
        # Fake that 2025-05-08 (Thursday) is a holiday
        fake_holidays = NSE_HOLIDAYS | {datetime.date(2025, 5, 8)}
        with patch("app.utils.NSE_HOLIDAYS", fake_holidays):
            result = get_weekly_expiry("2025-05-06")
        # Should shift to Wednesday 2025-05-07
        assert result == "2025-05-07"


# ---------------------------------------------------------------------------
# get_weekly_expiry — post-cutoff (Tuesdays)
# ---------------------------------------------------------------------------

class TestGetWeeklyExpiryPostCutoff:
    def test_from_monday_to_tuesday(self):
        # Trading on Monday 2025-09-15 → next Tuesday is 2025-09-16
        assert get_weekly_expiry("2025-09-15") == "2025-09-16"

    def test_from_expiry_day_itself(self):
        # Trading on Tuesday 2025-09-16 → same day
        assert get_weekly_expiry("2025-09-16") == "2025-09-16"

    def test_day_after_expiry(self):
        # Trading on Wednesday 2025-09-17 → next Tuesday 2025-09-23
        assert get_weekly_expiry("2025-09-17") == "2025-09-23"

    def test_holiday_shifts_back(self):
        # Oct 21 2025 is Tuesday AND a holiday (Diwali Laxmi Puja)
        # Trading on Monday Oct 20 → expiry would be Oct 21, but it's a holiday
        # Should shift to Monday Oct 20
        result = get_weekly_expiry("2025-10-20")
        assert result == "2025-10-20"

    def test_holiday_on_expiry_day_shifts_to_previous(self):
        # Trading on 2025-10-19 (Sunday... actually use Oct 17 Friday)
        # Oct 21 is Tuesday holiday; trading from Oct 17 → expiry shifts from Oct 21 to Oct 20
        result = get_weekly_expiry("2025-10-17")
        assert result == "2025-10-20"


# ---------------------------------------------------------------------------
# BSESEN expiry — always Thursday regardless of cutoff date
# ---------------------------------------------------------------------------

class TestBSESENExpiry:
    def test_weekday_always_thursday_before_cutoff(self):
        assert _expiry_weekday(datetime.date(2025, 8, 31), "BSESEN") == 3

    def test_weekday_always_thursday_after_cutoff(self):
        # Post-cutoff NIFTY switches to Tuesday, but BSESEN stays Thursday
        assert _expiry_weekday(datetime.date(2025, 9, 1), "BSESEN") == 3
        assert _expiry_weekday(datetime.date(2026, 5, 6), "BSESEN") == 3

    def test_weekly_expiry_thursday_post_cutoff(self):
        # 2025-09-15 (Monday) → next Thursday is 2025-09-18 (NIFTY would be Tuesday)
        assert get_weekly_expiry("2025-09-15", "BSESEN") == "2025-09-18"

    def test_weekly_expiry_on_thursday_itself(self):
        # Thursday 2025-09-18 → same day
        assert get_weekly_expiry("2025-09-18", "BSESEN") == "2025-09-18"

    def test_weekly_expiry_day_after_thursday(self):
        # Friday 2025-09-19 → next Thursday 2025-09-25
        assert get_weekly_expiry("2025-09-19", "BSESEN") == "2025-09-25"

    def test_get_expiry_date_routes_to_weekly(self):
        # get_expiry_date for BSESEN should return the next Thursday
        result = get_expiry_date("BSESEN", "2025-09-15")
        assert result == "2025-09-18"


# ---------------------------------------------------------------------------
# get_monthly_expiry — pre-cutoff (last Thursday of month)
# ---------------------------------------------------------------------------

class TestGetMonthlyExpiryPreCutoff:
    def test_may_2025(self):
        # May 2025 Thursdays: 1, 8, 15, 22, 29. Last = May 29.
        # May 1 is a holiday, but last Thursday is May 29 (not a holiday)
        assert get_monthly_expiry("2025-05-01") == "2025-05-29"

    def test_august_2025(self):
        # Aug 2025 Thursdays: 7, 14, 21, 28. Last = Aug 28.
        # Aug 15 and Aug 27 are holidays (Independence Day, Ganesh Chaturthi)
        # Aug 28 is the last Thursday — not in NSE_HOLIDAYS
        assert get_monthly_expiry("2025-08-01") == "2025-08-28"

    def test_mid_month_same_result(self):
        # From mid-May, monthly expiry is still the last Thursday of May
        assert get_monthly_expiry("2025-05-15") == "2025-05-29"


# ---------------------------------------------------------------------------
# get_monthly_expiry — post-cutoff (last Tuesday of month)
# ---------------------------------------------------------------------------

class TestGetMonthlyExpiryPostCutoff:
    def test_september_2025(self):
        # Sep 2025 Tuesdays: 2, 9, 16, 23, 30. Last = Sep 30. Not a holiday.
        assert get_monthly_expiry("2025-09-01") == "2025-09-30"

    def test_october_2025(self):
        # Oct 2025 Tuesdays: 7, 14, 21, 28. Last = Oct 28. Not a holiday.
        # Oct 21 is a holiday but Oct 28 is not.
        assert get_monthly_expiry("2025-10-01") == "2025-10-28"

    def test_december_2025(self):
        # Dec 2025 Tuesdays: 2, 9, 16, 23, 30. Last = Dec 30. Not a holiday.
        assert get_monthly_expiry("2025-12-01") == "2025-12-30"


# ---------------------------------------------------------------------------
# get_expiry_date (dispatches to weekly / monthly)
# ---------------------------------------------------------------------------

class TestGetExpiryDate:
    def test_nifty_weekly_pre_cutoff(self):
        assert get_expiry_date("NIFTY", "2025-05-06") == "2025-05-08"

    def test_nifty_weekly_post_cutoff(self):
        assert get_expiry_date("NIFTY", "2025-09-15") == "2025-09-16"

    def test_equity_monthly_pre_cutoff(self):
        assert get_expiry_date("TATPOW", "2025-05-06") == "2025-05-29"

    def test_equity_monthly_post_cutoff(self):
        assert get_expiry_date("RELIND", "2025-09-01") == "2025-09-30"

    def test_equity_rolls_to_next_month(self):
        # If trading date is after the monthly expiry, roll to next month.
        # May 2025 last Thursday = May 29. If trading on May 30:
        # monthly_expiry("2025-05-30") gives May 29, which is < May 30.
        # So we need June's last Thursday.
        # June 2025 Thursdays: 5, 12, 19, 26. Last = June 26.
        result = get_expiry_date("TATMOT", "2025-05-30")
        assert result == "2025-06-26"

    def test_nifty_on_expiry_day(self):
        # On expiry day itself, the contract is still the current one
        assert get_expiry_date("NIFTY", "2025-05-08") == "2025-05-08"


# ---------------------------------------------------------------------------
# get_atm_strike
# ---------------------------------------------------------------------------

class TestGetAtmStrike:
    def test_nifty_at_exact_strike(self):
        assert get_atm_strike("NIFTY", 24000.0) == 24000

    def test_nifty_rounds_down(self):
        # 24024 → nearest 50 is 24000
        assert get_atm_strike("NIFTY", 24024.0) == 24000

    def test_nifty_rounds_up(self):
        # 24026 → nearest 50 is 24050
        assert get_atm_strike("NIFTY", 24026.0) == 24050

    def test_nifty_otm_offset(self):
        # ATM=24000, +2 OTM call = 24000 + 2*50 = 24100
        assert get_atm_strike("NIFTY", 24000.0, offset=2) == 24100

    def test_nifty_itm_offset(self):
        # ATM=24000, -3 ITM = 24000 - 3*50 = 23850
        assert get_atm_strike("NIFTY", 24000.0, offset=-3) == 23850

    def test_equity_interval_5(self):
        assert get_atm_strike("TATPOW", 420.5) == 420

    def test_equity_rounds_up(self):
        # 423 → nearest 5 is 425
        assert get_atm_strike("TATPOW", 423.0) == 425

    def test_equity_otm_offset(self):
        # ATM=420, +1 = 425
        assert get_atm_strike("RELIND", 420.0, offset=1) == 425

    def test_relind_interval(self):
        assert STRIKE_INTERVALS["RELIND"] == 5

    def test_tatmot_interval(self):
        assert STRIKE_INTERVALS["TATMOT"] == 5


# ---------------------------------------------------------------------------
# options_parquet_path
# ---------------------------------------------------------------------------

class TestOptionsParquetPath:
    def test_ce_path(self, tmp_path):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            p = opq("NIFTY", "2026-05-06", 24000, "2026-05-19", "CE")
        assert p.name == "NIFTY-CE-24000-19-05-2026-06-05-2026.parquet"

    def test_pe_path(self, tmp_path):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            p = opq("NIFTY", "2026-05-06", 24000, "2026-05-19", "PE")
        assert p.name == "NIFTY-PE-24000-19-05-2026-06-05-2026.parquet"

    def test_call_alias(self, tmp_path):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            p = opq("TATPOW", "2026-05-06", 420, "2026-05-28", "CALL")
        assert p.name == "TATPOW-CE-420-28-05-2026-06-05-2026.parquet"

    def test_put_alias(self, tmp_path):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            p = opq("RELIND", "2026-05-06", 1400, "2026-05-28", "PUT")
        assert p.name == "RELIND-PE-1400-28-05-2026-06-05-2026.parquet"


# ---------------------------------------------------------------------------
# compute_short_margin
# ---------------------------------------------------------------------------

class TestComputeShortMargin:
    def test_nifty_margin(self):
        # NIFTY lot=65, price=24000 → 24000 * 65 * 0.20 = 312000
        assert compute_short_margin("NIFTY", 24000.0) == pytest.approx(312000.0)

    def test_tatpow_margin(self):
        # TATPOW lot=2700, price=450 → 450 * 2700 * 0.20 = 243000
        assert compute_short_margin("TATPOW", 450.0) == pytest.approx(243000.0)

    def test_relind_margin(self):
        # RELIND lot=250, price=1500 → 1500 * 250 * 0.20 = 75000
        assert compute_short_margin("RELIND", 1500.0) == pytest.approx(75000.0)

    def test_tatmot_margin(self):
        # TATMOT lot=1400, price=800 → 800 * 1400 * 0.20 = 224000
        assert compute_short_margin("TATMOT", 800.0) == pytest.approx(224000.0)


# ---------------------------------------------------------------------------
# _validate_options_gaps
# ---------------------------------------------------------------------------

class TestValidateOptionsGaps:
    def _make_df(self, date: str, start_time: str, end_time: str, price: float = 100.0) -> pd.DataFrame:
        idx = pd.date_range(
            start=f"{date} {start_time}", end=f"{date} {end_time}", freq="1s"
        )
        return pd.DataFrame(
            {"open": price, "high": price, "low": price, "close": price}, index=idx
        )

    def test_fills_full_day(self):
        df = self._make_df("2026-05-06", "09:15:00", "12:00:00")
        result = _validate_options_gaps(df, "2026-05-06")
        market_open = pd.Timestamp("2026-05-06 09:15:00")
        market_close = pd.Timestamp("2026-05-06 15:29:59")
        assert result.index[0] == market_open
        assert result.index[-1] == market_close

    def test_bfill_leading_gap(self):
        # Data starts at 10:00 — rows 09:15-09:59 should be backward-filled
        df = self._make_df("2026-05-06", "10:00:00", "15:29:59", price=200.0)
        result = _validate_options_gaps(df, "2026-05-06")
        assert result.loc[pd.Timestamp("2026-05-06 09:15:00"), "close"] == pytest.approx(200.0)

    def test_ffill_trailing_gap(self):
        # Data ends at 14:00 — rows 14:00-15:29 should be forward-filled
        df = self._make_df("2026-05-06", "09:15:00", "14:00:00", price=150.0)
        result = _validate_options_gaps(df, "2026-05-06")
        assert result.loc[pd.Timestamp("2026-05-06 15:29:59"), "close"] == pytest.approx(150.0)

    def test_empty_raises(self):
        df = pd.DataFrame(columns=["open", "high", "low", "close"])
        with pytest.raises(RuntimeError, match="No options data"):
            _validate_options_gaps(df, "2026-05-06")

    def test_partial_stops_at_last_row(self):
        # partial=True: reindex should stop at last actual data row, not market_close
        df = self._make_df("2026-05-06", "09:15:00", "10:39:00")
        result = _validate_options_gaps(df, "2026-05-06", partial=True)
        assert result.index[-1] == pd.Timestamp("2026-05-06 10:39:00")
        market_close = pd.Timestamp("2026-05-06 15:29:59")
        assert result.index[-1] != market_close

    def test_partial_no_flat_future_bars(self):
        # partial=True: no gap-fill beyond last actual row — no fake future bars
        df = self._make_df("2026-05-06", "09:15:00", "10:39:00", price=123.0)
        result = _validate_options_gaps(df, "2026-05-06", partial=True)
        assert pd.Timestamp("2026-05-06 10:45:00") not in result.index

    def test_non_partial_still_fills_full_day(self):
        # partial=False (default): should still fill to market_close for historical days
        df = self._make_df("2026-05-06", "09:15:00", "10:39:00")
        result = _validate_options_gaps(df, "2026-05-06", partial=False)
        assert result.index[-1] == pd.Timestamp("2026-05-06 15:29:59")


# ---------------------------------------------------------------------------
# _fetch_options_day_paginated
# ---------------------------------------------------------------------------

class TestFetchOptionsDay:
    def _make_success_response(self, n: int = 5) -> dict:
        return {
            "Status": 200,
            "Success": [
                {
                    "datetime": f"2026-05-06 09:{15 + i // 60:02d}:{i % 60:02d}",
                    "open": 100.0, "high": 102.0, "low": 98.0, "close": 101.0,
                }
                for i in range(n)
            ],
        }

    def test_makes_25_chunks(self):
        breeze = MagicMock()
        breeze.get_historical_data_v2.return_value = self._make_success_response(0)
        _fetch_options_day_paginated(breeze, "NIFTY", "2026-05-06", 24000, "2026-05-19", "CE")
        # 375 minutes / 15 = 25 chunks
        assert breeze.get_historical_data_v2.call_count == 25

    def test_passes_correct_params(self):
        breeze = MagicMock()
        breeze.get_historical_data_v2.return_value = self._make_success_response(0)
        _fetch_options_day_paginated(breeze, "NIFTY", "2026-05-06", 24000, "2026-05-19", "PE")
        first_call = breeze.get_historical_data_v2.call_args_list[0]
        kwargs = first_call.kwargs if first_call.kwargs else {}
        if not kwargs:
            kwargs = first_call[1]
        assert kwargs.get("exchange_code") == "NFO"
        assert kwargs.get("product_type") == "options"
        assert kwargs.get("strike_price") == "24000"
        assert kwargs.get("right") == "put"
        assert "2026-05-19T06:00:00.000Z" in str(kwargs.get("expiry_date", ""))

    def test_ce_right_passed_as_call(self):
        breeze = MagicMock()
        breeze.get_historical_data_v2.return_value = self._make_success_response(0)
        _fetch_options_day_paginated(breeze, "NIFTY", "2026-05-06", 24000, "2026-05-19", "CE")
        first_call = breeze.get_historical_data_v2.call_args_list[0]
        kwargs = first_call.kwargs if first_call.kwargs else first_call[1]
        assert kwargs.get("right") == "call"

    def test_token_error_on_401(self):
        from app.services.broker_service import BreezeTokenError
        breeze = MagicMock()
        breeze.get_historical_data_v2.return_value = {"Status": 401, "Error": "Unauthorized"}
        with pytest.raises(BreezeTokenError):
            _fetch_options_day_paginated(breeze, "NIFTY", "2026-05-06", 24000, "2026-05-19", "CE")

    def test_aggregates_all_chunks(self):
        breeze = MagicMock()
        breeze.get_historical_data_v2.return_value = self._make_success_response(3)
        records = _fetch_options_day_paginated(breeze, "NIFTY", "2026-05-06", 24000, "2026-05-19", "CE")
        assert len(records) == 25 * 3


# ---------------------------------------------------------------------------
# fetch_options_historical
# ---------------------------------------------------------------------------

class TestFetchOptionsHistorical:
    def _make_full_day_df(self, date: str) -> pd.DataFrame:
        idx = pd.date_range(
            start=f"{date} 09:15:00", end=f"{date} 15:29:59", freq="1s"
        )
        return pd.DataFrame(
            {"open": 100.0, "high": 102.0, "low": 98.0, "close": 101.0}, index=idx
        )

    def test_cache_hit_skips_breeze(self, tmp_path):
        date = "2026-05-06"
        df = self._make_full_day_df(date)
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            pq = opq("NIFTY", date, 24000, "2026-05-19", "CE")
            df.to_parquet(pq)
            with patch("app.services.broker_service._get_breeze") as mock_breeze:
                result = fetch_options_historical("NIFTY", date, 24000, "2026-05-19", "CE")
            mock_breeze.assert_not_called()
            assert result == pq

    def test_fetches_and_saves_on_miss(self, tmp_path):
        date = "2026-05-06"
        raw_df = self._make_full_day_df(date)
        records = [
            {
                "datetime": str(ts),
                "open": 100.0, "high": 102.0, "low": 98.0, "close": 101.0,
            }
            for ts in raw_df.index[:900]  # first 15 min worth of data
        ]
        breeze_mock = MagicMock()
        breeze_mock.get_historical_data_v2.return_value = {"Status": 200, "Success": records}

        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
             patch("app.services.broker_service._get_breeze", return_value=breeze_mock):
            result = fetch_options_historical("NIFTY", date, 24000, "2026-05-19", "CE")
            assert result.exists()
            saved = pd.read_parquet(result)
            assert not saved.empty

    def test_no_data_raises(self, tmp_path):
        breeze_mock = MagicMock()
        breeze_mock.get_historical_data_v2.return_value = {"Status": 200, "Success": []}
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
             patch("app.services.broker_service._get_breeze", return_value=breeze_mock):
            with pytest.raises(RuntimeError, match="no options data"):
                fetch_options_historical("NIFTY", "2026-05-06", 24000, "2026-05-19", "CE")

    def test_today_partial_saved_without_future_bars(self, tmp_path):
        # For today's date, parquet should stop at last actual row, not market_close.
        today = datetime.date.today().strftime("%Y-%m-%d")
        expiry = (datetime.date.today() + datetime.timedelta(days=7)).strftime("%Y-%m-%d")
        start_sec = 9 * 3600 + 15 * 60  # 09:15:00
        records = [
            {"datetime": f"{today} {(start_sec + i) // 3600:02d}:{((start_sec + i) % 3600) // 60:02d}:{(start_sec + i) % 60:02d}",
             "open": 100.0, "high": 102.0, "low": 98.0, "close": 101.0}
            for i in range(5400)  # 09:15 to 10:39:59 (90 min × 60 sec)
        ]
        breeze_mock = MagicMock()
        breeze_mock.get_historical_data_v2.return_value = {"Status": 200, "Success": records}
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
             patch("app.services.broker_service._get_breeze", return_value=breeze_mock):
            result = fetch_options_historical("NIFTY", today, 24000, expiry, "CE")
            saved = pd.read_parquet(result)
            market_close = pd.Timestamp(f"{today} 15:29:59")
            # Partial mode: last row must be at or near 10:39, not market_close
            assert saved.index[-1] < market_close

    def test_today_stale_cache_refetches(self, tmp_path):
        # Stale today parquet (> TTL) triggers a re-fetch from Breeze.
        today = datetime.date.today().strftime("%Y-%m-%d")
        expiry = (datetime.date.today() + datetime.timedelta(days=7)).strftime("%Y-%m-%d")
        records = [
            {"datetime": f"{today} 09:{15 + i // 60:02d}:{i % 60:02d}",
             "open": 200.0, "high": 202.0, "low": 198.0, "close": 201.0}
            for i in range(60)
        ]
        breeze_mock = MagicMock()
        breeze_mock.get_historical_data_v2.return_value = {"Status": 200, "Success": records}
        ohlcdata = tmp_path / "ohlcdata"
        ohlcdata.mkdir(parents=True, exist_ok=True)
        with patch("app.services.options_service.OHLCDATA_DIR", ohlcdata), \
             patch("app.services.broker_service._get_breeze", return_value=breeze_mock):
            from app.services.options_service import options_parquet_path as opq
            pq = opq("NIFTY", today, 24000, expiry, "CE")
            # Pre-write a stale parquet with old close price
            old_idx = pd.date_range(f"{today} 09:15:00", f"{today} 09:30:00", freq="1s")
            old_df = pd.DataFrame({"open": 50.0, "high": 50.0, "low": 50.0, "close": 50.0}, index=old_idx)
            old_df.to_parquet(pq)
            import os, time as _time
            os.utime(pq, (_time.time() - 700, _time.time() - 700))  # mark as 700s old (> TTL)
            result = fetch_options_historical("NIFTY", today, 24000, expiry, "CE")
            saved = pd.read_parquet(result)
            # Should have re-fetched: new data has close=201.0, not old 50.0
            assert float(saved.iloc[0]["close"]) == pytest.approx(201.0)


# ---------------------------------------------------------------------------
# load_options_dataframe
# ---------------------------------------------------------------------------

class TestLoadOptionsDataframe:
    def test_loads_and_localizes(self, tmp_path):
        date = "2026-05-06"
        idx = pd.date_range(start=f"{date} 09:15:00", end=f"{date} 15:29:59", freq="1s")
        df = pd.DataFrame({"open": 100.0, "high": 102.0, "low": 98.0, "close": 101.0}, index=idx)
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            pq = opq("NIFTY", date, 24000, "2026-05-19", "CE")
            df.to_parquet(pq)
            result = load_options_dataframe("NIFTY", date, 24000, "2026-05-19", "CE")
        assert result.index.tz is not None  # UTC label applied
        assert set(result.columns) == {"open", "high", "low", "close"}

    def test_missing_file_raises(self, tmp_path):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            with pytest.raises(FileNotFoundError):
                load_options_dataframe("NIFTY", "2026-05-06", 24000, "2026-05-19", "CE")


# ---------------------------------------------------------------------------
# options_iter_ticks
# ---------------------------------------------------------------------------

class TestOptionsIterTicks:
    def test_yields_correct_fields(self, tmp_path):
        date = "2026-05-06"
        idx = pd.date_range(start=f"{date} 09:15:00", end=f"{date} 15:29:59", freq="1s")
        df = pd.DataFrame({"open": 100.0, "high": 102.0, "low": 98.0, "close": 101.0}, index=idx)
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            pq = opq("NIFTY", date, 24000, "2026-05-19", "CE")
            df.to_parquet(pq)
            ticks = list(options_iter_ticks("NIFTY", date, 24000, "2026-05-19", "CE", "15:25:00"))
        assert len(ticks) == 5 * 60  # 5 minutes of seconds
        first = ticks[0]
        assert first["type"] == "tick"
        assert "time" in first and "open" in first and "close" in first

    def test_filters_by_start_time(self, tmp_path):
        date = "2026-05-06"
        idx = pd.date_range(start=f"{date} 09:15:00", end=f"{date} 15:29:59", freq="1s")
        df = pd.DataFrame({"open": 100.0, "high": 102.0, "low": 98.0, "close": 101.0}, index=idx)
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.options_service import options_parquet_path as opq
            pq = opq("NIFTY", date, 24000, "2026-05-19", "CE")
            df.to_parquet(pq)
            ticks_full = list(options_iter_ticks("NIFTY", date, 24000, "2026-05-19", "CE", "09:15:00"))
            ticks_late = list(options_iter_ticks("NIFTY", date, 24000, "2026-05-19", "CE", "12:00:00"))
        assert len(ticks_late) < len(ticks_full)


# ---------------------------------------------------------------------------
# get_underlying_price_at
# ---------------------------------------------------------------------------

class TestGetUnderlyingPriceAt:
    def test_returns_price_at_timestamp(self, tmp_path):
        date = "2026-05-06"
        idx = pd.date_range(start=f"{date} 09:15:00", end=f"{date} 09:20:00", freq="1s")
        # Unix timestamp for 09:15:00 on 2026-05-06 (as IST-as-UTC)
        target_ts = int(pd.Timestamp(f"{date} 09:15:00", tz="UTC").timestamp())
        df = pd.DataFrame({"open": 200.0, "high": 205.0, "low": 195.0, "close": 202.5}, index=idx)
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"), \
             patch("app.services.data_loader.DATA_DIR", tmp_path), \
             patch("app.services.data_loader.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            from app.services.data_loader import parquet_path
            pq = parquet_path("NIFTY", date)
            df.to_parquet(pq)
            price = get_underlying_price_at("NIFTY", date, target_ts)
        assert price == pytest.approx(202.5)

    def test_returns_none_when_unavailable(self, tmp_path):
        with patch("app.services.options_service.OHLCDATA_DIR", tmp_path / "ohlcdata"):
            price = get_underlying_price_at("NIFTY", "2026-05-06", 9999999999)
        assert price is None
