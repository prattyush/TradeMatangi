import pytest
from app.utils import prior_trading_days


class TestPriorTradingDays:
    def test_skips_weekend_saturday(self):
        # 2026-05-06 is Wednesday; prior 2 trading days = Mon 05-04, Tue 05-05
        result = prior_trading_days("2026-05-06", n=2)
        assert result == ["2026-05-04", "2026-05-05"]

    def test_skips_weekend_monday(self):
        # 2026-05-04 is Monday; 2026-05-01 is Maharashtra Day (holiday) so
        # prior 2 trading days = Wed 04-29, Thu 04-30
        result = prior_trading_days("2026-05-04", n=2)
        assert result == ["2026-04-29", "2026-04-30"]

    def test_skips_nse_holiday(self):
        # 2026-06-01 is Monday; 2026-05-28 (Thu) is Eid ul-Adha, 05-30 (Sat) and 05-31 (Sun) are weekend
        # prior 2 trading days = Wed 05-27, Fri 05-29
        result = prior_trading_days("2026-06-01", n=2)
        assert result == ["2026-05-27", "2026-05-29"]

    def test_skips_weekend_spans_week_boundary(self):
        # 2026-05-11 is Monday; prior 2 = Thu 05-07, Fri 05-08
        result = prior_trading_days("2026-05-11", n=2)
        assert result == ["2026-05-07", "2026-05-08"]

    def test_returns_n_results(self):
        result = prior_trading_days("2026-05-06", n=5)
        assert len(result) == 5

    def test_chronological_order(self):
        result = prior_trading_days("2026-05-06", n=3)
        assert result == sorted(result)

    def test_default_n_is_2(self):
        result = prior_trading_days("2026-05-06")
        assert len(result) == 2
