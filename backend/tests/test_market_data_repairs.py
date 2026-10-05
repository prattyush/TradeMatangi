"""Regression coverage for pacing, incremental refresh and handshake readiness."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
import threading
import pandas as pd
import pytest
from app.services import kite_requests as requests, kite_service as kite, history_tail


@pytest.fixture
def clock(monkeypatch):
    value = [100.0]
    monkeypatch.setattr(requests, "_pacers", {})
    monkeypatch.setattr(requests, "time", SimpleNamespace(
        monotonic=lambda: value[0], sleep=lambda delay: value.__setitem__(0, value[0] + delay)))
    return value


def test_pacing_shared_by_api_key_across_concurrent_clients(clock):
    starts = []
    clients = [SimpleNamespace(api_key="shared", fetch=lambda: starts.append(clock[0])) for _ in range(12)]
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda c: requests.request(c, "historical", "fetch"), clients))
    assert all(b - a >= .349 for a, b in zip(starts, starts[1:]))


def test_429_backoff_is_shared_and_expires(clock):
    error = RuntimeError("Too many requests")
    method = MagicMock(side_effect=[error, error, error, "ok"])
    client = SimpleNamespace(api_key="key", fetch=method)
    assert requests.request(client, "historical", "fetch") == "ok"
    assert clock[0] == 107
    method.side_effect = None
    requests.request(client, "historical", "fetch")
    assert clock[0] == 111
    clock[0] += 61
    requests.request(client, "historical", "fetch")
    requests.request(client, "historical", "fetch")
    assert clock[0] == pytest.approx(172.35)


def test_retry_after_and_retry_exhaustion(clock):
    error = RuntimeError("429")
    error.code = 429
    error.response = SimpleNamespace(headers={"Retry-After": "8"})
    method = MagicMock(side_effect=error)
    with pytest.raises(RuntimeError):
        requests.request(SimpleNamespace(api_key="key", fetch=method), "historical", "fetch")
    assert method.call_count == 4 and clock[0] == 124


def test_client_is_reused_and_rotated(tmp_path, monkeypatch, clock):
    (tmp_path / "accesskeys.ini").write_text("[kite]\napi_key=key\naccess_token=ini\n")
    monkeypatch.setattr("app.config.DATA_DIR", tmp_path)
    monkeypatch.setattr(kite, "_cached_kite", None)
    monkeypatch.setattr(kite, "_cached_kite_creds", None)
    token = ["first"]
    monkeypatch.setattr("app.services.token_service.get_token", lambda key: token[0])
    clients = [MagicMock(api_key="key"), MagicMock(api_key="key")]
    with patch("kiteconnect.KiteConnect", side_effect=clients) as factory:
        assert kite._get_kite() is clients[0]
        assert kite._get_kite() is clients[0]
        token[0] = "second"
        assert kite._get_kite() is clients[1]
    assert factory.call_count == 2
    for client in clients:
        client.profile.assert_called_once()


def test_rate_limit_is_not_expired_token(tmp_path, monkeypatch, clock):
    (tmp_path / "accesskeys.ini").write_text("[kite]\napi_key=key\naccess_token=ini\n")
    monkeypatch.setattr("app.config.DATA_DIR", tmp_path)
    monkeypatch.setattr("app.services.token_service.get_token", lambda _: None)
    monkeypatch.setattr(kite, "_cached_kite", None)
    client = MagicMock(api_key="key")
    client.profile.side_effect = RuntimeError("Too many requests")
    with patch("kiteconnect.KiteConnect", return_value=client):
        with pytest.raises(RuntimeError, match="Too many"):
            kite._get_kite()


def frame(start, end, price=100):
    index = pd.date_range(start, end, freq="s")
    return pd.DataFrame({column: price for column in ("open", "high", "low", "close", "volume")}, index=index)


@pytest.fixture
def today(monkeypatch):
    monkeypatch.setattr("app.services.historical_data_service.is_today", lambda _: True)
    monkeypatch.setattr(history_tail, "datetime", SimpleNamespace(now=lambda _: pd.Timestamp("2026-10-05 13:36:00")))


def test_tail_reuses_completed_chunks_and_provider_wins(today):
    cached = frame("2026-10-05 09:15", "2026-10-05 13:27")
    start, end = history_tail.fetch_window("2026-10-05", cached)
    assert start == pd.Timestamp("2026-10-05 13:00")
    assert end == pd.Timestamp("2026-10-05 13:36")
    merged = history_tail.merge_tail(cached, frame(str(start), str(end), 105))
    assert merged.loc["2026-10-05 12:59:59", "close"] == 100
    assert merged.loc["2026-10-05 13:00:00", "close"] == 105
    assert merged.index.is_unique and merged.index.max() == end


@pytest.mark.parametrize("now,expected", [("08:00", "08:00"), ("16:00", "15:15")])
def test_window_respects_market_boundaries(monkeypatch, today, now, expected):
    monkeypatch.setattr(history_tail, "datetime", SimpleNamespace(now=lambda _: pd.Timestamp(f"2026-10-05 {now}")))
    start, end = history_tail.fetch_window("2026-10-05")
    assert start == pd.Timestamp("2026-10-05 09:15")
    assert end == pd.Timestamp(f"2026-10-05 {expected}")


@pytest.mark.parametrize("option", [False, True])
def test_explicit_refresh_preserves_prior_data(tmp_path, monkeypatch, today, option):
    from app.services import broker_service as broker, options_service as options
    monkeypatch.setattr("app.services.data_loader.OHLCDATA_DIR", tmp_path)
    monkeypatch.setattr(options, "OHLCDATA_DIR", tmp_path)
    cached = frame("2026-10-05 09:15", "2026-10-05 13:27")
    path = (options.options_parquet_path("NIFTY", "2026-10-05", 25000, "2026-10-06", "CE") if option
            else broker.parquet_path("NIFTY", "2026-10-05"))
    cached.to_parquet(path)
    records = frame("2026-10-05 13:00", "2026-10-05 13:36", 105).reset_index(names="datetime").to_dict("records")
    monkeypatch.setattr(broker, "_get_breeze", MagicMock())
    fetch = MagicMock(return_value=records)
    if option:
        monkeypatch.setattr(options, "_fetch_options_day_paginated", fetch)
        options._fetch_breeze_options_historical("NIFTY", "2026-10-05", 25000, "2026-10-06", "CE", force_refresh=True)
    else:
        monkeypatch.setattr(broker, "_fetch_day_paginated", fetch)
        broker._fetch_breeze_historical("NIFTY", "2026-10-05", force_refresh=True)
    pd.testing.assert_frame_equal(fetch.call_args.kwargs["cached"], cached, check_freq=False)
    saved = pd.read_parquet(path)
    assert saved.loc["2026-10-05 09:15:00", "close"] == 100
    assert saved.loc["2026-10-05 13:27:00", "close"] == 105


@pytest.fixture
def broadcaster(monkeypatch):
    bc = kite.KiteBroadcaster()
    bc._startup_timeout = .02
    monkeypatch.setattr(bc, "_read_config", lambda: {"api_key": "dummy", "access_token": "dummy"})
    monkeypatch.setattr(kite, "_reactor_call", lambda fn, *args: fn(*args))
    return bc


@pytest.mark.parametrize("failure", ["timeout", "auth", "subscribe"])
def test_failed_handshake_cleans_registration(broadcaster, failure):
    bc, ticker = broadcaster, MagicMock()
    if failure == "auth":
        ticker.connect.side_effect = lambda: bc._on_error(ticker, 403, "Forbidden")
    elif failure == "subscribe":
        ticker.connect.side_effect = lambda: bc._on_connect(ticker, {})
        ticker.subscribe.side_effect = RuntimeError("subscription failed")
    loop = SimpleNamespace(call_soon_threadsafe=lambda *args: None)
    with patch("kiteconnect.KiteTicker", return_value=ticker):
        with pytest.raises(kite.KiteConnectionError):
            bc.register("website", [256265], [None], asyncio.Queue(), loop)
    assert not bc._connected and bc._ticker is None
    assert not bc._token_sessions and not bc._session_tokens
    ticker.close.assert_called_once()


def test_delayed_handshake_waits_for_subscription(broadcaster):
    bc, ticker = broadcaster, MagicMock()
    bc._startup_timeout = 1
    connected = threading.Event()
    ticker.connect.side_effect = connected.set
    loop = SimpleNamespace(call_soon_threadsafe=lambda *args: None)
    with patch("kiteconnect.KiteTicker", return_value=ticker), ThreadPoolExecutor(max_workers=1) as pool:
        registration = pool.submit(bc.register, "desktop", [256265], [None], asyncio.Queue(), loop)
        assert connected.wait(1)
        assert not registration.done() and not bc._connected
        bc._on_connect(ticker, {})
        registration.result(timeout=1)
    assert bc._connected
    ticker.subscribe.assert_called_once_with([256265])
    bc.unregister("desktop")
    bc._on_connect(ticker, {})
    bc._on_ticks(ticker, [{"instrument_token": 256265, "last_price": 100}])
    assert not bc._connected and not bc._accumulators


def test_real_sdk_socket_shared_delivery_and_stop_start():
    import os
    from pathlib import Path
    import subprocess
    import sys
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run([sys.executable, str(root / "tests/helpers/kite_socket_scenario.py")],
                            cwd=root, env={**os.environ, "PYTHONPATH": str(root)},
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "Kite socket scenario passed" in result.stdout


@pytest.mark.parametrize("option", [False, True])
def test_failed_tail_download_keeps_cache_bytes(tmp_path, monkeypatch, today, option):
    from app.services import broker_service as broker, options_service as options
    monkeypatch.setattr("app.services.data_loader.OHLCDATA_DIR", tmp_path)
    monkeypatch.setattr(options, "OHLCDATA_DIR", tmp_path)
    path = (options.options_parquet_path("NIFTY", "2026-10-05", 25000, "2026-10-06", "CE") if option
            else broker.parquet_path("NIFTY", "2026-10-05"))
    frame("2026-10-05 09:15", "2026-10-05 13:27").to_parquet(path)
    before, mtime = path.read_bytes(), path.stat().st_mtime
    monkeypatch.setattr(broker, "_get_breeze", MagicMock())
    fetch = MagicMock(side_effect=RuntimeError("provider unavailable"))
    if option:
        monkeypatch.setattr(options, "_fetch_options_day_paginated", fetch)
        result = options._fetch_breeze_options_historical("NIFTY", "2026-10-05", 25000, "2026-10-06", "CE", force_refresh=True)
    else:
        monkeypatch.setattr(broker, "_fetch_day_paginated", fetch)
        result = broker._fetch_breeze_historical("NIFTY", "2026-10-05", force_refresh=True)
    assert result == path and path.read_bytes() == before and path.stat().st_mtime == mtime


def test_overlapping_explicit_requests_share_one_download(tmp_path, monkeypatch, today):
    from app.services import historical_data_service as history, broker_service as broker
    path = tmp_path / "NIFTY.parquet"
    frame("2026-10-05 09:15", "2026-10-05 09:16").to_parquet(path)
    monkeypatch.setattr(history, "_results", {})
    barrier = threading.Barrier(6)
    local = threading.local()
    def cache_path(*args):
        if not getattr(local, "arrived", False):
            local.arrived = True
            barrier.wait(timeout=2)
        return path
    monkeypatch.setattr(history, "_path", cache_path)
    fetch = MagicMock(return_value=path)
    monkeypatch.setattr(broker, "_fetch_breeze_historical", fetch)
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = [pool.submit(history.load_history, "NIFTY", "2026-10-05", force_refresh=True,
                               policy=history.HistoricalPolicy()) for _ in range(6)]
        assert all(not f.result(timeout=3).frame.empty for f in futures)
    assert fetch.call_count == 1


def test_cadence_change_does_not_mix_second_and_minute_rows():
    cached = frame("2026-10-05 09:15", "2026-10-05 09:16")
    minute = cached.iloc[::60]
    with pytest.raises(RuntimeError, match="cadence changed"):
        history_tail.merge_tail(cached, minute)


def test_concurrent_instrument_refresh_downloads_once(tmp_path, monkeypatch):
    client = MagicMock(api_key="dummy")
    client.instruments.return_value = [{"instrument_token": 123, "tradingsymbol": "TEST", "exchange": "NSE"}]
    monkeypatch.setattr(kite, "_get_kite", lambda: client)
    monkeypatch.setattr(kite, "_kite_request", lambda c, category, method, **kwargs: getattr(c, method)(**kwargs))
    path = tmp_path / "instruments.csv"
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _: kite._refresh_instruments_cache("NSE", path), range(6)))
    client.instruments.assert_called_once_with(exchange="NSE")
    assert "TEST" in path.read_text()
    assert not path.with_suffix(".csv.tmp").exists()


def test_auth_failure_invalidates_only_affected_client(monkeypatch, clock):
    old, new = MagicMock(api_key="key"), MagicMock(api_key="key")
    monkeypatch.setattr(kite, "_cached_kite", new)
    monkeypatch.setattr(kite, "_cached_kite_creds", ("key", "new"))
    error = RuntimeError("expired")
    error.code = 403
    old.fetch.side_effect = error
    with pytest.raises(RuntimeError):
        requests.request(old, "historical", "fetch")
    assert kite._cached_kite is new
    new.fetch.side_effect = error
    with pytest.raises(RuntimeError):
        requests.request(new, "historical", "fetch")
    assert kite._cached_kite is None and kite._cached_kite_creds is None
