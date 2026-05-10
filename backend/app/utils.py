from __future__ import annotations

from datetime import date, timedelta


def prior_trading_days(date_str: str, n: int = 2) -> list[str]:
    """
    Return n trading days (YYYY-MM-DD) immediately before date_str,
    skipping weekends. Does not account for NSE public holidays —
    if a fetched date returns no data, the caller should handle it gracefully.
    Results are in chronological order (oldest first).
    """
    d = date.fromisoformat(date_str)
    result: list[str] = []
    current = d - timedelta(days=1)
    while len(result) < n:
        if current.weekday() < 5:  # Mon=0 … Fri=4
            result.append(current.isoformat())
        current -= timedelta(days=1)
    return list(reversed(result))
