"""Mode isolation, past-cache reuse and read-only Kotak historical data."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pandas as pd
import pytest

from app.services import historical_data_service as history, kotak_history as kotak
from app.services import broker_service, data_loader, options_service, kotak_service

REAL_GET_POLICY = history.get_policy
TODAY, PAST, EXPIRY = "2026-10-05", "2026-09-29", "2026-10-08"


def frame(date=TODAY, freq="min", count=3, value=100):
    return pd.DataFrame({name: [value + n for n in range(count)] for name in ("open", "high", "low", "close", "volume")},
                        index=pd.date_range(f"{date} 09:15", periods=count, freq=freq))


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(history, "_results", {})
    monkeypatch.setattr(history, "_last_warning", {})
    monkeypatch.setattr(history, "_policy_cache", None)
    monkeypatch.setattr(history, "is_today", lambda day: day == TODAY)
    monkeypatch.setattr(history, "get_policy", lambda: history.HistoricalPolicy("kite"))
    monkeypatch.setattr("app.config.DATA_DIR", tmp_path)
    monkeypatch.setattr("app.config.OHLCDATA_DIR", tmp_path / "ohlc")
    monkeypatch.setattr(data_loader, "DATA_DIR", tmp_path)
    monkeypatch.setattr(data_loader, "OHLCDATA_DIR", tmp_path / "ohlc")
    monkeypatch.setattr(options_service, "OHLCDATA_DIR", tmp_path / "ohlc")
    monkeypatch.setattr(broker_service, "_get_breeze", MagicMock(side_effect=AssertionError("unexpected Breeze network call")))
    monkeypatch.setattr(kotak, "_client", None)
    monkeypatch.setattr(kotak, "_consumer_key", None)
    monkeypatch.setattr(kotak, "_pacers", {})
    monkeypatch.setattr(kotak, "datetime", SimpleNamespace(now=lambda _: datetime(2026, 10, 5, 13)))
    history.detach_historical_operation()
    yield
    history.detach_historical_operation()


def contract(option):
    return {"strike": 25000, "expiry": EXPIRY, "right": "CE"} if option else {}


@pytest.mark.parametrize("source", ["breeze", "kite", "kotak"])
@pytest.mark.parametrize("option", [False, True])
@pytest.mark.parametrize("day", [TODAY, PAST])
def test_configured_provider_on_live_cache_miss(source, option, day, monkeypatch):
    fetch = MagicMock(return_value=frame(day, freq="s" if source == "breeze" else "min"))
    monkeypatch.setattr(history, "_fetch", fetch)
    result = history.load_history("NIFTY", day, **contract(option), mode="live", policy=history.HistoricalPolicy(source))
    assert result.actual_provider == source
    assert result.interval_seconds == (1 if source == "breeze" else 60)
    assert fetch.call_count == 1 and fetch.call_args.args[0] == source


@pytest.mark.parametrize("source", ["kite", "kotak"])
@pytest.mark.parametrize("option", [False, True])
def test_complete_previous_breeze_cache_avoids_all_provider_downloads(source, option, monkeypatch):
    path = history._path("breeze", "NIFTY", PAST, **{k: contract(option).get(k) for k in ("strike", "expiry", "right")})
    frame(PAST, freq="s", count=21600).to_parquet(path)
    fetch = MagicMock(side_effect=AssertionError("complete cache must not download"))
    monkeypatch.setattr(history, "_fetch", fetch)
    result = history.load_history("NIFTY", PAST, **contract(option), mode="live", policy=history.HistoricalPolicy(source))
    assert result.actual_provider == "breeze" and result.selected_provider == source
    assert result.interval_seconds == 1 and result.path == path
    fetch.assert_not_called()


@pytest.mark.parametrize("invalid", ["empty", "partial", "corrupt", "minute"])
def test_incomplete_previous_cache_downloads_selected_provider(invalid, monkeypatch):
    path = data_loader.parquet_path("NIFTY", PAST)
    if invalid == "corrupt":
        path.write_text("bad parquet")
    else:
        cached = frame(PAST, freq="s" if invalid != "minute" else "min", count=0 if invalid == "empty" else 3)
        cached.to_parquet(path)
    fetch = MagicMock(return_value=frame(PAST))
    monkeypatch.setattr(history, "_fetch", fetch)
    assert history.load_history("NIFTY", PAST, mode="live", policy=history.HistoricalPolicy("kotak")).actual_provider == "kotak"
    assert fetch.call_args.args[0] == "kotak"


@pytest.mark.parametrize("option", [False, True])
def test_today_never_substitutes_breeze_cache(option, monkeypatch):
    path = history._path("breeze", "NIFTY", TODAY, **{k: contract(option).get(k) for k in ("strike", "expiry", "right")})
    frame(freq="s", count=21600).to_parquet(path)
    before = path.read_bytes()
    fetch = MagicMock(return_value=frame())
    monkeypatch.setattr(history, "_fetch", fetch)
    result = history.load_history("NIFTY", TODAY, **contract(option), mode="live", policy=history.HistoricalPolicy("kite"))
    assert result.actual_provider == "kite" and result.path != path
    assert path.read_bytes() == before and fetch.call_count == 1


@pytest.mark.parametrize("source", ["kite", "kotak"])
@pytest.mark.parametrize("day", [TODAY, PAST])
def test_replay_ignores_minute_policy_and_live_memory_cache(source, day, monkeypatch):
    fetch = MagicMock(side_effect=lambda provider, *args: frame(day, freq="s" if provider == "breeze" else "min"))
    monkeypatch.setattr(history, "_fetch", fetch)
    policy = history.HistoricalPolicy(source, True)
    live = history.load_history("NIFTY", day, policy=policy, mode="live")
    replay = history.load_history("NIFTY", day, policy=policy, mode="replay")
    assert live.actual_provider == source and replay.actual_provider == "breeze"
    assert replay.interval_seconds == 1
    assert [call.args[0] for call in fetch.call_args_list] == [source, "breeze"]


def test_replay_failure_cannot_fall_back_to_minute_provider(monkeypatch):
    fetch = MagicMock(side_effect=RuntimeError("Breeze unavailable"))
    monkeypatch.setattr(history, "_fetch", fetch)
    with pytest.raises(RuntimeError):
        history.load_history("NIFTY", TODAY, policy=history.HistoricalPolicy("kotak", True), mode="replay")
    assert fetch.call_count == 1 and fetch.call_args.args[0] == "breeze"


def test_concurrent_live_and_replay_calls_are_isolated(monkeypatch):
    calls = []
    def fetch(provider, *args):
        calls.append(provider)
        return frame(freq="s" if provider == "breeze" else "min")
    monkeypatch.setattr(history, "_fetch", fetch)
    with ThreadPoolExecutor(max_workers=8) as pool:
        modes = ["live", "replay"] * 8
        results = list(pool.map(lambda mode: history.load_history("NIFTY", TODAY, mode=mode), modes))
    assert sorted(calls) == ["breeze", "kite"]
    assert [r.actual_provider for r in results] == ["kite", "breeze"] * 8


@pytest.mark.asyncio
async def test_nested_mode_and_worker_context_are_preserved():
    from app.services.history_workers import run_history
    assert history.history_mode() == "replay"
    with history.historical_operation(mode="live"):
        assert await run_history(history.history_mode) == "live"
        with history.historical_operation(mode="replay"):
            assert await asyncio.to_thread(history.history_mode) == "replay"
        assert history.history_mode() == "live"
    assert history.history_mode() == "replay"


@pytest.mark.asyncio
@pytest.mark.parametrize("session_type", ["paper", "real", "sim", "stepwise"])
async def test_session_start_selects_mode_before_preflight(session_type, monkeypatch):
    from app.routers import simulation
    from app.models.schemas import SimulationStartRequest
    async def start(*args, **kwargs):
        return history.history_mode()
    monkeypatch.setattr(simulation, "_start_simulation_impl", start)
    request = SimulationStartRequest(symbol="NIFTY", date=TODAY, session_type=session_type)
    with history.historical_operation(mode="replay"):
        assert await simulation._start_simulation(request, "user") == ("live" if session_type in ("paper", "real") else "replay")
        assert history.history_mode() == "replay"


def test_live_underlying_minute_price_is_as_of_reference(monkeypatch):
    monkeypatch.setattr(history, "_fetch", lambda *args: frame())
    ts = int(pd.Timestamp(f"{TODAY} 09:16:30", tz="UTC").timestamp())
    with history.historical_operation(mode="live"):
        assert options_service.get_underlying_price_at("NIFTY", TODAY, ts) == 101


@pytest.mark.parametrize("fallback", [False, True])
def test_kotak_fallback_order_is_explicit(fallback, monkeypatch):
    calls = []
    def fetch(provider, *args):
        calls.append(provider)
        if provider != "breeze":
            raise RuntimeError("inactive contract")
        return frame(PAST, freq="s")
    monkeypatch.setattr(history, "_fetch", fetch)
    if fallback:
        result = history.load_history("NIFTY", PAST, **contract(True), policy=history.HistoricalPolicy("kotak", True), mode="live")
        assert result.actual_provider == "breeze" and calls == ["kotak", "kite", "breeze"]
    else:
        with pytest.raises(RuntimeError):
            history.load_history("NIFTY", PAST, **contract(True), policy=history.HistoricalPolicy("kotak"), mode="live")
        assert calls == ["kotak"]


def response(date=PAST):
    return {"status": "success", "interval": "1min", "data": {"candles": [
        [f"{date}T09:15:00+0530", 100, 101, 99, 100, 1],
        [f"{date}T09:16:00+0530", 100, 102, 99, 101, 2, None]]}}


@pytest.mark.parametrize("option", [False, True])
def test_kotak_one_request_per_day_then_cached(option, monkeypatch):
    client = MagicMock()
    client.configuration.consumer_key = "read-only"
    client.historical_data.return_value = response()
    monkeypatch.setattr(kotak, "_get_client", lambda: client)
    equity = MagicMock(return_value=("26000", "nse_cm"))
    option_token = MagicMock(return_value=("9999", "nse_fo"))
    monkeypatch.setattr(kotak_service, "fetch_kotak_equity_instrument_token", equity)
    monkeypatch.setattr(kotak_service, "fetch_kotak_options_instrument_token", option_token)
    with history.historical_operation(mode="live"):
        first = history.load_history("NIFTY", PAST, **contract(option), policy=history.HistoricalPolicy("kotak"))
    history._results.clear()
    with history.historical_operation(mode="live"):
        second = history.load_history("NIFTY", PAST, **contract(option), policy=history.HistoricalPolicy("kotak"))
    client.historical_data.assert_called_once_with(neosymbol="nse_fo|9999" if option else "nse_cm|26000",
                                                interval="1min", from_date=PAST, to_date=PAST)
    assert first.path.name.endswith("-kotak1m.parquet")
    assert first.interval_seconds == 60 and len(first.frame) == 2
    assert first.frame.index[0] == pd.Timestamp(f"{PAST} 09:15", tz="UTC")
    pd.testing.assert_frame_equal(first.frame, second.frame)
    client.totp_login.assert_not_called()
    client.totp_validate.assert_not_called()


def test_kotak_real_sdk_transport_uses_documented_wire_shape():
    from neo_api_client import NeoAPI
    requests = []
    def transport(request):
        requests.append(request)
        return httpx.Response(200, json=response())
    client = NeoAPI(consumer_key="read-only", transport=httpx.MockTransport(transport))
    try:
        result = kotak._request(client, neosymbol="nse_cm|26000", interval="1min", from_date=PAST, to_date=PAST)
        assert result["status"] == "success"
        request = requests[-1]
        assert request.headers["Authorization"] == "read-only"
        assert dict(request.url.params) == {"neosymbol": "nse_cm|26000", "interval": "1min", "fromdate": PAST, "todate": PAST}
    finally:
        kotak_service.KotakNeoService._close_client(client)


def test_kotak_client_requires_only_consumer_key_and_rotates(monkeypatch):
    key = ["first"]
    monkeypatch.setattr(kotak_service, "_read_kotak_credentials", lambda: {"access_token": key[0]})
    first, second = MagicMock(), MagicMock()
    with patch("neo_api_client.NeoAPI", side_effect=[first, second]) as factory:
        assert kotak._get_client() is first
        assert kotak._get_client() is first
        key[0] = "second"
        assert kotak._get_client() is second
    assert factory.call_args_list[0].kwargs == {"consumer_key": "first", "environment": "prod"}
    assert factory.call_count == 2
    first.totp_login.assert_not_called()
    first.totp_validate.assert_not_called()
    first.api_client.rest_client.close.assert_called_once()


def test_kotak_429_has_shared_cooldown_and_preserves_request_budget(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(kotak, "time", SimpleNamespace(monotonic=lambda: clock[0], sleep=lambda delay: clock.__setitem__(0, clock[0] + delay)))
    client = MagicMock()
    client.configuration.consumer_key = "read-only"
    client.historical_data.return_value = {"status": "ERROR", "fault": {"code": 429}, "rateLimit": {"Retry-After": "180"}}
    with pytest.raises(RuntimeError, match="cooldown"):
        kotak._request(client)
    with pytest.raises(RuntimeError, match="cooldown"):
        kotak._request(client)
    assert client.historical_data.call_count == 1
    clock[0] += 181
    client.historical_data.return_value = response()
    kotak._request(client)
    kotak._request(client)
    assert clock[0] == pytest.approx(281.05)


@pytest.mark.parametrize("bad", [[], [["bad"]], [[f"{PAST}T09:15:00+0530", 1, 2, 1, float("nan"), 1]],
                                 [[f"{PAST}T09:15:01+0530", 1, 2, 1, 1, 1]]])
def test_malformed_kotak_candles_rejected(bad):
    with pytest.raises((RuntimeError, ValueError)):
        kotak._frame({"data": {"candles": bad}}, PAST)


def test_kotak_today_failure_keeps_original_cache_and_stale_metadata(monkeypatch):
    path = history._path("kotak", "NIFTY", TODAY, None, None, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    frame().to_parquet(path)
    before = path.read_bytes()
    monkeypatch.setattr(kotak, "_get_client", MagicMock(side_effect=RuntimeError("read-only credentials unavailable")))
    result = history.load_history("NIFTY", TODAY, mode="live", policy=history.HistoricalPolicy("kotak"))
    assert result.stale and result.actual_provider == "kotak"
    assert path.read_bytes() == before


@pytest.mark.asyncio
async def test_data_api_defaults_to_replay_and_live_mode_is_explicit(monkeypatch):
    from app.main import app
    path = data_loader.parquet_path("NIFTY", TODAY)
    frame(freq="s").to_parquet(path)
    breeze = MagicMock(return_value=path)
    monkeypatch.setattr(broker_service, "_fetch_breeze_historical", breeze)
    selected = MagicMock(return_value=frame(value=200))
    monkeypatch.setattr(history, "_fetch", selected)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        params = {"symbol": "NIFTY", "date": TODAY, "time": "09:17:00"}
        replay = await client.get("/api/data/price-at", params=params)
        live = await client.get("/api/data/price-at", params={**params, "history_mode": "live"})
        invalid = await client.get("/api/data/price-at", params={**params, "history_mode": "invalid"})
    assert replay.status_code == live.status_code == 200
    assert replay.json()["price"] == 102 and live.json()["price"] == 202
    assert invalid.status_code == 422
    breeze.assert_called_once_with("NIFTY", TODAY)
    assert selected.call_count == 1 and selected.call_args.args[0] == "kite"


@pytest.mark.asyncio
async def test_kotak_setting_round_trips_without_schema_migration(monkeypatch):
    import json
    from app.routers import admin
    from app.services import token_service
    monkeypatch.setattr(history, "get_policy", REAL_GET_POLICY)
    saved = MagicMock()
    monkeypatch.setattr(token_service, "set_token", saved)
    request = admin.HistoricalSourceRequest(source="kotak", allow_fallback=True)
    result = await admin.set_historical_source(request, "admin")
    read = await admin.get_historical_source("admin")
    assert result.source == read.source == "kotak" and read.allow_fallback
    assert json.loads(saved.call_args.args[1]) == {"source": "kotak", "allow_fallback": True}
    assert saved.call_args.kwargs == {"strict": True}


@pytest.mark.parametrize("option", [False, True])
def test_replay_ticks_reject_minute_data(option, monkeypatch):
    if option:
        monkeypatch.setattr(options_service, "load_options_dataframe", lambda *args: history._normalize(frame(), TODAY))
        ticks = options_service.options_iter_ticks("NIFTY", TODAY, 25000, EXPIRY, "CE")
    else:
        monkeypatch.setattr(data_loader, "load_dataframe", lambda *args: history._normalize(frame(), TODAY))
        ticks = data_loader.iter_ticks("NIFTY", TODAY)
    with pytest.raises(RuntimeError, match="second-level"):
        list(ticks)


def test_read_only_kotak_master_errors_do_not_log_out_trading(monkeypatch):
    client = MagicMock()
    client.scrip_master.return_value = {"fault": {"code": 403, "message": "invalid consumer key"}}
    with patch.object(kotak_service._service, "_get_client", side_effect=AssertionError("trading client used")), \
         patch.object(kotak_service._service, "shutdown") as logout:
        assert kotak_service._load_kotak_master_from_api(client=client) == []
    logout.assert_not_called()


@pytest.mark.parametrize("provider", ["kite", "kotak"])
def test_previous_minute_cache_written_intraday_is_refetched(provider, monkeypatch):
    import os
    from app.services import kite_service
    path = history._path(provider, "NIFTY", PAST, None, None, None)
    path.parent.mkdir(parents=True, exist_ok=True)
    frame(PAST).to_parquet(path)
    written_at = pd.Timestamp(f"{PAST} 12:00", tz="Asia/Kolkata").timestamp()
    os.utime(path, (written_at, written_at))
    assert not history.complete_day_cache(path, PAST)
    if provider == "kotak":
        client = MagicMock()
        client.configuration.consumer_key = "read-only"
        client.historical_data.return_value = response()
        monkeypatch.setattr(kotak, "_get_client", lambda: client)
        monkeypatch.setattr(kotak_service, "fetch_kotak_equity_instrument_token", lambda *args, **kwargs: ("26000", "nse_cm"))
    else:
        client = MagicMock()
        client.historical_data.return_value = [dict(date=pd.Timestamp(row[0]), open=row[1], high=row[2], low=row[3], close=row[4], volume=row[5])
                                             for row in response()["data"]["candles"]]
        monkeypatch.setattr(kite_service, "_get_kite", lambda: client)
        monkeypatch.setattr(kite_service, "_kite_request", lambda c, category, method, **kwargs: getattr(c, method)(**kwargs))
    loaded = history.load_history("NIFTY", PAST, mode="live", policy=history.HistoricalPolicy(provider))
    assert loaded.actual_provider == provider
    client.historical_data.assert_called_once()


def test_partial_previous_minute_cache_remains_available_if_contract_expired(monkeypatch):
    import os
    path = history._path("kotak", "NIFTY", PAST, 25000, EXPIRY, "CE")
    path.parent.mkdir(parents=True, exist_ok=True)
    frame(PAST).to_parquet(path)
    partial_time = pd.Timestamp(f"{PAST} 12:00", tz="Asia/Kolkata").timestamp()
    os.utime(path, (partial_time, partial_time))
    monkeypatch.setattr(kotak, "_get_client", MagicMock(side_effect=RuntimeError("expired contract")))
    result = history.load_history("NIFTY", PAST, **contract(True), mode="live", policy=history.HistoricalPolicy("kotak"))
    assert result.actual_provider == "kotak" and result.stale
    assert len(result.frame) == 3 and path.stat().st_mtime == partial_time


@pytest.mark.parametrize("symbol,exchange_name", [("RELIND", "RELIANCE"), ("TATMOT", "TMCV")])
def test_kotak_stock_option_history_uses_exchange_name(symbol, exchange_name, monkeypatch):
    name = kotak_service._build_options_trading_symbol(exchange_name, EXPIRY, 100, "CE", symbol)
    monkeypatch.setattr(kotak_service, "_get_kotak_instruments", lambda **kwargs: [
        {"symbol": name, "exchange": "nse_fo", "instrument_token": "123"}])
    assert kotak_service.fetch_kotak_options_instrument_token(symbol, EXPIRY, 100, "CE", client=MagicMock()) == ("123", "nse_fo")


@pytest.mark.asyncio
async def test_background_engine_keeps_mode_without_parent_result_cache(monkeypatch):
    monkeypatch.setattr(history, "_fetch", lambda *args: frame())
    async def child():
        history.detach_historical_operation(mode="live")
        assert history._operation.get() is None
        assert await asyncio.to_thread(history.history_mode) == "live"
        assert history.load_history("NIFTY", TODAY).actual_provider == "kite"
        return history.history_mode()
    with history.historical_operation(mode="replay"):
        assert await asyncio.create_task(child()) == "live"
        assert history.history_mode() == "replay"
    assert history.history_mode() == "replay"


def test_kotak_uppercase_success_and_placeholder_candles():
    client = MagicMock()
    client.configuration.consumer_key = "read-only"
    data = response()
    data["status"] = "SUCCESS"
    data["data"]["candles"].extend([
        [f"{PAST}T09:17:00+0530", 0, 0, 0, 0, 0],
        [f"{PAST}T15:29:00+0530", 0, 0, 0, 0, 0]])
    client.historical_data.return_value = data
    loaded = kotak._frame(kotak._request(client), PAST)
    assert len(loaded) == 2 and (loaded["close"] > 0).all()


def test_kotak_all_zero_success_is_unavailable():
    with pytest.raises(RuntimeError, match="no usable"):
        kotak._frame({"data": {"candles": [[f"{PAST}T09:15:00+0530", 0, 0, 0, 0, 0]]}}, PAST)


def test_kotak_future_placeholders_and_unavailable_volume():
    raw = {"data": {"candles": [
        [f"{TODAY}T09:15:00+0530", 100, 102, 99, 101, -1],
        [f"{TODAY}T14:15:00+0530", None, None, None, None, None]]}}
    loaded = kotak._frame(raw, TODAY)
    assert len(loaded) == 1 and loaded.iloc[0]["volume"] == 0
