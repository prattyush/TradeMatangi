"""The live-volume probe script (scripts/probe-live-volume.py): its recording and summary logic only.

The broker connections need real sessions and market hours, so they are not tested here.
"""
import importlib.util
from datetime import datetime
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "probe-live-volume.py"


def load():
    spec = importlib.util.spec_from_file_location("probe_live_volume", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stream(report, provider, phase, label):
    return next(r for r in report if (r["provider"], r["phase"], r["instrument"]) == (provider, phase, label))


def test_cumulative_total_is_told_apart_from_per_trade_quantity():
    probe = load()
    rec = probe.Recorder()
    for day_total, last_qty in [(1000, 50), (1000, 20), (1250, 250), (1300, 50), (1300, 7)]:
        rec.add("kite", "mode_quote", "stock X", {"last_price": 10.0, "volume_traded": day_total, "last_traded_quantity": last_qty})
    row = stream(rec.report(), "kite", "mode_quote", "stock X")
    fields = row["volume_like_fields"]
    assert row["ticks"] == 5
    assert fields["volume_traded"]["cumulative_like"] is True
    assert fields["volume_traded"]["first"] == 1000 and fields["volume_traded"]["last"] == 1300
    assert fields["last_traded_quantity"]["cumulative_like"] is False
    assert fields["last_traded_quantity"]["decreases"] > 0
    assert "last_price" not in fields


def test_ltp_payload_without_volume_reports_no_volume_like_field():
    probe = load()
    rec = probe.Recorder()
    for price in (10.0, 10.05, 10.1):
        rec.add("kite", "mode_ltp", "index NIFTY", {"instrument_token": 256265, "last_price": price})
    row = stream(rec.report(), "kite", "mode_ltp", "index NIFTY")
    assert row["volume_like_fields"] == {}
    assert row["keys"] == ["instrument_token", "last_price"]


def test_constant_field_is_flagged_and_names_are_matched_case_insensitively():
    probe = load()
    rec = probe.Recorder()
    for _ in range(3):
        rec.add("fyers", "default", "NSE:X-EQ", {"ltp": 5, "vol_traded_today": 900, "OI": 40})
    fields = stream(rec.report(), "fyers", "default", "NSE:X-EQ")["volume_like_fields"]
    assert fields["vol_traded_today"]["constant"] is True
    assert fields["vol_traded_today"]["cumulative_like"] is False
    assert "OI" in fields


def test_payloads_are_made_json_safe_and_samples_are_capped():
    probe = load()
    rec = probe.Recorder()
    for i in range(10):
        rec.add("kite", "mode_full", "stock X", {"exchange_timestamp": datetime(2026, 11, 16, 9, 15, i), "volume_traded": i})
    row = stream(rec.report(), "kite", "mode_full", "stock X")
    assert len(row["samples"]) == probe.SAMPLES_PER_STREAM
    assert isinstance(row["samples"][0]["exchange_timestamp"], str)


def test_control_messages_without_a_dict_payload_do_not_break_recording():
    probe = load()
    rec = probe.Recorder()
    rec.add("breeze", "exchange_quotes", "unknown", "connected")
    assert stream(rec.report(), "breeze", "exchange_quotes", "unknown")["ticks"] == 1
