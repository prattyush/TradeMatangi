"""
Fine Chart Structures API — REST endpoints for managing fine chart structure
definitions, flows, and search.

Prefix: /api/fine-structures
"""
from __future__ import annotations

import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services import fine_structure_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fine-structures", tags=["fine_structures"])


# ── Request / Response models ─────────────────────────────────────────────────

class DefinitionItem(BaseModel):
    definition_id: str
    name: str
    sub_types: list[str]
    is_predefined: bool
    user_id: str
    can_delete: bool
    created_at: str
    updated_at: str


class CreateDefinitionRequest(BaseModel):
    name: str
    sub_types: list[str]


class UpdateDefinitionRequest(BaseModel):
    name: str
    sub_types: list[str]


class FlowStepItem(BaseModel):
    definition_id: str
    name: str
    type: Optional[str] = None
    direction: Optional[str] = None
    transition_bar_time: Optional[int] = None


class FlowItem(BaseModel):
    flow_id: str
    symbol: str
    date: str
    steps: list[FlowStepItem]
    instrument_type: str = "equity"
    right: Optional[str] = None
    user_id: str
    can_delete: bool
    created_at: str
    updated_at: str


class CreateFlowRequest(BaseModel):
    symbol: str
    date: str
    steps: list[FlowStepItem]
    instrument_type: str = "equity"
    right: Optional[str] = None


class UpdateFlowRequest(BaseModel):
    steps: list[FlowStepItem]


class SearchQueryStep(BaseModel):
    name: str
    type: Optional[str] = None
    direction: Optional[str] = None


class SearchFlowsRequest(BaseModel):
    query_steps: list[SearchQueryStep]
    symbol: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    instrument_type: Optional[str] = None


class SearchResultItem(BaseModel):
    flow: FlowItem
    match_start_index: int


class OHLCItem(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float


class FineOHLCResponse(BaseModel):
    symbol: str
    date: str
    interval_minutes: int
    candles: list[OHLCItem]
    flow: Optional[FlowItem] = None


# ── Definitions endpoints ─────────────────────────────────────────────────────

@router.get("/definitions")
async def list_definitions(user_id: str = Depends(get_request_user_id)):
    try:
        defs = svc.list_definitions(user_id)
        return {"definitions": defs}
    except Exception as exc:
        logger.error("list_definitions error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list definitions")


@router.post("/definition")
async def create_definition(req: CreateDefinitionRequest, user_id: str = Depends(get_request_user_id)):
    try:
        d = svc.create_definition(user_id=user_id, name=req.name, sub_types=req.sub_types)
        return d
    except Exception as exc:
        logger.error("create_definition error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to create definition")


@router.put("/definition/{definition_id}")
async def update_definition(definition_id: str, req: UpdateDefinitionRequest, user_id: str = Depends(get_request_user_id)):
    try:
        d = svc.update_definition(user_id=user_id, definition_id=definition_id, name=req.name, sub_types=req.sub_types)
        if not d:
            raise HTTPException(status_code=404, detail="Definition not found or not editable")
        return d
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("update_definition error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to update definition")


@router.delete("/definition/{definition_id}")
async def delete_definition(definition_id: str, user_id: str = Depends(get_request_user_id)):
    try:
        ok = svc.delete_definition(user_id=user_id, definition_id=definition_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Definition not found or not deletable")
        return {"status": "deleted", "definition_id": definition_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("delete_definition error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to delete definition")


# ── Flows endpoints ───────────────────────────────────────────────────────────

@router.get("/flows")
async def list_flows(
    symbol: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    instrument_type: Optional[str] = None,
    right: Optional[str] = None,
    user_id: str = Depends(get_request_user_id),
):
    try:
        flows = svc.list_flows(
            user_id=user_id,
            symbol=symbol.upper() if symbol else None,
            start_date=start_date,
            end_date=end_date,
            instrument_type=instrument_type,
            right=right.upper() if right else None,
        )
        return {"flows": flows}
    except Exception as exc:
        logger.error("list_flows error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list flows")


@router.get("/flow/{flow_id}")
async def get_flow(flow_id: str, user_id: str = Depends(get_request_user_id)):
    try:
        f = svc.get_flow(user_id=user_id, flow_id=flow_id)
        if not f:
            raise HTTPException(status_code=404, detail="Flow not found")
        return f
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("get_flow error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to get flow")


@router.post("/flow")
async def create_flow(req: CreateFlowRequest, user_id: str = Depends(get_request_user_id)):
    try:
        steps = [s.model_dump() for s in req.steps]
        f = svc.create_flow(user_id=user_id, symbol=req.symbol.upper(), date=req.date, steps=steps, instrument_type=req.instrument_type, right=req.right)
        return f
    except Exception as exc:
        logger.error("create_flow error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to create flow")


@router.put("/flow/{flow_id}")
async def update_flow(flow_id: str, req: UpdateFlowRequest, user_id: str = Depends(get_request_user_id)):
    try:
        steps = [s.model_dump() for s in req.steps]
        f = svc.update_flow(user_id=user_id, flow_id=flow_id, steps=steps)
        if not f:
            raise HTTPException(status_code=404, detail="Flow not found or not editable")
        return f
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("update_flow error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to update flow")


@router.delete("/flow/{flow_id}")
async def delete_flow(flow_id: str, user_id: str = Depends(get_request_user_id)):
    try:
        ok = svc.delete_flow(user_id=user_id, flow_id=flow_id)
        if not ok:
            raise HTTPException(status_code=404, detail="Flow not found or not deletable")
        return {"status": "deleted", "flow_id": flow_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("delete_flow error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to delete flow")


# ── Search endpoint ───────────────────────────────────────────────────────────

@router.post("/search")
async def search_flows(req: SearchFlowsRequest, user_id: str = Depends(get_request_user_id)):
    try:
        query_steps = [s.model_dump(exclude_none=True) for s in req.query_steps]
        results = svc.search_flows(
            user_id=user_id,
            query_steps=query_steps,
            symbol=req.symbol.upper() if req.symbol else None,
            start_date=req.start_date,
            end_date=req.end_date,
            instrument_type=req.instrument_type,
        )
        return {"results": results}
    except Exception as exc:
        logger.error("search_flows error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to search flows")


# ── OHLC with flow overlay ───────────────────────────────────────────────────

@router.get("/ohlc/{symbol}/{date}", response_model=FineOHLCResponse)
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

        flow = None
        try:
            flows = svc.list_flows(user_id=user_id, symbol=symbol.upper(), start_date=date, end_date=date)
            if flows:
                flow = flows[0]
        except Exception:
            pass

        return FineOHLCResponse(
            symbol=symbol.upper(),
            date=date,
            interval_minutes=interval_minutes,
            candles=[OHLCItem(**r) for r in records],
            flow=FlowItem(**flow) if flow else None,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"No data for {symbol} on {date}")
    except Exception as exc:
        logger.error("fine ohlc error %s %s: %s", symbol, date, exc)
        raise HTTPException(status_code=500, detail="Failed to load OHLC")


@router.get("/ohlc-options/{symbol}/{date}")
async def get_ohlc_options(
    symbol: str,
    date: str,
    strike: int = Query(...),
    expiry: str = Query(None),
    right: str = Query(...),
    interval_minutes: int = Query(3, ge=1, le=60),
    user_id: str = Depends(get_request_user_id),
):
    """Return OHLC candles for an options contract for fine structure builder."""
    if right.upper() not in ("CE", "PE"):
        raise HTTPException(status_code=400, detail="right must be CE or PE")
    try:
        import pandas as pd
        from app.utils import prior_trading_days
        from app.services.options_service import fetch_options_historical, load_options_dataframe, get_expiry_date
        from app.services.data_loader import resample_to_candles, candles_to_records

        # Auto-calculate expiry if not provided
        if not expiry:
            expiry = get_expiry_date(symbol.upper(), date)
            logger.info("Auto-calculated expiry for %s on %s: %s", symbol, date, expiry)

        prior_dates = prior_trading_days(date, n=2)
        all_dfs = []
        for d in prior_dates:
            try:
                fetch_options_historical(symbol.upper(), d, strike, expiry, right.upper())
                all_dfs.append(load_options_dataframe(symbol.upper(), d, strike, expiry, right.upper()))
            except (FileNotFoundError, RuntimeError):
                pass
        fetch_options_historical(symbol.upper(), date, strike, expiry, right.upper())
        all_dfs.append(load_options_dataframe(symbol.upper(), date, strike, expiry, right.upper()))
        if not all_dfs:
            raise FileNotFoundError
        combined = pd.concat(all_dfs).sort_index()
        candles = resample_to_candles(combined, interval_minutes)
        records = candles_to_records(candles)

        flow = None
        try:
            flows = svc.list_flows(user_id=user_id, symbol=symbol.upper(), start_date=date, end_date=date, right=right.upper())
            if flows:
                flow = flows[0]
        except Exception:
            pass

        return FineOHLCResponse(
            symbol=symbol.upper(),
            date=date,
            interval_minutes=interval_minutes,
            candles=[OHLCItem(**r) for r in records],
            flow=FlowItem(**flow) if flow else None,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"No options data for {symbol} {right} {strike} on {date}")
    except Exception as exc:
        logger.error("fine options ohlc error %s %s %s %s: %s", symbol, date, strike, right, exc)
        raise HTTPException(status_code=500, detail="Failed to load options OHLC")
