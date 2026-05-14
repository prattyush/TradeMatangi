from __future__ import annotations

import logging
import re
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from app.models.schemas import (
    HistoricalDataResponse,
    OHLCCandle,
    SymbolInfo,
    SymbolsResponse,
    AvailableDatesResponse,
    PreSessionDataResponse,
    PriceAtResponse,
    ExpiryResponse,
)
from app.services.data_loader import (
    load_dataframe,
    resample_to_candles,
    candles_to_records,
    pre_session_candles,
)
from app.services.broker_service import fetch_historical, BreezeTokenError, BreezeSymbolError
from app.config import DEFAULT_SYMBOL, CANDLE_INTERVAL_MINUTES, SUPPORTED_SYMBOLS, DATA_DIR
from app.utils import prior_trading_days

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/data", tags=["data"])


def _ensure_data(symbol: str, date: str) -> None:
    """
    Ensure a data file exists for symbol+date (parquet or legacy pickle).
    Triggers a Breeze fetch and saves parquet if nothing cached.
    Raises HTTPException on failure.
    """
    try:
        fetch_historical(symbol, date)
    except BreezeTokenError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except BreezeSymbolError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Unexpected error fetching %s %s", symbol, date)
        raise HTTPException(status_code=500, detail=f"Data fetch failed: {e}")


@router.get("/symbols", response_model=SymbolsResponse)
async def get_symbols():
    """Return all supported symbols with display names."""
    return SymbolsResponse(
        symbols=[
            SymbolInfo(symbol=k, display_name=v["display_name"])
            for k, v in SUPPORTED_SYMBOLS.items()
        ]
    )


@router.get("/available-dates", response_model=AvailableDatesResponse)
async def get_available_dates(symbol: str = Query(default=DEFAULT_SYMBOL)):
    """Return dates for which a local pickle cache exists for the given symbol."""
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")

    dates: list[str] = []
    prefix_len = len(symbol) + 1  # "SYMBOL-"
    for pkl in sorted(DATA_DIR.glob(f"{symbol}-*.pickle")):
        # Filename: SYMBOL-DD-MM-YYYY.pickle
        parts = pkl.stem[prefix_len:].split("-")
        if len(parts) == 3:
            d, m, y = parts
            dates.append(f"{y}-{m}-{d}")

    return AvailableDatesResponse(symbol=symbol, dates=sorted(dates))


@router.get("/historical", response_model=HistoricalDataResponse)
async def get_historical(
    symbol: str = Query(default=DEFAULT_SYMBOL),
    trading_date: str = Query(default="2026-05-06"),
    interval_minutes: int = Query(default=CANDLE_INTERVAL_MINUTES, ge=1, le=60),
):
    """
    Return OHLC candles for the two trading days prior to trading_date.
    Fetches from Breeze if a local pickle is not cached.
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")

    prior_dates = prior_trading_days(trading_date, n=2)
    all_candles: list[OHLCCandle] = []

    for date in prior_dates:
        _ensure_data(symbol, date)
        try:
            df = load_dataframe(symbol, date)
            candles = resample_to_candles(df, interval_minutes)
            records = candles_to_records(candles)
            all_candles.extend(OHLCCandle(**r) for r in records)
        except FileNotFoundError:
            raise HTTPException(
                status_code=404,
                detail=f"Data not found for {symbol} on {date}",
            )

    return HistoricalDataResponse(
        symbol=symbol,
        dates=prior_dates,
        candles=all_candles,
    )


@router.get("/pre-session", response_model=PreSessionDataResponse)
async def get_pre_session(
    symbol: str = Query(default=DEFAULT_SYMBOL),
    trading_date: str = Query(...),
    start_time: str = Query(default="09:15"),
    interval_minutes: int = Query(default=CANDLE_INTERVAL_MINUTES, ge=1, le=60),
):
    """
    Return candles for trading_date from market open (09:15) up to start_time.
    Used to fill the chart gap when replay starts mid-session.
    start_time format: HH:MM or HH:MM:SS
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")

    if not re.match(r'^\d{2}:\d{2}(:\d{2})?$', start_time):
        raise HTTPException(status_code=422, detail="start_time must be HH:MM or HH:MM:SS")

    # Normalise to HH:MM:SS
    if len(start_time) == 5:
        start_time = start_time + ":00"

    _ensure_data(symbol, trading_date)

    try:
        candles = pre_session_candles(symbol, trading_date, start_time, interval_minutes)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"Data not found for {symbol} on {trading_date}",
        )

    return PreSessionDataResponse(
        symbol=symbol,
        date=trading_date,
        start_time=start_time,
        candles=[OHLCCandle(**c) for c in candles],
    )


@router.get("/options-historical", response_model=HistoricalDataResponse)
async def get_options_historical(
    symbol: str = Query(...),
    date: str = Query(...),
    strike: int = Query(...),
    expiry: str = Query(...),
    right: str = Query(...),
    interval_minutes: int = Query(default=CANDLE_INTERVAL_MINUTES, ge=1, le=60),
):
    """
    Return OHLC candles for an options contract for the two trading days prior to date.
    Fetches from Breeze if not yet cached. Used to populate options chart panes.
    right: "CE" or "PE"
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")
    if right.upper() not in ("CE", "PE"):
        raise HTTPException(status_code=400, detail="right must be CE or PE")

    from app.services.options_service import fetch_options_historical, load_options_dataframe
    from app.services.broker_service import BreezeTokenError

    # Fetch 2 prior days for context + the trading date itself (pre-session candles)
    prior_dates = prior_trading_days(date, n=2) + [date]
    all_candles: list[OHLCCandle] = []

    for prior_date in prior_dates:
        try:
            fetch_options_historical(symbol, prior_date, strike, expiry, right.upper())
            df = load_options_dataframe(symbol, prior_date, strike, expiry, right.upper())
            candles = resample_to_candles(df, interval_minutes)
            records = candles_to_records(candles)
            all_candles.extend(OHLCCandle(**r) for r in records)
        except BreezeTokenError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except FileNotFoundError:
            logger.warning(
                "Options data not found for %s %s %s on %s — skipping prior day",
                symbol, right.upper(), strike, prior_date,
            )
        except Exception as e:
            logger.warning("Failed to load options data for %s on %s: %s", symbol, prior_date, e)

    if not all_candles:
        raise HTTPException(
            status_code=404,
            detail=f"Options data not found for {symbol} {right.upper()} {strike}",
        )

    return HistoricalDataResponse(
        symbol=f"{symbol}-{right.upper()}-{strike}",
        dates=prior_dates,  # includes the 2 prior days + the trading date
        candles=all_candles,
    )


@router.get("/price-at", response_model=PriceAtResponse)
async def get_price_at(
    symbol: str = Query(...),
    date: str = Query(...),
    time: str = Query(...),
):
    """
    Return the first available close price at or after the given time on the given date.
    Used to resolve ATM strike before an options session is configured.
    time format: HH:MM or HH:MM:SS
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")

    if not re.match(r'^\d{2}:\d{2}(:\d{2})?$', time):
        raise HTTPException(status_code=422, detail="time must be HH:MM or HH:MM:SS")
    if len(time) == 5:
        time = time + ":00"

    _ensure_data(symbol, date)

    try:
        df = load_dataframe(symbol, date)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Data not found for {symbol} on {date}")

    target_ts = pd.Timestamp(f"{date} {time}", tz="UTC")
    rows = df[df.index >= target_ts]
    if rows.empty:
        raise HTTPException(
            status_code=404,
            detail=f"No data at or after {time} for {symbol} on {date}",
        )

    price = round(float(rows.iloc[0]["close"]), 2)
    return PriceAtResponse(symbol=symbol, date=date, time=time, price=price)


@router.get("/expiry", response_model=ExpiryResponse)
async def get_expiry(
    symbol: str = Query(...),
    date: str = Query(...),
):
    """
    Return the next valid options expiry date for the given symbol and trading date.
    NIFTY: next weekly expiry; equities: current month's monthly expiry.
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=400, detail=f"Unsupported symbol: {symbol}")

    from app.services.options_service import get_expiry_date
    expiry = get_expiry_date(symbol, date)
    return ExpiryResponse(symbol=symbol, date=date, expiry=expiry)
