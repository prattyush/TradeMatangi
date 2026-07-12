"""
Chart Structures API — REST endpoints for browsing daily chart structure classifications.

Prefix: /api/chart-structures
"""
from __future__ import annotations

import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services import chart_structure_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chart-structures", tags=["chart_structures"])


# ── Request / Response models ─────────────────────────────────────────────────

class StructureTypeItem(BaseModel):
    value: str
    label: str


class StructureTypesResponse(BaseModel):
    opening_types: list[StructureTypeItem]
    midday_types: list[StructureTypeItem]
    closing_types: list[StructureTypeItem]


class ChartStructureItem(BaseModel):
    chart_structure_id: str
    symbol: str
    date: str
    opening_type: str
    midday_type: str
    closing_type: str
    is_predefined: bool
    user_id: str
    created_at: str
    updated_at: str
    can_delete: bool = False


class OHLCItem(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float


class StructureOHLCResponse(BaseModel):
    symbol: str
    date: str
    interval_minutes: int
    candles: list[OHLCItem] = []
    structure: ChartStructureItem | None = None


class CreateStructureRequest(BaseModel):
    symbol: str
    date: str
    opening_type: str
    midday_type: str
    closing_type: str


class UpdateStructureRequest(BaseModel):
    opening_type: str
    midday_type: str
    closing_type: str


# ── Types ─────────────────────────────────────────────────────────────────────

@router.get("/types", response_model=StructureTypesResponse)
async def get_types():
    return svc.get_predefined_types()


# ── List structures ───────────────────────────────────────────────────────────

@router.get("/structures")
async def list_structures(
    opening_types: Optional[str] = Query(None, description="Comma-separated opening type values"),
    midday_types: Optional[str] = Query(None, description="Comma-separated midday type values"),
    closing_types: Optional[str] = Query(None, description="Comma-separated closing type values"),
    symbol: Optional[str] = Query(None, description="Symbol filter"),
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    user_id: str = Depends(get_request_user_id),
):
    try:
        results = svc.list_structures(
            user_id=user_id,
            opening_types=opening_types.split(",") if opening_types else None,
            midday_types=midday_types.split(",") if midday_types else None,
            closing_types=closing_types.split(",") if closing_types else None,
            symbol=symbol.upper() if symbol else None,
            start_date=start_date,
            end_date=end_date,
        )
        return {"structures": results}
    except Exception as exc:
        logger.error("list_structures error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list structures")


# ── Get single structure ──────────────────────────────────────────────────────

@router.get("/structure/{structure_id}")
async def get_structure(structure_id: str, user_id: str = Depends(get_request_user_id)):
    try:
        s = svc.get_structure_for_user(user_id, structure_id)
        if not s:
            raise HTTPException(status_code=404, detail="Structure not found")
        return s
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("get_structure error for %s: %s", structure_id, exc)
        raise HTTPException(status_code=500, detail="Failed to fetch structure")


# ── OHLC data for a specific date ────────────────────────────────────────────

@router.get("/ohlc/{symbol}/{date}", response_model=StructureOHLCResponse)
async def get_ohlc(
    symbol: str,
    date: str,
    interval_minutes: int = Query(3, ge=1, le=60),
    user_id: str = Depends(get_request_user_id),
):
    try:
        import pandas as pd
        from app.utils import prior_trading_days
        from app.services.broker_service import fetch_historical
        from app.services.data_loader import load_dataframe, resample_to_candles, candles_to_records

        # Load current date + up to 2 prior trading days for context
        prior_dates = prior_trading_days(date, n=2)
        all_dfs = []
        for d in prior_dates:
            try:
                fetch_historical(symbol.upper(), d)
                all_dfs.append(load_dataframe(symbol.upper(), d))
            except (FileNotFoundError, RuntimeError):
                pass
        fetch_historical(symbol.upper(), date)
        all_dfs.append(load_dataframe(symbol.upper(), date))
        if not all_dfs:
            raise FileNotFoundError
        combined = pd.concat(all_dfs).sort_index()
        candles = resample_to_candles(combined, interval_minutes)
        records = candles_to_records(candles)

        structure = None
        try:
            structures = svc.list_structures(
                user_id=user_id,
                symbol=symbol.upper(),
                start_date=date,
                end_date=date,
            )
            if structures:
                structure = structures[0]
        except Exception:
            pass

        return StructureOHLCResponse(
            symbol=symbol.upper(),
            date=date,
            interval_minutes=interval_minutes,
            candles=[OHLCItem(**r) for r in records],
            structure=ChartStructureItem(**structure) if structure else None,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"No data for {symbol} on {date}")
    except Exception as exc:
        logger.error("ohlc error %s %s: %s", symbol, date, exc)
        raise HTTPException(status_code=500, detail="Failed to load OHLC")


# ── Create user custom structure ──────────────────────────────────────────────

@router.post("/structure")
async def create_structure(req: CreateStructureRequest, user_id: str = Depends(get_request_user_id)):
    try:
        s = svc.create_structure(
            user_id=user_id,
            symbol=req.symbol,
            date=req.date,
            opening_type=req.opening_type,
            midday_type=req.midday_type,
            closing_type=req.closing_type,
        )
        return s
    except Exception as exc:
        logger.error("create_structure error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to create structure")


@router.put("/structure/{structure_id}")
async def update_structure(
    structure_id: str,
    req: UpdateStructureRequest,
    user_id: str = Depends(get_request_user_id),
):
    existing = svc.get_structure_for_user(user_id, structure_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Structure not found")
    if not existing.get("can_delete"):
        raise HTTPException(status_code=403, detail="Not your structure")
    try:
        updated = svc.update_structure(
            structure_id, req.opening_type, req.midday_type, req.closing_type,
        )
        if not updated:
            raise HTTPException(status_code=500, detail="Update failed")
        return updated
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("update_structure error for %s: %s", structure_id, exc)
        raise HTTPException(status_code=500, detail="Failed to update structure")


@router.delete("/structure/{structure_id}")
async def delete_structure(structure_id: str, user_id: str = Depends(get_request_user_id)):
    existing = svc.get_structure_for_user(user_id, structure_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Structure not found")
    if not existing.get("can_delete"):
        raise HTTPException(status_code=403, detail="Not your structure")
    try:
        svc.delete_structure(structure_id)
        return {"status": "deleted", "chart_structure_id": structure_id}
    except Exception as exc:
        logger.error("delete_structure error for %s: %s", structure_id, exc)
        raise HTTPException(status_code=500, detail="Failed to delete structure")
