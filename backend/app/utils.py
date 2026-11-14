from __future__ import annotations

import datetime as _dt
import json as _json
import os as _os
import threading as _threading
from pathlib import Path as _Path


# NSE/BSE market holidays (2023–2026). Source: official NSE/BSE holiday calendar.
# Update annually when the exchange publishes the next year's list.
NSE_HOLIDAYS: frozenset[_dt.date] = frozenset({
    # 2023
    _dt.date(2023, 8, 15),   # Independence Day
    _dt.date(2023, 9, 19),   # Ganesh Chaturthi
    _dt.date(2023, 10, 2),   # Gandhi Jayanti
    _dt.date(2023, 10, 24),  # Dussehra (Vijaya Dashami)
    _dt.date(2023, 10, 27),  # Diwali Laxmi Puja
    _dt.date(2023, 11, 14),  # Diwali Balipratipada
    _dt.date(2023, 12, 25),  # Christmas
    # 2024
    _dt.date(2024, 1, 22),   # Ram Mandir Consecration (special)
    _dt.date(2024, 1, 26),   # Republic Day
    _dt.date(2024, 3, 8),    # Mahashivratri
    _dt.date(2024, 3, 25),   # Holi
    _dt.date(2024, 3, 29),   # Good Friday
    _dt.date(2024, 4, 11),   # Eid ul-Fitr
    _dt.date(2024, 4, 17),   # Ram Navami
    _dt.date(2024, 5, 1),    # Maharashtra Day
    _dt.date(2024, 5, 20),   # General election day (Mumbai)
    _dt.date(2024, 6, 17),   # Eid ul-Adha
    _dt.date(2024, 7, 17),   # Muharram
    _dt.date(2024, 8, 15),   # Independence Day
    _dt.date(2024, 10, 2),   # Gandhi Jayanti
    _dt.date(2024, 11, 1),   # Diwali Laxmi Puja
    _dt.date(2024, 11, 15),  # Gurunanak Jayanti
    _dt.date(2024, 11, 20),  # Maharashtra assembly election day
    _dt.date(2024, 12, 25),  # Christmas
    # 2025
    _dt.date(2025, 2, 26),   # Mahashivratri
    _dt.date(2025, 3, 14),   # Holi
    _dt.date(2025, 3, 31),   # Eid ul-Fitr
    _dt.date(2025, 4, 10),   # Mahavir Jayanti
    _dt.date(2025, 4, 14),   # Dr. Ambedkar Jayanti
    _dt.date(2025, 4, 18),   # Good Friday
    _dt.date(2025, 5, 1),    # Maharashtra Day
    _dt.date(2025, 8, 6),    # Muharram
    _dt.date(2025, 8, 15),   # Independence Day
    _dt.date(2025, 8, 27),   # Ganesh Chaturthi
    _dt.date(2025, 10, 2),   # Gandhi Jayanti
    _dt.date(2025, 10, 21),  # Diwali Laxmi Puja
    _dt.date(2025, 10, 22),  # Diwali Balipratipada
    _dt.date(2025, 11, 5),   # Gurunanak Jayanti
    _dt.date(2025, 12, 25),  # Christmas
    # 2026
    _dt.date(2026, 1, 15),   # Makar Sankranti
    _dt.date(2026, 1, 26),   # Republic Day
    _dt.date(2026, 3, 3),    # Mahashivratri
    _dt.date(2026, 3, 26),   # Holi
    _dt.date(2026, 3, 31),   # Eid ul-Fitr
    _dt.date(2026, 4, 3),    # Good Friday
    _dt.date(2026, 4, 14),   # Dr. Ambedkar Jayanti
    _dt.date(2026, 5, 1),    # Maharashtra Day
    _dt.date(2026, 5, 28),   # Eid ul-Adha
    _dt.date(2026, 6, 26),   # Muharram
    _dt.date(2026, 9, 14),   # Milad-un-Nabi
    _dt.date(2026, 10, 2),   # Gandhi Jayanti
    _dt.date(2026, 10, 20),  # Diwali Laxmi Puja
    _dt.date(2026, 11, 10),  # Gurunanak Jayanti
    _dt.date(2026, 11, 24),  # Market holiday
    _dt.date(2026, 12, 25),  # Christmas
})


# ── Operator-added holidays ──────────────────────────────────────────────────
# NSE sometimes announces a closure after the list above was written (or the list
# is simply wrong for a day). Those dates live in DATA_DIR/holidays.json so they can
# be added at run time (PUT/POST /api/admin/holidays) without a deploy or restart.
# The file is re-read when its modification time changes, so a hand edit also works.

_extra_lock = _threading.Lock()
_extra_cache: tuple[tuple[int, int] | None, dict[_dt.date, str]] = (None, {})


def _holidays_file() -> _Path:
    from app.config import DATA_DIR
    return _Path(DATA_DIR) / "holidays.json"


def extra_holidays() -> dict[_dt.date, str]:
    """Holidays added by the operator, as {date: note}. Missing or unreadable file means none."""
    global _extra_cache
    path = _holidays_file()
    try:
        stat = path.stat()
        stamp: tuple[int, int] | None = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        stamp = None
    with _extra_lock:
        if _extra_cache[0] == stamp:
            return dict(_extra_cache[1])
        found: dict[_dt.date, str] = {}
        if stamp is not None:
            try:
                data = _json.loads(path.read_text(encoding="utf-8"))
                for key, note in (data.get("holidays") or {}).items():
                    try:
                        found[_dt.date.fromisoformat(key)] = str(note or "")
                    except ValueError:
                        continue
            except (OSError, ValueError, AttributeError):
                found = {}
        _extra_cache = (stamp, found)
        return dict(found)


def _write_extra_holidays(holidays: dict[_dt.date, str]) -> None:
    path = _holidays_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {"holidays": {d.isoformat(): note for d, note in sorted(holidays.items())}}
    tmp = path.with_name(path.name + f".{_os.getpid()}.tmp")
    tmp.write_text(_json.dumps(body, indent=2), encoding="utf-8")
    _os.replace(tmp, path)


def add_extra_holiday(day: _dt.date, note: str = "") -> dict[_dt.date, str]:
    current = extra_holidays()
    current[day] = note.strip()[:100]
    _write_extra_holidays(current)
    return extra_holidays()


def remove_extra_holiday(day: _dt.date) -> dict[_dt.date, str]:
    current = extra_holidays()
    if day in current:
        del current[day]
        _write_extra_holidays(current)
    return extra_holidays()


def is_trading_day(d: _dt.date) -> bool:
    return d.weekday() < 5 and d not in NSE_HOLIDAYS and d not in extra_holidays()


def prior_trading_days(date_str: str, n: int = 2) -> list[str]:
    """
    Return n trading days (YYYY-MM-DD) immediately before date_str,
    skipping weekends and NSE public holidays.
    Results are in chronological order (oldest first).
    """
    d = _dt.date.fromisoformat(date_str)
    result: list[str] = []
    current = d - _dt.timedelta(days=1)
    while len(result) < n:
        if is_trading_day(current):
            result.append(current.isoformat())
        current -= _dt.timedelta(days=1)
    return list(reversed(result))
