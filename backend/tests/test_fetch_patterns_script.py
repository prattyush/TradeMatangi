"""scripts/fetch-patterns-data.py: argument rules, the days it visits and what it does for one day (all with fake providers)."""
import datetime as dt
import importlib.util
import json
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fetch_patterns_data", ROOT / "scripts" / "fetch-patterns-data.py")
script = importlib.util.module_from_spec(spec)
sys.modules["fetch_patterns_data"] = script
spec.loader.exec_module(script)


class TokenError(Exception):
    pass


class FakeDeps:
    """Records every call; behaviour is set per test."""

    def __init__(self):
        self.BreezeTokenError = TokenError
        self.calls: list[tuple] = []
        self.missing: set[tuple] = set()          # (kind, date) with no data
        self.max_price_results: dict = {}          # (right, cap) -> {"strike","price"} or an exception
        self.spot = 24_513.4
        self.token_error_on: str | None = None
        self.strike_interval = {"NIFTY": 50, "BSESEN": 100}
        self.expiries: dict = {}

    def candle_records(self, symbol, date, interval, days_back, **contract):
        self.calls.append(("candles", symbol, date, interval, days_back, contract.get("right"), contract.get("strike"), contract.get("expiry")))
        if self.token_error_on == date:
            raise TokenError("expired")
        if ("underlying" if not contract else contract["right"], date) in self.missing:
            raise FileNotFoundError("no data")
        return [{"time": 1}] * (375 if not contract else 300)

    def load_minute(self, symbol, date, *args):
        self.calls.append(("load", symbol, date))
        return SimpleNamespace(date=date)

    def price_at(self, result, date, reference):
        self.calls.append(("price_at", date, str(reference)))
        return self.spot

    def find_max_price_strike(self, symbol, date, expiry, right, cap, reference_time):
        self.calls.append(("max_price", symbol, date, expiry, right, cap, reference_time))
        found = self.max_price_results.get((right, cap), {"strike": 24_300 if right == "CE" else 24_700, "price": 48.5})
        if isinstance(found, Exception):
            raise found
        return found

    def get_expiry_date(self, symbol, date):
        return self.expiries.get(date, "2026-11-17")

    def get_atm_strike(self, symbol, price):
        return round(price / 50) * 50


def args_for(*extra):
    return script.build_parser().parse_args(list(extra))


def plan_for(*extra):
    return script.make_plan(args_for(*extra))


# ------------------------------------------------------------------ arguments and dates
def test_max_price_is_limited_to_the_four_values_and_needs_one():
    for good in ("30", "50", "75", "100"):
        assert plan_for("--mode", "max-price", "--max-price", good).cap_ce == float(good)
    for bad in ("40", "0", "150", "abc"):
        with pytest.raises(SystemExit):
            args_for("--mode", "max-price", "--max-price", bad)
    with pytest.raises(SystemExit):
        plan_for("--mode", "max-price")


def test_pe_cap_defaults_to_the_ce_cap_and_can_differ():
    plan = plan_for("--mode", "max-price", "--max-price", "50")
    assert (plan.cap_ce, plan.cap_pe) == (50.0, 50.0)
    plan = plan_for("--mode", "max-price", "--max-price", "50", "--max-price-pe", "30")
    assert (plan.cap_ce, plan.cap_pe) == (50.0, 30.0)


def test_max_price_mode_is_for_the_indices_only_but_otm_takes_any_symbol():
    with pytest.raises(SystemExit):
        plan_for("--mode", "max-price", "--max-price", "50", "--symbol", "RELIND")
    assert plan_for("--mode", "max-price", "--max-price", "50", "--symbol", "bsesen").symbol == "BSESEN"
    assert plan_for("--mode", "otm", "--symbol", "RELIND").mode == "otm"


def test_default_times_are_0930_and_the_range_is_three_months_ending_yesterday(monkeypatch):
    plan = plan_for("--mode", "otm")
    assert plan.pick_time == "09:30:00" and plan.atm_time == "09:30:00" and plan.context_days == 2 and plan.offset == 0
    assert plan.end == script.last_completed_day()
    assert 88 <= (plan.end - plan.start).days <= 94
    assert 118 <= (plan_for("--mode", "otm", "--months", "4").end - plan_for("--mode", "otm", "--months", "4").start).days <= 124


def test_explicit_start_and_end_and_bad_ranges():
    plan = plan_for("--mode", "otm", "--start", "2026-08-01", "--end", "2026-08-31")
    assert (plan.start, plan.end) == (dt.date(2026, 8, 1), dt.date(2026, 8, 31))
    with pytest.raises(SystemExit):
        plan_for("--mode", "otm", "--start", "2026-09-01", "--end", "2026-08-01")
    with pytest.raises(SystemExit):
        args_for("--mode", "otm", "--start", "01-08-2026")
    with pytest.raises(SystemExit):
        plan_for("--mode", "otm", "--context-days", "40")


def test_times_are_accepted_as_hh_mm_or_hh_mm_ss():
    assert script.parse_time("9:30") == "09:30:00" and script.parse_time("09:15:30") == "09:15:30"
    for bad in ("25:00", "09-30", "930", "09:61"):
        with pytest.raises(Exception):
            script.parse_time(bad)


def test_only_trading_days_are_visited():
    from app.utils import is_trading_day
    days = script.trading_days(dt.date(2026, 11, 6), dt.date(2026, 11, 16), is_trading_day)
    assert "2026-11-07" not in days and "2026-11-08" not in days  # a weekend
    assert days[0] == "2026-11-06" and days[-1] == "2026-11-16"
    assert all(dt.date.fromisoformat(d).weekday() < 5 for d in days)


# ------------------------------------------------------------------ one day
def test_max_price_day_fetches_underlying_then_the_picked_ce_and_pe_with_context_days():
    deps = FakeDeps()
    plan = plan_for("--mode", "max-price", "--max-price", "50", "--max-price-pe", "30")
    result = script.run_day(plan, "2026-11-12", deps)
    assert result.status == "ok" and (result.ce, result.pe) == (24_300, 24_700) and result.expiry == "2026-11-17"
    assert result.ce_premium == 48.5 and result.bars == {"underlying": 375, "CE": 300, "PE": 300}
    picks = [c for c in deps.calls if c[0] == "max_price"]
    assert picks == [("max_price", "NIFTY", "2026-11-12", "2026-11-17", "CE", 50.0, "09:30:00"), ("max_price", "NIFTY", "2026-11-12", "2026-11-17", "PE", 30.0, "09:30:00")]
    candles = [c for c in deps.calls if c[0] == "candles"]
    assert candles[0][5:] == (None, None, None) and all(c[4] == 2 and c[3] == 1 for c in candles)  # one-minute candles, two context days
    assert candles[1][5:] == ("CE", 24_300, "2026-11-17") and candles[2][5:] == ("PE", 24_700, "2026-11-17")


def test_otm_day_takes_atm_from_the_0930_price_and_offsets_both_sides():
    deps = FakeDeps()
    result = script.run_day(plan_for("--mode", "otm", "--otm-offset", "2"), "2026-11-12", deps)
    assert result.status == "ok" and result.price == 24_513.4
    assert (result.ce, result.pe) == (24_500 + 2 * 50, 24_500 - 2 * 50)
    assert ("price_at", "2026-11-12", str(pd.Timestamp("2026-11-12 09:30:00", tz="UTC"))) in deps.calls
    assert not any(c[0] == "max_price" for c in deps.calls)


def test_otm_atm_time_can_follow_the_patterns_screen():
    deps = FakeDeps()
    script.run_day(plan_for("--mode", "otm", "--atm-time", "9:15"), "2026-11-12", deps)
    assert ("price_at", "2026-11-12", str(pd.Timestamp("2026-11-12 09:15:00", tz="UTC"))) in deps.calls
    deps = FakeDeps()
    result = script.run_day(plan_for("--mode", "otm", "--otm-offset", "-1"), "2026-11-12", deps)
    assert (result.ce, result.pe) == (24_450, 24_550)  # a negative offset is ITM


def test_a_day_without_underlying_data_is_skipped_and_asks_for_nothing_else():
    deps = FakeDeps(); deps.missing.add(("underlying", "2026-11-12"))
    result = script.run_day(plan_for("--mode", "max-price", "--max-price", "50"), "2026-11-12", deps)
    assert result.status == "no_data" and len([c for c in deps.calls if c[0] == "candles"]) == 1
    assert not any(c[0] == "max_price" for c in deps.calls)


def test_a_side_with_no_strike_under_the_cap_leaves_the_day_partial_not_failed():
    deps = FakeDeps(); deps.max_price_results[("PE", 30.0)] = ValueError("No observed premium at or below the cap within 30 strikes")
    result = script.run_day(plan_for("--mode", "max-price", "--max-price", "30"), "2026-11-12", deps)
    assert result.status == "partial" and result.ce == 24_300 and result.pe is None and "PE:" in result.note
    assert result.bars == {"underlying": 375, "CE": 300}


def test_a_provider_failure_on_one_contract_does_not_stop_the_day():
    deps = FakeDeps(); deps.missing.add(("CE", "2026-11-12"))
    result = script.run_day(plan_for("--mode", "max-price", "--max-price", "50"), "2026-11-12", deps)
    assert result.status == "partial" and result.bars == {"underlying": 375, "PE": 300} and "CE: no data" in result.note


def test_an_expired_breeze_session_aborts_with_a_clear_message():
    deps = FakeDeps(); deps.token_error_on = "2026-11-12"
    with pytest.raises(script.Abort, match="Breeze session has expired"):
        script.run_day(plan_for("--mode", "otm"), "2026-11-12", deps)
    deps = FakeDeps(); deps.max_price_results[("CE", 50.0)] = TokenError("expired")
    with pytest.raises(script.Abort):
        script.run_day(plan_for("--mode", "max-price", "--max-price", "50"), "2026-11-12", deps)


# ------------------------------------------------------------------ the run
def test_run_visits_every_day_reports_and_keeps_going(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(script, "count_minute_files", lambda: 0)
    deps = FakeDeps(); deps.missing.add(("underlying", "2026-11-12"))
    report = tmp_path / "report.json"
    args = args_for("--mode", "otm", "--report", str(report))
    results, code = script.run(plan_for("--mode", "otm"), args, deps, days=["2026-11-11", "2026-11-12", "2026-11-13"], sleep=lambda s: None)
    assert code == 0 and [r.status for r in results] == ["ok", "no_data", "ok"]
    out = capsys.readouterr().out
    assert "[3/3]" in out and "2 days complete" in out and "1 without data" in out
    assert [r["date"] for r in json.loads(report.read_text())] == ["2026-11-11", "2026-11-12", "2026-11-13"]


def test_run_stops_after_repeated_failures_and_on_an_expired_session(monkeypatch, capsys):
    monkeypatch.setattr(script, "count_minute_files", lambda: 0)

    class Failing(FakeDeps):
        def candle_records(self, *args, **contract):
            raise RuntimeError("Historical provider failed")

    days = [f"2026-11-{d:02d}" for d in range(2, 14)]
    results, code = script.run(plan_for("--mode", "otm"), args_for("--mode", "otm", "--max-failures", "3"), Failing(), days=days, sleep=lambda s: None)
    assert code == 2 and len(results) == 3 and "3 days in a row failed" in capsys.readouterr().err
    deps = FakeDeps(); deps.token_error_on = "2026-11-03"
    results, code = script.run(plan_for("--mode", "otm"), args_for("--mode", "otm"), deps, days=["2026-11-02", "2026-11-03", "2026-11-04"], sleep=lambda s: None)
    assert code == 2 and [r.date for r in results] == ["2026-11-02"] and "Breeze session has expired" in capsys.readouterr().err


def test_dry_run_requests_nothing(capsys):
    deps = FakeDeps()
    results, code = script.run(plan_for("--mode", "otm", "--start", "2026-11-11", "--end", "2026-11-13"), args_for("--mode", "otm", "--dry-run"), deps, sleep=lambda s: None)
    assert results == [] and code == 0 and deps.calls == []
    assert "would fetch 2026-11-11" in capsys.readouterr().out


def test_it_refuses_to_start_while_the_backend_port_is_in_use(capsys):
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0)); server.listen(1)
        port = server.getsockname()[1]
        assert script.backend_running(port) is True
        assert script.main(["--mode", "otm", "--port", str(port), "--start", "2026-11-11", "--end", "2026-11-11"]) == 3
        assert "stop the backend" in capsys.readouterr().err
    assert script.backend_running(port) is False


def test_the_script_only_uses_minute_data_paths():
    text = (ROOT / "scripts" / "fetch-patterns-data.py").read_text()
    for forbidden in ("fetch_historical", "fetch_options_historical", "load_history", "_ensure_data", "load_dataframe", "ws_connect"):
        assert forbidden not in text.replace("(a Breeze tick)", "")
