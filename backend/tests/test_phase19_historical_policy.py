"""Historical policy matrix, provider isolation and native cadence."""
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock
import os
import time

import pandas as pd
import pytest

from app.services import historical_data_service as history
from app.services import broker_service, data_loader, options_service, token_service, simulation
from app.routers import admin
from fastapi import HTTPException

_real_is_today = history.is_today

TODAY, PAST = "2026-10-01", "2026-09-30"


def frame(date=TODAY, freq="s", value=40):
    return pd.DataFrame({name: [value, value+1, value+2] for name in ("open", "high", "low", "close")},
        index=pd.date_range(f"{date} 09:15:00", periods=3, freq=freq))


@pytest.fixture(autouse=True)
def clean(monkeypatch, tmp_path):
    history._results.clear()
    history._last_warning.clear()
    history._policy_cache = None
    monkeypatch.setattr(history, "is_today", lambda date: date == TODAY)
    monkeypatch.setattr(token_service, "get_token", lambda key: None)
    monkeypatch.setattr(token_service, "set_token", MagicMock())
    monkeypatch.setattr(history, "_path", lambda provider, *args: tmp_path / f"{provider}.parquet")
    with history.historical_operation(mode="live"):
        yield
    history._results.clear()
    history._policy_cache = None


@pytest.mark.parametrize("source", ["breeze", "kite"])
@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("stream", ["breeze", "kite", "kotak", "fyers"])
def test_selected_today_history_is_independent_of_stream(source, fallback, stream, monkeypatch):
    from app.services import market_data
    monkeypatch.setattr(market_data, "selected_provider", lambda: stream)
    calls = []
    def fetch(provider, *args):
        calls.append(provider)
        return frame(freq="s" if provider == "breeze" else "min")
    monkeypatch.setattr(history, "_fetch", fetch)
    result = history.load_history("BSESEN", TODAY, 71200, TODAY, "PE", policy=history.HistoricalPolicy(source, fallback))
    assert calls == [source]
    assert result.actual_provider == source
    assert result.interval_seconds == (1 if source == "breeze" else 60)
    assert len(result.frame) == 3


@pytest.mark.parametrize("source", ["breeze", "kite"])
@pytest.mark.parametrize("fallback", [False, True])
def test_fallback_requires_checkbox(source, fallback, monkeypatch):
    calls = []
    other = "kite" if source == "breeze" else "breeze"
    def fetch(provider, *args):
        calls.append(provider)
        if provider == source:
            raise RuntimeError("provider unavailable")
        return frame(freq="min" if provider == "kite" else "s")
    monkeypatch.setattr(history, "_fetch", fetch)
    policy = history.HistoricalPolicy(source, fallback)
    if fallback:
        result = history.load_history("NIFTY", TODAY, policy=policy)
        assert result.actual_provider == other and result.selected_provider == source
        assert calls == [source, other]
    else:
        with pytest.raises(RuntimeError):
            history.load_history("NIFTY", TODAY, policy=policy)
        assert calls == [source]


@pytest.mark.parametrize("fallback", [False, True])
def test_replay_past_always_breeze_even_when_live_kite(fallback, monkeypatch):
    calls = []
    monkeypatch.setattr(history, "_fetch", lambda provider, *args: calls.append(provider) or frame(PAST))
    result = history.load_history("NIFTY", PAST, policy=history.HistoricalPolicy("kite", fallback), mode="replay")
    assert calls == ["breeze"] and result.interval_seconds == 1


def test_past_failure_never_falls_back_to_kite(monkeypatch):
    calls = []
    def fetch(provider, *args):
        calls.append(provider)
        raise RuntimeError("Breeze unavailable")
    monkeypatch.setattr(history, "_fetch", fetch)
    with pytest.raises(RuntimeError):
        history.load_history("NIFTY", PAST, policy=history.HistoricalPolicy("kite", True), mode="replay")
    assert calls == ["breeze"]


def test_request_freezes_policy_and_actual_result(monkeypatch):
    policy = [history.HistoricalPolicy("breeze", True)]
    monkeypatch.setattr(history, "get_policy", lambda: policy[0])
    calls = []
    def fetch(provider, *args):
        calls.append(provider)
        if provider == "breeze":
            raise RuntimeError("token expired")
        return frame(freq="min")
    monkeypatch.setattr(history, "_fetch", fetch)
    with history.historical_operation():
        first = history.load_history("NIFTY", TODAY)
        policy[0] = history.HistoricalPolicy("kite", False)
        history._results.clear()
        second = history.load_history("NIFTY", TODAY)
    assert first is second
    assert first.selected_provider == "breeze" and first.actual_provider == "kite"
    assert calls == ["breeze", "kite"]


def test_simultaneous_loads_coalesce_provider_request(monkeypatch):
    fetch = MagicMock(return_value=frame())
    monkeypatch.setattr(history, "_fetch", fetch)
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: history.load_history("NIFTY", TODAY), range(8)))
    fetch.assert_called_once()
    assert all(result is results[0] for result in results)


def test_stale_primary_prefers_fresh_alternate_only_when_enabled(monkeypatch, tmp_path):
    path = tmp_path / "breeze.parquet"
    frame().to_parquet(path)
    old = time.time() - 700
    os.utime(path, (old, old))
    calls = []
    def fetch(provider, *args):
        calls.append(provider)
        if provider == "breeze":
            raise RuntimeError("expired token")
        return frame(freq="min", value=50)
    monkeypatch.setattr(history, "_fetch", fetch)
    disabled = history.load_history("NIFTY", TODAY)
    assert disabled.actual_provider == "breeze" and disabled.stale
    enabled = history.load_history("NIFTY", TODAY, policy=history.HistoricalPolicy("breeze", True))
    assert enabled.actual_provider == "kite" and not enabled.stale
    assert calls == ["breeze", "breeze", "kite"]


def test_selected_provider_file_is_not_overwritten(monkeypatch, tmp_path):
    breeze_path = tmp_path / "breeze.parquet"
    frame(value=71000).to_parquet(breeze_path)
    monkeypatch.setattr(history, "_fetch", lambda provider, *args: frame(freq="min", value=40))
    result = history.load_history("BSESEN", TODAY, 71200, TODAY, "PE", policy=history.HistoricalPolicy("kite"))
    assert result.frame.iloc[0]["close"] == 40
    assert pd.read_parquet(breeze_path).iloc[0]["close"] == 71000
    assert result.path != breeze_path


def test_native_minute_ticks_do_not_expand_and_gap_helper_uses_policy(monkeypatch):
    monkeypatch.setattr(history, "get_policy", lambda: history.HistoricalPolicy("kite"))
    monkeypatch.setattr(history, "_fetch", lambda *args: frame(freq="min"))
    ticks = list(data_loader.iter_ticks("NIFTY", TODAY))
    assert len(ticks) == 3
    assert ticks[1]["time"] - ticks[0]["time"] == 60
    gap = simulation._historical_gap_ticks("NIFTY", TODAY, ticks[0]["time"])
    assert [tick["time"] for tick in gap] == [tick["time"] for tick in ticks[1:]]


def test_existing_equity_and_option_entrypoints_share_selected_frame(monkeypatch):
    monkeypatch.setattr(history, "get_policy", lambda: history.HistoricalPolicy("kite"))
    fetch = MagicMock(return_value=frame(freq="min"))
    monkeypatch.setattr(history, "_fetch", fetch)
    broker_service.fetch_historical("NIFTY", TODAY)
    assert len(data_loader.load_dataframe("NIFTY", TODAY)) == 3
    options_service.fetch_options_historical("NIFTY", TODAY, 22250, TODAY, "PE")
    assert len(options_service.load_options_dataframe("NIFTY", TODAY, 22250, TODAY, "PE")) == 3
    assert fetch.call_count == 2
    assert all(call.args[0] == "kite" for call in fetch.call_args_list)


def test_strategy_backfill_uses_breeze_with_kite_stream(monkeypatch):
    monkeypatch.setattr(history, "_fetch", lambda provider, *args: frame())
    result = simulation._backfill_bar_history(simulation.SimulationSession(session_id="strategy-history", symbol="NIFTY",
        date=TODAY, start_time="09:15:00", speed=1, session_type="paper", paper_stream_source="kite"),
        None, int(pd.Timestamp(f"{TODAY} 09:18", tz="UTC").timestamp()))
    assert len(result) == 1 and result[0]["close"] == 42


@pytest.mark.asyncio
async def test_admin_validates_source_and_reports_failed_save(monkeypatch):
    with pytest.raises(HTTPException) as error:
        await admin.set_historical_source(admin.HistoricalSourceRequest(source="fyers"), "admin")
    assert error.value.status_code == 400
    monkeypatch.setattr(token_service, "set_token", MagicMock(side_effect=RuntimeError("write failed")))
    with pytest.raises(HTTPException) as error:
        await admin.set_historical_source(admin.HistoricalSourceRequest(source="kite", allow_fallback=True), "admin")
    assert error.value.status_code == 503
    assert history.get_policy() == history.HistoricalPolicy()


def test_policy_saved_atomically_with_strict_write(monkeypatch):
    save = MagicMock()
    monkeypatch.setattr(token_service, "set_token", save)
    history.set_policy(history.HistoricalPolicy("kite", True))
    assert history.get_policy() == history.HistoricalPolicy("kite", True)
    assert save.call_args.kwargs == {"strict": True}
    import json
    assert json.loads(save.call_args.args[1]) == {"source": "kite", "allow_fallback": True}


def test_explicit_refresh_fetches_once_and_updates_ensure_load_pair(monkeypatch, tmp_path):
    path = tmp_path / "breeze.parquet"
    monkeypatch.setattr(history, "_fetch", lambda *args: frame(value=40))
    assert history.load_history("NIFTY", TODAY).frame.iloc[0]["close"] == 40
    refresh = MagicMock()
    def force(symbol, date, *, force_refresh=False):
        assert force_refresh
        frame(value=50).to_parquet(path)
        return path
    refresh.side_effect = force
    monkeypatch.setattr(broker_service, "_fetch_breeze_historical", refresh)
    with history.historical_operation(force_refresh=True):
        broker_service.fetch_historical("NIFTY", TODAY)
        loaded = data_loader.load_dataframe("NIFTY", TODAY)
    assert loaded.iloc[0]["close"] == 50
    refresh.assert_called_once_with("NIFTY", TODAY, force_refresh=True)


def test_today_uses_ist_across_utc_date_boundary(monkeypatch):
    instant = datetime(2026, 9, 30, 21, tzinfo=timezone.utc)
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant.astimezone(tz)
    monkeypatch.setattr(history, "datetime", FixedDatetime)
    assert _real_is_today(TODAY)
    assert not _real_is_today(PAST)


@pytest.mark.asyncio
async def test_today_minute_history_never_enters_desktop_raw_second_cache(monkeypatch):
    from app.services import desktop_live_service as live
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 1, 12, tzinfo=tz)
    monkeypatch.setattr(live, "datetime", FixedDatetime)
    monkeypatch.setattr(history, "get_policy", lambda: history.HistoricalPolicy("kite"))
    monkeypatch.setattr(history, "_fetch", lambda *args: frame(freq="min"))
    async def inline_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)
    monkeypatch.setattr("asyncio.to_thread", inline_thread)
    seconds = await live._load_current_date_seconds({"instrument": {"kind": "index", "symbol": "NIFTY"}})
    assert seconds == []


@pytest.mark.asyncio
async def test_options_chart_mixes_breeze_past_and_selected_today(monkeypatch):
    from app.main import app
    from app.routers import data
    from httpx import AsyncClient, ASGITransport
    monkeypatch.setattr(data, "prior_trading_days", lambda *args, **kwargs: [PAST])
    monkeypatch.setattr(history, "get_policy", lambda: history.HistoricalPolicy("kite"))
    past_fetch = MagicMock()
    monkeypatch.setattr(history, "_complete_breeze_cache", lambda symbol, day, *args:
        history.HistoricalResult(history._normalize(frame(PAST), PAST), history._path("breeze", symbol, day, None, None, None), "kite", "breeze", 1))
    monkeypatch.setattr(options_service, "_fetch_breeze_options_historical", past_fetch)
    monkeypatch.setattr(options_service, "_load_breeze_options_dataframe", lambda *args: history._normalize(frame(PAST), PAST))
    fetch = MagicMock(return_value=frame(freq="min", value=30))
    monkeypatch.setattr(history, "_fetch", fetch)
    async def inline_thread(fn, *args, **kwargs):
        return fn(*args, **kwargs)
    monkeypatch.setattr("asyncio.to_thread", inline_thread)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/data/options-historical", params={"symbol": "BSESEN", "date": TODAY,
            "strike": 71200, "expiry": TODAY, "right": "PE", "interval_minutes": 1, "history_mode": "live"})
    assert response.status_code == 200
    body = response.json()
    assert body["dates"] == [PAST, TODAY]
    assert [candle["close"] for candle in body["candles"]] == [42, 30, 31, 32]
    past_fetch.assert_not_called()
    assert fetch.call_args.args[0] == "kite"


def test_concurrent_breeze_history_initialization_authenticates_once(monkeypatch):
    import sys
    from types import SimpleNamespace
    monkeypatch.setattr(broker_service, "_cached_breeze", None)
    monkeypatch.setattr(broker_service, "_cached_breeze_creds", None)
    monkeypatch.setattr(broker_service, "_read_breeze_credentials", lambda: {"api_key": "test-key", "api_secret": "test-secret", "session_token": "test-token"})
    client = MagicMock()
    def generate(**kwargs):
        time.sleep(0.02)
        return {"Status": 200}
    client.generate_session.side_effect = generate
    constructor = MagicMock(return_value=client)
    monkeypatch.setitem(sys.modules, "breeze_connect", SimpleNamespace(BreezeConnect=constructor))
    with ThreadPoolExecutor(max_workers=8) as executor:
        clients = list(executor.map(lambda _: broker_service._get_breeze(), range(8)))
    assert all(value is client for value in clients)
    constructor.assert_called_once()
    client.generate_session.assert_called_once()
