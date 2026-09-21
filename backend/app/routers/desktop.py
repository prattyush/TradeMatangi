"""Versioned, chart-only boundary for the Windows companion application.

Keep this router independent of simulation, orders, wallets, strategies and
broker credentials. New desktop endpoints belong here rather than being added
to the legacy web/trading routers.
"""
import asyncio
import uuid
from datetime import date as calendar_date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.config import SUPPORTED_SYMBOLS
from app.dependencies import get_desktop_user_id
from app.services.data_loader import candles_to_records, load_dataframe, resample_to_candles
from app.services.options_service import STRIKE_INTERVALS, get_expiry_date
from app.utils import is_trading_day, prior_trading_days

router = APIRouter(prefix="/api/desktop/v1", tags=["desktop"])


class DesktopCapabilities(BaseModel):
    api_version: str = "v1"
    authentication: list[str] = ["bearer", "x-user-id-legacy"]
    features: list[str] = ["catalogue", "historical-candles", "option-metadata", "option-historical-candles", "preflight"]
    trading_capabilities: list[str] = ["stepwise", "replay-trading", "orders", "strategies", "wallet", "flatten", "draggable-lines", "bulk-convert", "trade-labels"]


class DesktopInstrument(BaseModel):
    symbol: str
    display_name: str
    exchange: str
    chart_type: str
    option_eligible: bool
    supported_intervals: list[int]


class DesktopCatalogue(BaseModel):
    version: int = 1
    instruments: list[DesktopInstrument]


class DesktopCandle(BaseModel):
    timestamp: int
    open: float
    high: float
    low: float
    close: float


class HistoricalPage(BaseModel):
    version: int = 1
    symbol: str
    interval_minutes: int
    requested_date: str
    loaded_dates: list[str]
    candles: list[DesktopCandle]


class OptionMetadata(BaseModel):
    version: int = 1
    symbol: str
    as_of_date: str
    expiries: list[str]
    strike_interval: int
    rights: list[str] = ["CE", "PE"]
    available: bool
    unavailable_reason: str | None = None


class OptionHistoricalPage(HistoricalPage):
    expiry: str
    strike: int
    right: str
    available: bool
    unavailable_reason: str | None = None


class PreflightRequest(BaseModel):
    symbol: str
    trading_date: str


class PreflightStatus(BaseModel):
    job_id: str
    status: str
    detail: str | None = None


_preflight_jobs: dict[str, PreflightStatus] = {}


@router.get("/capabilities", response_model=DesktopCapabilities)
async def capabilities(_: str = Depends(get_desktop_user_id)) -> DesktopCapabilities:
    """Return only capabilities available to the chart-only desktop product."""
    return DesktopCapabilities()


@router.get("/catalogue", response_model=DesktopCatalogue)
async def catalogue(_: str = Depends(get_desktop_user_id)) -> DesktopCatalogue:
    """Expose the initial five-symbol desktop catalogue, not trading eligibility."""
    instruments = []
    for symbol, definition in SUPPORTED_SYMBOLS.items():
        instruments.append(DesktopInstrument(
            symbol=symbol,
            display_name=definition["display_name"],
            exchange=definition["exchange_code"],
            chart_type="index" if definition["options_only"] else "equity",
            option_eligible="options_exchange_code" in definition,
            supported_intervals=[1, 3, 5, 15, 30, 60],
        ))
    return DesktopCatalogue(instruments=instruments)


@router.get("/option-metadata", response_model=OptionMetadata)
async def option_metadata(
    symbol: str = Query(...),
    as_of_date: str = Query(...),
    _: str = Depends(get_desktop_user_id),
) -> OptionMetadata:
    """Date-aware option selection metadata; never substitutes an invalid contract."""
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=404, detail="Desktop instrument is not supported")
    try:
        requested_date = calendar_date.fromisoformat(as_of_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="as_of_date must be YYYY-MM-DD")
    if not is_trading_day(requested_date):
        return OptionMetadata(symbol=symbol, as_of_date=as_of_date, expiries=[], strike_interval=STRIKE_INTERVALS[symbol], available=False, unavailable_reason="The selected date is not a trading day")
    expiry = get_expiry_date(symbol, as_of_date)
    return OptionMetadata(symbol=symbol, as_of_date=as_of_date, expiries=[expiry], strike_interval=STRIKE_INTERVALS[symbol], available=True)


@router.get("/historical/pages", response_model=HistoricalPage)
async def historical_page(
    symbol: str = Query(...),
    trading_date: str = Query(...),
    interval_minutes: int = Query(default=1, ge=1, le=60),
    context_days: int = Query(default=5, ge=0, le=5),
    _: str = Depends(get_desktop_user_id),
) -> HistoricalPage:
    """One Browse page: selected day plus up to five prior trading days.

    Fetch/cache rules remain in the existing data router's ``_ensure_data``
    helper; this endpoint only supplies a versioned desktop payload.
    """
    if symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=404, detail="Desktop instrument is not supported")
    try:
        requested_date = calendar_date.fromisoformat(trading_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="trading_date must be YYYY-MM-DD")
    if not is_trading_day(requested_date):
        raise HTTPException(status_code=422, detail="The selected date is not a trading day")

    from app.routers.data import _ensure_data
    dates = prior_trading_days(trading_date, context_days) + [trading_date]
    candles: list[DesktopCandle] = []
    loaded_dates: list[str] = []
    for page_date in dates:
        try:
            await asyncio.to_thread(_ensure_data, symbol, page_date)
            records = candles_to_records(resample_to_candles(load_dataframe(symbol, page_date), interval_minutes))
            candles.extend(DesktopCandle(timestamp=item["time"], open=item["open"], high=item["high"], low=item["low"], close=item["close"]) for item in records)
            loaded_dates.append(page_date)
        except HTTPException as exc:
            if exc.status_code in (404, 503):
                continue
            raise
        except FileNotFoundError:
            continue
    if not candles:
        raise HTTPException(status_code=404, detail="No historical candles are available for the requested page")
    return HistoricalPage(symbol=symbol, interval_minutes=interval_minutes, requested_date=trading_date, loaded_dates=loaded_dates, candles=candles)


@router.get("/options/historical/pages", response_model=OptionHistoricalPage)
async def option_historical_page(
    symbol: str = Query(...),
    trading_date: str = Query(...),
    expiry: str = Query(...),
    strike: int = Query(..., gt=0),
    right: str = Query(...),
    interval_minutes: int = Query(default=1, ge=1, le=60),
    context_days: int = Query(default=5, ge=0, le=5),
    _: str = Depends(get_desktop_user_id),
) -> OptionHistoricalPage:
    """Desktop option history with explicit unavailable states, never substitution."""
    if symbol not in SUPPORTED_SYMBOLS or right.upper() not in ("CE", "PE"):
        raise HTTPException(status_code=422, detail="Unsupported option instrument")
    if strike % STRIKE_INTERVALS[symbol] != 0:
        raise HTTPException(status_code=422, detail="Strike does not match the instrument strike interval")
    try:
        requested_date = calendar_date.fromisoformat(trading_date)
        calendar_date.fromisoformat(expiry)
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be YYYY-MM-DD")
    if not is_trading_day(requested_date):
        raise HTTPException(status_code=422, detail="The selected date is not a trading day")
    if trading_date > expiry:
        return OptionHistoricalPage(symbol=symbol, interval_minutes=interval_minutes, requested_date=trading_date, loaded_dates=[], candles=[], expiry=expiry, strike=strike, right=right.upper(), available=False, unavailable_reason="The selected option contract has expired")

    from app.services.options_service import fetch_options_historical, load_options_dataframe
    dates = [day for day in prior_trading_days(trading_date, context_days) + [trading_date] if day <= expiry]
    candles: list[DesktopCandle] = []
    loaded_dates: list[str] = []
    for page_date in dates:
        try:
            await asyncio.to_thread(fetch_options_historical, symbol, page_date, strike, expiry, right.upper())
            records = candles_to_records(resample_to_candles(load_options_dataframe(symbol, page_date, strike, expiry, right.upper()), interval_minutes))
            candles.extend(DesktopCandle(timestamp=item["time"], open=item["open"], high=item["high"], low=item["low"], close=item["close"]) for item in records)
            loaded_dates.append(page_date)
        except Exception:
            # A partial page remains valid: each missing contract is a visible
            # unavailable state rather than a silently replaced option.
            continue
    if not candles:
        return OptionHistoricalPage(symbol=symbol, interval_minutes=interval_minutes, requested_date=trading_date, loaded_dates=[], candles=[], expiry=expiry, strike=strike, right=right.upper(), available=False, unavailable_reason="No data is available for this option contract")
    return OptionHistoricalPage(symbol=symbol, interval_minutes=interval_minutes, requested_date=trading_date, loaded_dates=loaded_dates, candles=candles, expiry=expiry, strike=strike, right=right.upper(), available=True)


async def _run_preflight(job_id: str, symbol: str, trading_date: str) -> None:
    from app.routers.data import _ensure_data
    try:
        await asyncio.to_thread(_ensure_data, symbol, trading_date)
        _preflight_jobs[job_id] = PreflightStatus(job_id=job_id, status="ready")
    except Exception as error:
        _preflight_jobs[job_id] = PreflightStatus(job_id=job_id, status="failed", detail=str(error))


@router.post("/preflight", response_model=PreflightStatus, status_code=202)
async def preflight(req: PreflightRequest, _: str = Depends(get_desktop_user_id)) -> PreflightStatus:
    """Start a non-blocking cache/fetch preparation job for Browse mode."""
    if req.symbol not in SUPPORTED_SYMBOLS:
        raise HTTPException(status_code=404, detail="Desktop instrument is not supported")
    try:
        requested_date = calendar_date.fromisoformat(req.trading_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="trading_date must be YYYY-MM-DD")
    if not is_trading_day(requested_date):
        raise HTTPException(status_code=422, detail="The selected date is not a trading day")
    job_id = str(uuid.uuid4())
    status = PreflightStatus(job_id=job_id, status="running")
    _preflight_jobs[job_id] = status
    asyncio.create_task(_run_preflight(job_id, req.symbol, req.trading_date))
    return status


@router.get("/preflight/{job_id}", response_model=PreflightStatus)
async def preflight_status(job_id: str, _: str = Depends(get_desktop_user_id)) -> PreflightStatus:
    if job_id not in _preflight_jobs:
        raise HTTPException(status_code=404, detail="Preflight job was not found")
    return _preflight_jobs[job_id]
