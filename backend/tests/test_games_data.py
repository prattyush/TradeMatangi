"""Games market data (Phase 25, G1): the index builder, ``/availability`` and ``/window``.

Synthetic parquet files in a temporary directory stand in for the OHLC cache. The tests also prove the hard rule
of spec 3.2: a request for data that is not cached is a 404 and never reaches a download or a broker.
"""
import gzip
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.routers import desktop_games
from app.services import games_data_service as data
from app.services import games_index as index
from app.services.games_rate_limit import TokenBucket

DATE = "2026-10-01"
EXPIRY = "2026-10-06"
ROOT = Path(__file__).resolve().parents[2]


def seconds_frame(date=DATE, rows=22_500, observed=None, seed=1, start=100.0, flat=False):
    """One day of 1-second bars on the tz-naive IST wall clock, like the cache files."""
    stamps = pd.date_range(f"{date} 09:15:00", periods=rows, freq="s")
    rng = np.random.default_rng(seed)
    close = np.full(rows, start) if flat else np.round(start + np.cumsum(rng.choice([-0.05, 0.0, 0.05, 0.1], size=rows)), 2)
    open_ = np.concatenate([[close[0]], close[:-1]])
    frame = pd.DataFrame({"open": open_, "high": np.maximum(open_, close) + 0.05, "low": np.minimum(open_, close) - 0.05, "close": close, "volume": 0.0}, index=stamps)
    if observed is not None:
        frame["observed"] = observed
    return frame


def write(directory, name, frame):
    frame.to_parquet(directory / name)
    return directory / name


@pytest.fixture
def cache(tmp_path, monkeypatch):
    directory = tmp_path / "ohlcdata"
    directory.mkdir()
    monkeypatch.setattr(config, "OHLCDATA_DIR", directory)
    monkeypatch.setattr(config, "GAMES_INDEX_PATH", tmp_path / "games-index.json")
    data.clear_caches()
    yield directory
    data.clear_caches()


@pytest.fixture
def api(cache, monkeypatch):
    monkeypatch.setattr(desktop_games, "_availability_reads", TokenBucket(1000, 1000))
    monkeypatch.setattr(desktop_games, "_window_reads", TokenBucket(1000, 1000))
    return TestClient(app)


H = {"X-User-Id": "alice"}


def build(cache):
    document, stats = index.build_index(cache)
    index.write_index(document, config.GAMES_INDEX_PATH)
    data.clear_caches()
    return document, stats


# --------------------------------------------------------------------------------- file names
def test_day_and_option_names_parse_and_round_trip():
    assert index.parse_day_name("NIFTY-01-10-2026.parquet") == ("NIFTY", DATE)
    assert index.day_filename("NIFTY", DATE) == "NIFTY-01-10-2026.parquet"
    parsed = index.parse_option_name("NIFTY-CE-24800-06-10-2026-01-10-2026.parquet")
    assert parsed == ("NIFTY", DATE, EXPIRY, "CE", 24800)
    assert index.option_filename("NIFTY", DATE, EXPIRY, "CE", 24800) == "NIFTY-CE-24800-06-10-2026-01-10-2026.parquet"
    assert index.parse_option_name("NIFTY-PE-24800.5-06-10-2026-01-10-2026.parquet")[4] == 24800.5
    assert index.option_filename("NIFTY", DATE, EXPIRY, "PE", 24800.5) == "NIFTY-PE-24800.5-06-10-2026-01-10-2026.parquet"


@pytest.mark.parametrize("name", [
    "NIFTY-01-10-2026-kite1m.parquet", "NIFTY-01-10-2026-kotak1m.parquet", "NIFTY-31-02-2026.parquet", "NIFTY-01-10-2026.pickle",
    "NIFTY-CE-24800-30-02-2026-01-10-2026.parquet", "NIFTY-CE-24800-06102026-01-10-2026.parquet", "swing.parquet",
])
def test_names_that_are_not_cached_second_data_are_rejected(name):
    assert index.parse_day_name(name) is None and index.parse_option_name(name) is None


def test_names_match_the_loaders_that_write_the_cache(cache, monkeypatch):
    from app.services import data_loader, options_service
    monkeypatch.setattr(data_loader, "OHLCDATA_DIR", cache)
    monkeypatch.setattr(options_service, "OHLCDATA_DIR", cache)
    assert data_loader.parquet_path("NIFTY", DATE).name == index.day_filename("NIFTY", DATE)
    for strike in (24800, 24800.5):
        for right in ("CE", "PE"):
            assert options_service.options_parquet_path("NIFTY", DATE, strike, EXPIRY, right).name == index.option_filename("NIFTY", DATE, EXPIRY, right, strike)


def test_row_limits_match_the_loaders():
    from app.services import broker_service, options_service
    assert index.MIN_DAY_ROWS == broker_service._MIN_DAY_ROWS
    assert index.MIN_OPTION_ROWS == options_service._MIN_OPTIONS_DAY_ROWS


# --------------------------------------------------------------------------------- the index
def make_cache(cache):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))  # new style, fully observed
    write(cache, "NIFTY-03-10-2026.parquet", seconds_frame("2026-10-03", seed=2))  # old style, no observed column
    write(cache, "NIFTY-04-10-2026.parquet", seconds_frame("2026-10-04", observed=np.arange(22_500) < 600, seed=3))  # mostly filled
    write(cache, "NIFTY-05-10-2026.parquet", seconds_frame("2026-10-05", flat=True))  # old style, minute data spread over seconds
    write(cache, "NIFTY-06-10-2026.parquet", seconds_frame("2026-10-06", rows=5000, observed=True))  # short day
    write(cache, "NIFTY-07-10-2026-kite1m.parquet", seconds_frame("2026-10-07", observed=True))
    write(cache, "RELIND-01-10-2026.parquet", seconds_frame(observed=True))  # symbol outside the games
    write(cache, "BSESEN-01-10-2026.parquet", seconds_frame(observed=True, seed=4))
    for strike, right in ((24800, "CE"), (24900, "CE"), (24800, "PE")):
        write(cache, index.option_filename("NIFTY", DATE, EXPIRY, right, strike), seconds_frame(observed=True, seed=strike % 7, start=50))
    write(cache, index.option_filename("NIFTY", DATE, EXPIRY, "CE", 26000), seconds_frame(observed=np.arange(22_500) < 800, start=1))  # barely traded
    write(cache, index.option_filename("NIFTY", DATE, EXPIRY, "PE", 24000), seconds_frame(rows=3000, observed=True))  # partial file
    write(cache, index.option_filename("NIFTY", "2026-10-04", EXPIRY, "CE", 24800), seconds_frame("2026-10-04", observed=True))  # day not listed


def test_build_lists_only_complete_second_days_and_their_options(cache):
    make_cache(cache)
    document, stats = index.build_index(cache)
    assert document["version"] == 1 and document["generated_at"].endswith("Z")
    assert document["symbols"]["NIFTY"]["dates"] == [DATE, "2026-10-03"]
    assert document["symbols"]["BSESEN"]["dates"] == [DATE]
    assert set(document["symbols"]) == {"NIFTY", "BSESEN"}
    assert document["symbols"]["NIFTY"]["options"] == {DATE: {EXPIRY: {"CE": [24800, 24900], "PE": [24800]}}}
    assert stats.errors == [] and stats.skipped_other_symbols >= 1


def test_second_build_reads_nothing_and_a_changed_file_is_read_again(cache):
    make_cache(cache)
    first, first_stats = index.build_index(cache)
    again, stats = index.build_index(cache, previous=first)
    assert stats.read == 0 and stats.reused == first_stats.read
    assert again["symbols"] == first["symbols"]
    write(cache, "NIFTY-03-10-2026.parquet", seconds_frame("2026-10-03", rows=5000, seed=2))  # shrinks: no longer a full day
    changed, stats = index.build_index(cache, previous=again)
    assert stats.read == 1 and changed["symbols"]["NIFTY"]["dates"] == [DATE]


def test_a_damaged_file_is_reported_not_fatal(cache):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    (cache / "NIFTY-02-10-2026.parquet").write_bytes(b"not parquet")
    document, stats = index.build_index(cache)
    assert document["symbols"]["NIFTY"]["dates"] == [DATE] and len(stats.errors) == 1


def test_index_file_is_replaced_atomically_and_old_versions_are_ignored(cache, tmp_path):
    make_cache(cache)
    document, _ = index.build_index(cache)
    path = tmp_path / "out" / "index.json"
    index.write_index(document, path)
    assert index.read_index_file(path)["symbols"] == document["symbols"]
    assert not list(path.parent.glob("*.tmp"))
    path.write_text(json.dumps({**document, "version": 99}))
    assert index.read_index_file(path) is None
    path.write_text("{broken")
    assert index.read_index_file(path) is None
    assert index.read_index_file(tmp_path / "missing.json") is None


def test_the_script_builds_incrementally(cache, tmp_path):
    make_cache(cache)
    output = tmp_path / "script-index.json"
    command = [sys.executable, str(ROOT / "scripts" / "build-games-index.py"), "--data-dir", str(cache), "--output", str(output)]
    first = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
    assert first.returncode == 0, first.stderr
    assert "NIFTY: 2 days" in first.stdout and output.exists()
    second = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
    assert second.returncode == 0 and "read 0" in second.stdout
    dry = subprocess.run([*command, "--dry-run", "--output", str(tmp_path / "none.json")], capture_output=True, text=True, cwd=ROOT)
    assert dry.returncode == 0 and not (tmp_path / "none.json").exists()


# --------------------------------------------------------------------------------- /availability
def test_availability_without_an_index_says_so_and_never_scans(api, cache):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    body = api.get("/api/desktop/v1/games/availability", headers=H).json()
    assert body["index_missing"] is True and body["symbols"] == {} and not config.GAMES_INDEX_PATH.exists()


def test_availability_lists_days_with_lots_and_strike_steps_from_the_config(api, cache):
    from app.services.options_service import STRIKE_INTERVALS
    make_cache(cache)
    build(cache)
    body = api.get("/api/desktop/v1/games/availability", headers=H).json()
    nifty = body["symbols"]["NIFTY"]
    assert body["index_missing"] is False and body["version"] == 1 and "scan" not in body
    assert nifty["lot_size"] == config.LOT_SIZES["NIFTY"] and nifty["strike_step"] == STRIKE_INTERVALS["NIFTY"]
    assert body["symbols"]["BSESEN"]["lot_size"] == config.LOT_SIZES["BSESEN"]
    assert nifty["dates"] == [DATE, "2026-10-03"]
    assert nifty["options"][DATE][EXPIRY] == {"CE": [24800, 24900], "PE": [24800]}


def test_availability_follows_a_rebuilt_index_at_once(api, cache):
    make_cache(cache)
    build(cache)
    assert api.get("/api/desktop/v1/games/availability", headers=H).json()["symbols"]["NIFTY"]["dates"] == [DATE, "2026-10-03"]
    write(cache, "NIFTY-08-10-2026.parquet", seconds_frame("2026-10-08", observed=True))
    document, _ = index.build_index(cache, previous=index.read_index_file(config.GAMES_INDEX_PATH))
    index.write_index(document, config.GAMES_INDEX_PATH)  # no cache clearing: the changed file is noticed
    assert api.get("/api/desktop/v1/games/availability", headers=H).json()["symbols"]["NIFTY"]["dates"][-1] == "2026-10-08"


def test_availability_is_gzipped_only_when_asked_and_big_enough(api, cache):
    make_cache(cache)
    build(cache)
    plain = api.get("/api/desktop/v1/games/availability", headers={**H, "Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers
    big = {"dates": [f"2026-{m:02d}-{d:02d}" for m in range(1, 10) for d in range(1, 25)]}
    body, headers = data.encode_json(big, "gzip, deflate")
    assert headers["Content-Encoding"] == "gzip" and json.loads(gzip.decompress(body)) == big
    assert "Content-Encoding" not in data.encode_json(big, "deflate")[1] and "Content-Encoding" not in data.encode_json(big, "")[1]
    assert data.encode_json({"a": 1}, "gzip")[1].get("Content-Encoding") is None  # too small to bother


# --------------------------------------------------------------------------------- /window
def window(api, **query):
    params = {"symbol": "NIFTY", "date": DATE, "start_sec": 34_200, "duration_sec": 300, "interval_seconds": 1, **query}
    return api.get("/api/desktop/v1/games/window", params=params, headers=H)


def test_window_returns_integer_paise_struct_of_arrays(api, cache):
    frame = seconds_frame(observed=True)
    write(cache, "NIFTY-01-10-2026.parquet", frame)
    response = window(api)
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 300 and body["t"][0] == 34_200 and body["t"][-1] == 34_499 and body["interval_seconds"] == 1
    assert set(body) >= {"symbol", "date", "start_sec", "duration_sec", "count", "t", "o", "h", "l", "c"}
    rows = frame.loc[f"{DATE} 09:30:00":f"{DATE} 09:34:59"]
    assert body["o"] == [round(v * 100) for v in rows["open"]] and body["c"] == [round(v * 100) for v in rows["close"]]
    assert all(isinstance(v, int) for key in "ohlc" for v in body[key])
    assert "volume" not in body and "observed" not in body


def test_window_never_returns_filled_rows(api, cache):
    frame = seconds_frame(observed=True)
    flags = np.ones(len(frame), dtype=bool)
    flags[34_200 - 33_300 + 10: 34_200 - 33_300 + 60] = False  # 09:30:10..09:30:59 were filled
    frame["observed"] = flags
    write(cache, "NIFTY-01-10-2026.parquet", frame)
    body = window(api).json()
    assert body["count"] == 300 - 50
    assert not any(34_210 <= t < 34_260 for t in body["t"])


def test_window_of_an_old_file_drops_the_back_filled_opening_run(api, cache):
    frame = seconds_frame()  # no observed column
    frame.iloc[:40] = frame.iloc[40].to_numpy()  # the first 40 seconds repeat a later price, as back-filling does
    write(cache, "NIFTY-01-10-2026.parquet", frame)
    body = window(api, start_sec=33_300, duration_sec=100).json()
    assert body["t"][0] >= 33_300 + 39 and body["count"] <= 61


def test_window_option_contract(api, cache):
    write(cache, index.day_filename("NIFTY", DATE), seconds_frame(observed=True))
    write(cache, index.option_filename("NIFTY", DATE, EXPIRY, "CE", 24800), seconds_frame(observed=True, start=87.5))
    body = window(api, expiry=EXPIRY, strike=24800, right="CE").json()
    assert body["count"] == 300 and body["right"] == "CE" and body["strike"] == 24800 and body["expiry"] == EXPIRY
    assert 5000 < body["c"][0] < 12000  # paise of a premium near 87.5
    assert window(api, expiry=EXPIRY, strike=24800, right="PE").status_code == 404


def test_window_minute_candles_are_whole_minutes(api, cache):
    frame = seconds_frame(observed=True)
    write(cache, "NIFTY-01-10-2026.parquet", frame)
    body = window(api, interval_seconds=60, start_sec=34_230, duration_sec=300).json()
    assert body["t"] == [34_260, 34_320, 34_380, 34_440, 34_500]  # candles that start inside the window, never a cut-off first one
    minute = frame.loc[f"{DATE} 09:31:00":f"{DATE} 09:31:59"]
    index_of = body["t"].index(34_260)
    assert body["o"][index_of] == round(minute["open"].iloc[0] * 100) and body["c"][index_of] == round(minute["close"].iloc[-1] * 100)
    assert body["h"][index_of] == round(minute["high"].max() * 100) and body["l"][index_of] == round(minute["low"].min() * 100)


def test_whole_day_of_minutes_is_allowed_but_a_long_second_window_is_not(api, cache):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    day = window(api, interval_seconds=60, start_sec=0, duration_sec=86_400)
    assert day.status_code == 200 and 370 <= day.json()["count"] <= 376
    assert window(api, duration_sec=config.GAMES_MAX_WINDOW_SECONDS).status_code == 200
    assert window(api, duration_sec=config.GAMES_MAX_WINDOW_SECONDS + 1).status_code == 422


def test_window_after_the_close_is_empty_not_an_error(api, cache):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    body = window(api, start_sec=60_000).json()
    assert body["count"] == 0 and body["t"] == [] and body["o"] == []


def test_window_is_gzipped_when_accepted(api, cache):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    body, headers = data.encode_json(data.get_window("NIFTY", DATE, 34_200, 300, 1), "gzip")
    assert headers["Content-Encoding"] == "gzip" and headers["Vary"] == "Accept-Encoding"
    assert len(body) < len(json.dumps(data.get_window("NIFTY", DATE, 34_200, 300, 1))) / 2
    response = window(api)
    assert response.headers["content-type"] == "application/json" and response.json()["count"] == 300


@pytest.mark.parametrize("query", [
    {"symbol": "RELIND"}, {"symbol": "nifty"}, {"date": "2026-13-01"}, {"date": "01-10-2026"}, {"interval_seconds": 5}, {"interval_seconds": 15},
    {"interval_seconds": 0}, {"start_sec": 86_400}, {"start_sec": -1}, {"duration_sec": 0}, {"duration_sec": 100_000},
    {"expiry": EXPIRY}, {"strike": 24800}, {"right": "CE"}, {"expiry": EXPIRY, "strike": 24800}, {"expiry": EXPIRY, "strike": 24800, "right": "XX"},
    {"expiry": EXPIRY, "strike": -5, "right": "CE"}, {"expiry": "2026-09-01", "strike": 24800, "right": "CE"}, {"expiry": "6/10", "strike": 24800, "right": "CE"},
    {"expiry": EXPIRY, "strike": "nan", "right": "CE"},
])
def test_window_rejects_bad_parameters(api, cache, query):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    assert window(api, **query).status_code == 422


def test_window_missing_parameters_are_422(api):
    assert api.get("/api/desktop/v1/games/window", params={"symbol": "NIFTY", "date": DATE}, headers=H).status_code == 422


def test_routes_need_a_user_and_are_rate_limited(api, cache, monkeypatch):
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    assert api.get("/api/desktop/v1/games/availability").status_code in (401, 403)
    assert api.get("/api/desktop/v1/games/window", params={"symbol": "NIFTY", "date": DATE, "start_sec": 0, "duration_sec": 10}).status_code in (401, 403)
    monkeypatch.setattr(desktop_games, "_window_reads", TokenBucket(0.001, 2))
    codes = [window(api).status_code for _ in range(4)]
    assert codes[:2] == [200, 200] and codes[2:] == [429, 429]
    other = api.get("/api/desktop/v1/games/window", params={"symbol": "NIFTY", "date": DATE, "start_sec": 34_200, "duration_sec": 10}, headers={"X-User-Id": "bob"})
    assert other.status_code == 200  # the limit is per user


def test_the_frame_cache_is_small_and_notices_a_rewritten_file(api, cache):
    path = write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True))
    first = window(api).json()
    write(cache, "NIFTY-01-10-2026.parquet", seconds_frame(observed=True, start=200.0))
    assert window(api).json()["o"][0] != first["o"][0]
    for day in range(2, 9):
        write(cache, f"NIFTY-0{day}-10-2026.parquet", seconds_frame(f"2026-10-0{day}", observed=True))
        window(api, date=f"2026-10-0{day}")
    assert len(data._frames) <= data.FRAME_CACHE_SIZE and path.exists()


# --------------------------------------------------------------------------------- cache-only guarantees
def forbid_downloads(monkeypatch):
    """Make every loader that could download or call a broker explode; a cache miss must not reach any of them."""
    from app.services import broker_service, data_loader, historical_data_service, options_service
    def boom(*args, **kwargs):
        raise AssertionError("a Games request reached a download or a broker")
    for module, names in (
        (broker_service, ["fetch_historical", "_fetch_breeze_historical", "_fetch_breeze_historical_unlocked", "_fetch_day_paginated"]),
        (options_service, ["fetch_options_historical", "_fetch_breeze_options_historical", "_fetch_options_historical_unlocked", "_fetch_options_day_paginated"]),
        (historical_data_service, ["load_history", "_fetch"]),
        (data_loader, ["_load_breeze_dataframe"]),
    ):
        for name in names:
            monkeypatch.setattr(module, name, boom, raising=False)


def test_a_miss_is_404_and_reaches_no_download_or_broker(api, cache, monkeypatch):
    forbid_downloads(monkeypatch)
    response = window(api)
    assert response.status_code == 404 and response.json() == {"reason": "not_cached"}
    assert window(api, expiry=EXPIRY, strike=24800, right="CE").status_code == 404
    assert window(api, symbol="BSESEN", interval_seconds=60, start_sec=0, duration_sec=86_400).status_code == 404
    # A day that only exists as a provider minute file, or a legacy pickle, is still not cached second data.
    write(cache, "NIFTY-01-10-2026-kite1m.parquet", seconds_frame(observed=True))
    assert window(api).status_code == 404


def test_hits_and_availability_also_stay_in_the_cache(api, cache, monkeypatch):
    forbid_downloads(monkeypatch)
    make_cache(cache)
    build(cache)
    assert api.get("/api/desktop/v1/games/availability", headers=H).status_code == 200
    assert window(api).status_code == 200


def test_an_unreadable_file_is_a_miss_not_a_crash(api, cache):
    (cache / "NIFTY-01-10-2026.parquet").write_bytes(b"garbage")
    assert window(api).status_code == 404


def test_data_modules_import_no_trading_or_download_code():
    forbidden_imports = re.compile(r"^\s*(?:from|import)\s+app\.(?:services\.(?:order|trading|session|simulation|kotak|breeze|kite|fyers|broker|execution|guardrail|strateg|wallet|real_|historical_data|history_)\w*|routers\.(?:orders|trading|simulation|kotak|breeze|execution_brokers|guardrails|strategies|wallet))", re.M)
    forbidden_calls = re.compile(r"\b(load_history|_ensure_data|fetch_historical|fetch_options_historical|_load_breeze_dataframe|load_dataframe|ensure_)\w*\(")
    for relative in ("app/services/games_index.py", "app/services/games_data_service.py", "app/routers/desktop_games.py"):
        text = (Path(__file__).resolve().parents[1] / relative).read_text()
        assert not forbidden_imports.search(text), relative
        assert not forbidden_calls.search(text), relative
    assert "kite" not in (ROOT / "scripts" / "build-games-index.py").read_text().lower()
