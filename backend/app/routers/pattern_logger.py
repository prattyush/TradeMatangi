"""
Pattern Logger API — REST endpoints for Trade Pattern Library (Phase XII).

Prefix: /api/pattern
"""
from __future__ import annotations

import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services import pattern_logger_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pattern", tags=["pattern_logger"])


# ── Request / Response models ─────────────────────────────────────────────────

class AnnotationItem(BaseModel):
    id: str
    time: int
    price: float
    type: str                      # "entry" | "exit"
    instrument: str                # "underlying" | "CE" | "PE"
    strategy_name: str
    text: str


class CreateChartRequest(BaseModel):
    symbol: str
    date: str
    instrument_type: str           # "equity" | "options"
    annotations: list[AnnotationItem] = []
    notes: str = ""
    right: Optional[str] = None    # "CE" | "PE" (options only)
    strike: Optional[int] = None   # options reference strike


class UpdateChartRequest(BaseModel):
    annotations: list[AnnotationItem]
    notes: str = ""


# ── Strategy names ────────────────────────────────────────────────────────────

@router.get("/strategies")
async def list_strategies(user_id: str = Depends(get_request_user_id)):
    """Return all unique strategy names across user's saved charts."""
    try:
        names = svc.list_strategy_names(user_id)
        return {"strategies": names}
    except Exception as exc:
        logger.error("list_strategies error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list strategies")


# ── Chart CRUD ────────────────────────────────────────────────────────────────

@router.get("/charts")
async def list_charts(
    strategy: Optional[str] = Query(None, description="Filter by strategy name"),
    user_id: str = Depends(get_request_user_id),
):
    """Return chart metadata list (no annotation payload). Optionally filtered by strategy."""
    try:
        charts = svc.list_charts_for_user(user_id, strategy=strategy)
        return {"charts": charts}
    except Exception as exc:
        logger.error("list_charts error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list charts")


@router.get("/chart/by-date")
async def get_chart_by_date(
    symbol: str = Query(...),
    date: str = Query(...),
    instrument_type: str = Query(...),
    right: Optional[str] = Query(None),
    user_id: str = Depends(get_request_user_id),
):
    """Find an existing chart record for a specific (symbol, date, instrument, right)."""
    try:
        chart = svc.find_chart_by_date(user_id, symbol, date, instrument_type, right)
        if not chart:
            raise HTTPException(status_code=404, detail="No saved chart for this date/symbol")
        return chart
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("get_chart_by_date error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to fetch chart")


@router.get("/chart/{chart_id}")
async def get_chart(chart_id: str, user_id: str = Depends(get_request_user_id)):
    """Return full chart record including all annotations."""
    try:
        chart = svc.get_chart(chart_id)
        if not chart:
            raise HTTPException(status_code=404, detail="Chart not found")
        if chart.get("user_id") != user_id:
            raise HTTPException(status_code=403, detail="Not your chart")
        return chart
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("get_chart error for %s: %s", chart_id, exc)
        raise HTTPException(status_code=500, detail="Failed to fetch chart")


@router.post("/chart")
async def create_chart(req: CreateChartRequest, user_id: str = Depends(get_request_user_id)):
    """Save a new annotated chart."""
    try:
        chart = svc.create_chart(
            user_id=user_id,
            symbol=req.symbol,
            date=req.date,
            instrument_type=req.instrument_type,
            annotations=[a.model_dump() for a in req.annotations],
            notes=req.notes,
            right=req.right,
            strike=req.strike,
        )
        return chart
    except Exception as exc:
        logger.error("create_chart error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to save chart")


@router.put("/chart/{chart_id}")
async def update_chart(chart_id: str, req: UpdateChartRequest, user_id: str = Depends(get_request_user_id)):
    """Update annotations and notes for an existing chart."""
    existing = svc.get_chart(chart_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Chart not found")
    if existing.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not your chart")
    try:
        updated = svc.update_chart(chart_id, [a.model_dump() for a in req.annotations], req.notes)
        if not updated:
            raise HTTPException(status_code=500, detail="Update failed")
        return updated
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("update_chart error for %s: %s", chart_id, exc)
        raise HTTPException(status_code=500, detail="Failed to update chart")


@router.delete("/chart/{chart_id}")
async def delete_chart(chart_id: str, user_id: str = Depends(get_request_user_id)):
    """Delete a chart record."""
    existing = svc.get_chart(chart_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Chart not found")
    if existing.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Not your chart")
    try:
        svc.delete_chart(chart_id)
        return {"status": "deleted", "chart_id": chart_id}
    except Exception as exc:
        logger.error("delete_chart error for %s: %s", chart_id, exc)
        raise HTTPException(status_code=500, detail="Failed to delete chart")


# ── OHLC data (full day) ──────────────────────────────────────────────────────

@router.get("/ohlc/equity")
async def ohlc_equity(
    symbol: str = Query(...),
    date: str = Query(...),
    interval_minutes: int = Query(3, ge=1, le=60),
    _user_id: str = Depends(get_request_user_id),
):
    """Return full-day OHLC candles for an equity symbol. Auto-fetches from Breeze if not cached."""
    try:
        from app.services.broker_service import fetch_historical
        from app.services.data_loader import load_dataframe, resample_to_candles, candles_to_records
        fetch_historical(symbol, date)
        df = load_dataframe(symbol, date)
        candles = resample_to_candles(df, interval_minutes)
        records = candles_to_records(candles)
        return {"symbol": symbol, "date": date, "interval_minutes": interval_minutes, "candles": records}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"No data for {symbol} on {date}")
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("ohlc_equity error %s %s: %s", symbol, date, exc)
        raise HTTPException(status_code=500, detail="Failed to load equity OHLC")


@router.get("/ohlc/options")
async def ohlc_options(
    symbol: str = Query(...),
    date: str = Query(...),
    strike: int = Query(...),
    expiry: str = Query(...),
    right: str = Query(...),
    interval_minutes: int = Query(3, ge=1, le=60),
    _user_id: str = Depends(get_request_user_id),
):
    """Return full-day OHLC candles for an options contract (CE or PE). Auto-fetches from Breeze if not cached."""
    if right.upper() not in ("CE", "PE"):
        raise HTTPException(status_code=400, detail="right must be CE or PE")
    try:
        from app.services.options_service import fetch_options_historical, load_options_dataframe
        from app.services.data_loader import resample_to_candles, candles_to_records
        fetch_options_historical(symbol, date, strike, expiry, right.upper())
        df = load_options_dataframe(symbol, date, strike, expiry, right.upper())
        candles = resample_to_candles(df, interval_minutes)
        records = candles_to_records(candles)
        return {
            "symbol": symbol, "date": date, "strike": strike,
            "expiry": expiry, "right": right.upper(),
            "interval_minutes": interval_minutes, "candles": records,
        }
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"No options data for {symbol} {right} {strike} on {date}",
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("ohlc_options error %s %s %s %s: %s", symbol, date, strike, right, exc)
        raise HTTPException(status_code=500, detail="Failed to load options OHLC")
