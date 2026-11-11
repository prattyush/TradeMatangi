"""
What If API — saved what-if scenarios for Analysis (Phase 24, What If).

Prefix: /api/whatif

Owner only, for reads as well as writes: a what-if is the user's own study of their trades, so it is
not covered by the "share real trading history" read access that Analysis uses. Writing a scenario changes
nothing about the session itself.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.dependencies import get_request_user_id
from app.services import trade_label_service
from app.services import whatif_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/whatif", tags=["whatif"])


class EditIn(BaseModel):
    round_trip: int = Field(ge=0, le=svc.MAX_ROUND_TRIP)
    leg_id: str = Field(min_length=1, max_length=svc.LEG_ID_MAX)
    role: Literal["entry", "exit"]
    price: float = Field(gt=0, le=svc.MAX_PRICE, allow_inf_nan=False)
    quantity: int = Field(ge=0, le=svc.MAX_QUANTITY)


class SummaryIn(BaseModel):
    actual_pnl: float = Field(allow_inf_nan=False)
    whatif_pnl: float = Field(allow_inf_nan=False)
    delta: float = Field(allow_inf_nan=False)
    delta_pct: float | None = Field(default=None, allow_inf_nan=False)
    trips_edited: int = Field(default=0, ge=0)
    warnings: int = Field(default=0, ge=0)


class ScenarioIn(BaseModel):
    session_id: str
    name: str
    edits: list[EditIn] = Field(max_length=svc.MAX_EDITS)
    summary: SummaryIn


class ScenarioOut(BaseModel):
    session_id: str
    scenario_id: str
    name: str
    date: str
    symbol: str
    session_type: str
    instrument_type: str
    summary: dict
    version: int
    updated_at: str
    edits: list[dict] | None = None


class ScenariosResponse(BaseModel):
    scenarios: list[ScenarioOut]


class DeleteResponse(BaseModel):
    deleted: bool


def _own_session(session_id: str, user_id: str) -> dict:
    session = trade_label_service._load_session(session_id)
    if not session or session.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0]) if exc.args else "Not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc.args[0]) if exc.args else str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("What If request failed")
        raise HTTPException(status_code=500, detail="Saved what-ifs could not be read or saved; retry later") from exc


@router.get("", response_model=ScenariosResponse)
async def list_scenarios(session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    await asyncio.to_thread(_own_session, session_id, user_id)
    return {"scenarios": await _run(svc.list_scenarios, session_id)}


@router.get("/range", response_model=ScenariosResponse)
async def list_range(start: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                     end: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                     user_id: str = Depends(get_request_user_id)):
    """The caller's scenarios over a date range (summaries, no edits), for Compare days."""
    if start and end and start > end:
        raise HTTPException(status_code=400, detail="The start date is after the end date")
    return {"scenarios": await _run(svc.list_range, user_id, start, end)}


@router.post("", response_model=ScenarioOut)
async def save_scenario(req: ScenarioIn, user_id: str = Depends(get_request_user_id)):
    session = await asyncio.to_thread(_own_session, req.session_id, user_id)
    if session.get("trading_style") == "swing":
        raise HTTPException(status_code=400, detail="What If is for intraday sessions")
    return await _run(svc.save_scenario, user_id, session, req.name, [e.model_dump() for e in req.edits], req.summary.model_dump())


@router.delete("", response_model=DeleteResponse)
async def delete_scenario(session_id: str = Query(...), scenario_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    await asyncio.to_thread(_own_session, session_id, user_id)
    await _run(svc.delete_scenario, session_id, scenario_id)
    return {"deleted": True}
