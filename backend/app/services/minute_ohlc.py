"""Candles for the read-only Patterns and Structures screens, built from minute data.

Pattern Library, Chart Structures and Fine Structures only draw candles of one minute or more and never start a replay,
so they read minute data (``minute_history``, the same source as Browse) instead of Breeze second-level downloads,
which are paced 1.5 s apart (about 25 requests per option day). Replay, stepwise and the Analysis sections keep their
second-level data; nothing here can reach them (``minute_history`` never writes second-level file names).

Differences from the second-level path, by design: no gap fill (an option minute with no trade is absent instead of
a flat back-filled candle), and the provider's own minute OHLC and volume. Indices report no volume, as before.
"""
from __future__ import annotations

import logging

import pandas as pd
from fastapi import HTTPException

from app.services import minute_history
from app.services.broker_service import BreezeTokenError
from app.services.data_loader import _is_index, candles_to_records, resample_to_candles
from app.services.history_workers import run_data_history
from app.utils import prior_trading_days

logger = logging.getLogger(__name__)

_PRICE_COLUMNS = ["open", "high", "low", "close"]


def _day_frame(symbol: str, date: str, strike=None, expiry: str | None = None, right: str | None = None) -> pd.DataFrame:
    frame = minute_history.load(symbol, date, strike, expiry, right).frame
    # Minute frames carry volume 0 for an index; the second-level path omits it. Keep the response the same.
    # Only the index itself has no volume: its option contracts do.
    no_volume = right is None and _is_index(symbol)
    columns = _PRICE_COLUMNS + (["volume"] if "volume" in frame.columns and not no_volume else [])
    return frame[columns]


def candle_records(
    symbol: str,
    date: str,
    interval_minutes: int,
    days_back: int,
    *,
    strike=None,
    expiry: str | None = None,
    right: str | None = None,
) -> list[dict]:
    """``days_back`` prior trading days plus ``date`` as candle records of ``interval_minutes``.

    A prior day with no data (or whose provider failed) is skipped, as before; the selected day raises
    ``FileNotFoundError`` / ``RuntimeError`` / ``BreezeTokenError`` from ``minute_history.load``.
    """
    frames = []
    for day in prior_trading_days(date, n=days_back):
        try:
            frames.append(_day_frame(symbol, day, strike, expiry, right))
        except (FileNotFoundError, RuntimeError):
            logger.info("minute_ohlc: no context data for %s on %s - skipping", symbol, day)
    frames.append(_day_frame(symbol, date, strike, expiry, right))
    combined = pd.concat(frames).sort_index()
    return candles_to_records(resample_to_candles(combined, interval_minutes))


async def load_candle_records(
    symbol: str, date: str, interval_minutes: int, days_back: int, *, not_found: str | None = None, **contract
) -> list[dict]:
    """``candle_records`` off the event loop, with the error contract of the other minute routes.

    503 for an expired Breeze session, 404 (``not_found`` as the message, when given) for a day with no data, 404 for a
    failed provider; an ``HTTPException`` from the instrument lookup (for example 422 for an unsupported symbol) passes
    through.
    """
    try:
        return await run_data_history(candle_records, symbol, date, interval_minutes, days_back, **contract)
    except BreezeTokenError as exc:
        logger.error("minute_ohlc: Breeze token error for %s %s - %s", symbol, date, exc)
        raise HTTPException(status_code=503, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=not_found or f"No data for {symbol} on {date}")
    except RuntimeError as exc:
        logger.error("minute_ohlc: %s %s - %s", symbol, date, exc)
        raise HTTPException(status_code=404, detail=str(exc))
