"""Index of the cached second-level days the Games can use (Phase 25, G1).

``scripts/build-games-index.py`` runs :func:`build_index` by hand after the data cache is refreshed;
``GET /games/availability`` only reads the file it writes. Nothing here downloads, fetches or calls a broker:
it lists ``OHLCDATA_DIR`` and reads parquet files that are already on disk.

What counts as a usable day (G0-close answer 1): the file name is exactly ``SYMBOL-DD-MM-YYYY.parquet`` (the
``-kite1m`` / ``-kotak1m`` provider files are not second data), it has at least ``MIN_DAY_ROWS`` rows, and
the rows are genuine seconds, not minutes spread over seconds by gap filling:

* files that carry the ``observed`` column (written since provenance was recorded) need ``MIN_OBSERVED_ROWS``
  observed rows;
* older files have no such column, so a day needs ``MIN_CHANGED_ROWS`` seconds whose price differs from the
  previous second (a minute-level file forward-filled to seconds changes at most once a minute).

The parquet files carry no ``native_interval_seconds`` metadata (checked on the real cache), so these two
tests stand in for it. Options use the same two row limits at a lower observed floor, because far strikes trade rarely.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import date as calendar_date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

INDEX_VERSION = 1
# Spec 3.2 and plan G0-close #1: the only symbols with enough second-level history.
GAMES_SYMBOLS = ("NIFTY", "BSESEN")

# Same values as broker_service._MIN_DAY_ROWS and options_service._MIN_OPTIONS_DAY_ROWS (a test keeps them equal; this
# module may not import the broker code).
MIN_DAY_ROWS = 20_000
MIN_OPTION_ROWS = 20_000
MIN_OBSERVED_ROWS = 15_000
MIN_CHANGED_ROWS = 10_000
MIN_OPTION_OBSERVED_ROWS = 10_000

_PRICE_COLUMNS = ["open", "high", "low", "close"]
_DAY_NAME = re.compile(r"^([A-Z0-9]+)-(\d{2})-(\d{2})-(\d{4})\.parquet$")
_OPTION_NAME = re.compile(r"^([A-Z0-9]+)-(CE|PE)-(\d+(?:\.\d+)?)-(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{4})\.parquet$")


def ohlc_dir() -> Path:
    """The cache directory, read at call time so tests and deployments can change it."""
    from app import config
    return Path(config.OHLCDATA_DIR)


def strike_text(strike: int | float) -> str:
    """A strike as it appears in file names: ``24800`` or ``24800.5``."""
    number = float(strike)
    return str(int(number)) if number.is_integer() else repr(number)


def day_filename(symbol: str, date: str) -> str:
    y, m, d = date.split("-")
    return f"{symbol}-{d}-{m}-{y}.parquet"


def option_filename(symbol: str, date: str, expiry: str, right: str, strike: int | float) -> str:
    y, m, d = date.split("-")
    ey, em, ed = expiry.split("-")
    return f"{symbol}-{right}-{strike_text(strike)}-{ed}-{em}-{ey}-{d}-{m}-{y}.parquet"


def _valid_date(year: str, month: str, day: str) -> str | None:
    try:
        return calendar_date(int(year), int(month), int(day)).isoformat()
    except ValueError:
        return None


def parse_day_name(name: str) -> tuple[str, str] | None:
    """``NIFTY-01-10-2026.parquet`` -> ``("NIFTY", "2026-10-01")``."""
    match = _DAY_NAME.match(name)
    if not match:
        return None
    date = _valid_date(match.group(4), match.group(3), match.group(2))
    return (match.group(1), date) if date else None


def parse_option_name(name: str) -> tuple[str, str, str, str, int | float] | None:
    """``NIFTY-CE-24800-06-10-2026-01-10-2026.parquet`` -> ``(symbol, date, expiry, right, strike)``."""
    match = _OPTION_NAME.match(name)
    if not match:
        return None
    expiry = _valid_date(match.group(6), match.group(5), match.group(4))
    date = _valid_date(match.group(9), match.group(8), match.group(7))
    if not expiry or not date:
        return None
    strike = float(match.group(3))
    return match.group(1), date, expiry, match.group(2), int(strike) if strike.is_integer() else strike


@dataclass
class ScanStats:
    day_files: int = 0
    option_files: int = 0
    read: int = 0
    reused: int = 0
    skipped_other_symbols: int = 0
    errors: list[str] = field(default_factory=list)


def _observed_column(path: Path) -> np.ndarray | None:
    """The ``observed`` flags of a file, or None when it was written before provenance was recorded."""
    if "observed" not in pq.ParquetFile(path).schema_arrow.names:
        return None
    flags = pq.read_table(path, columns=["observed"]).column(0).to_pandas()
    return flags.fillna(False).astype(bool).to_numpy()


def day_summary(path: Path) -> tuple[int, int]:
    """``(observed rows, changed rows)`` of an underlying day file; observed counts every row of an older file."""
    frame = pd.read_parquet(path)
    frame.columns = [str(c).lower() for c in frame.columns]
    flags = frame["observed"].fillna(False).astype(bool).to_numpy() if "observed" in frame.columns else None
    values = frame[_PRICE_COLUMNS].to_numpy(dtype=float)
    changed = int((values[1:] != values[:-1]).any(axis=1).sum()) if len(values) > 1 else 0
    observed = int(flags.sum()) if flags is not None else len(values)
    return observed, changed


def day_ok(rows: int, observed: int, changed: int, has_observed_column: bool) -> bool:
    if rows < MIN_DAY_ROWS:
        return False
    return observed >= MIN_OBSERVED_ROWS if has_observed_column else changed >= MIN_CHANGED_ROWS


def option_ok(rows: int, observed: int | None) -> bool:
    if rows < MIN_OPTION_ROWS:
        return False
    return observed is None or observed >= MIN_OPTION_OBSERVED_ROWS


def build_index(directory: Path | None = None, previous: dict | None = None, symbols: tuple[str, ...] = GAMES_SYMBOLS,
                now: datetime | None = None) -> tuple[dict, ScanStats]:
    """Scan ``directory`` and return the index document plus counters.

    ``previous`` is an earlier index document: a file whose size and modification time are unchanged is not read
    again (its verdict is copied from the ``scan`` section), which makes a re-run after a data refresh quick.
    """
    directory = Path(directory) if directory is not None else ohlc_dir()
    old_scan: dict = (previous or {}).get("scan", {}) if (previous or {}).get("version") == INDEX_VERSION else {}
    stats = ScanStats()
    scan: dict[str, list] = {}
    days: dict[str, dict[str, str]] = {symbol: {} for symbol in symbols}
    option_candidates: list[tuple[str, str, str, str, int | float, str]] = []
    day_ok_dates: dict[str, set[str]] = {symbol: set() for symbol in symbols}

    entries = [entry for entry in os.scandir(directory) if entry.is_file()]
    entries.sort(key=lambda entry: entry.name)
    for entry in entries:
        parsed = parse_day_name(entry.name)
        if parsed:
            symbol, date = parsed
            if symbol not in symbols:
                stats.skipped_other_symbols += 1
                continue
            stats.day_files += 1
            info = entry.stat()
            signature = [info.st_size, info.st_mtime_ns]
            cached = old_scan.get(entry.name)
            if cached and cached[:2] == signature and len(cached) == 4:
                stats.reused += 1
                flag = cached[2]
            else:
                stats.read += 1
                try:
                    rows = pq.ParquetFile(entry.path).metadata.num_rows
                    has_column = "observed" in pq.ParquetFile(entry.path).schema_arrow.names
                    observed, changed = day_summary(Path(entry.path)) if rows >= MIN_DAY_ROWS else (0, 0)
                    flag = int(day_ok(rows, observed, changed, has_column))
                    cached = signature + [flag, observed]
                except Exception as error:  # a damaged file must not stop the whole build
                    stats.errors.append(f"{entry.name}: {error}")
                    continue
            scan[entry.name] = signature + [flag, cached[3] if len(cached) == 4 else 0]
            if flag:
                days[symbol][date] = entry.name
                day_ok_dates[symbol].add(date)
            continue
        option = parse_option_name(entry.name)
        if option and option[0] in symbols:
            option_candidates.append((*option, entry.name))
        elif option:
            stats.skipped_other_symbols += 1

    options: dict[str, dict[str, dict[str, dict[str, list]]]] = {symbol: {} for symbol in symbols}
    for symbol, date, expiry, right, strike, name in option_candidates:
        if date not in day_ok_dates[symbol]:
            continue
        stats.option_files += 1
        path = directory / name
        info = path.stat()
        signature = [info.st_size, info.st_mtime_ns]
        cached = old_scan.get(name)
        if cached and cached[:2] == signature and len(cached) == 4:
            stats.reused += 1
            flag = cached[2]
        else:
            stats.read += 1
            try:
                rows = pq.ParquetFile(path).metadata.num_rows
                flags = _observed_column(path) if rows >= MIN_OPTION_ROWS else None
                observed = int(flags.sum()) if flags is not None else None
                flag = int(option_ok(rows, observed))
                cached = signature + [flag, observed if observed is not None else -1]
            except Exception as error:
                stats.errors.append(f"{name}: {error}")
                continue
        scan[name] = signature + [flag, cached[3]]
        if flag:
            by_expiry = options[symbol].setdefault(date, {}).setdefault(expiry, {"CE": [], "PE": []})
            by_expiry[right].append(strike)
    for by_date in options.values():
        for by_expiry in by_date.values():
            for sides in by_expiry.values():
                for side in sides.values():
                    side.sort()

    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    document = {
        "version": INDEX_VERSION,
        "generated_at": stamp,
        "symbols": {symbol: {"dates": sorted(days[symbol]), "options": dict(sorted(options[symbol].items()))} for symbol in symbols},
        "scan": scan,
    }
    return document, stats


def write_index(document: dict, path: Path) -> None:
    """Write atomically so a request never reads half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    os.replace(temp, path)


def read_index_file(path: Path) -> dict | None:
    """The index document, or None when the file is missing, unreadable or from another version."""
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(document, dict) or document.get("version") != INDEX_VERSION or not isinstance(document.get("symbols"), dict):
        return None
    return document
