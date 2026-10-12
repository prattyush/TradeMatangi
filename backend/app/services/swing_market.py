"""Swing session clock: actual UTC for scheduling, IST-wall-clock seconds for ticks."""

from datetime import UTC, datetime, timedelta

from app.utils import is_trading_day


def window(timestamp):
    date = datetime.fromtimestamp(int(timestamp), UTC).date()
    if not is_trading_day(date):
        return None
    start = int(
        datetime.fromisoformat(date.isoformat() + "T09:15:00")
        .replace(tzinfo=UTC)
        .timestamp()
    )
    end = closing(date.isoformat())
    return (
        {"date": date.isoformat(), "opening": start, "closing": end}
        if start <= int(timestamp) < end
        else None
    )


def now():
    return int(datetime.now(UTC).timestamp()) + 19800


def today():
    return (datetime.now(UTC) + timedelta(seconds=19800)).date().isoformat()


def closing(date):
    return int(
        datetime.fromisoformat(date + "T15:30:00").replace(tzinfo=UTC).timestamp()
    )
