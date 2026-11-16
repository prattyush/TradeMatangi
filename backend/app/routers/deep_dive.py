"""
Deep Dive API — Patterns Strategy Deep Dive (Phase 26).

Prefix: /api/deep-dive

One deep dive is one category + strategy. The caller's own dives are editable; dives of an owner who shared
patterns with the caller are readable (``owner_id``) and never writable. Nothing here touches orders, sessions,
brokers or streams.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.dependencies import get_request_user_id
from app.routers.pattern_logger import AnnotationItem
from app.services import deep_dive_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/deep-dive", tags=["deep-dive"])

Side = Literal["buy", "sell"]


class DiveRef(BaseModel):
    category: str
    strategy: str


class SetupRef(DiveRef):
    symbol: str
    date: str
    side: Side


class SetupIn(SetupRef):
    """Only the fields the client sends change; ``outcome`` / strikes sent as null are cleared."""
    strike_ce: Optional[int] = None
    strike_pe: Optional[int] = None
    strike_mode: Optional[Literal["max_price", "otm", "manual"]] = None
    interval_minutes: Optional[int] = None
    annotations: Optional[list[AnnotationItem]] = None
    outcome: Optional[Literal["success", "failed"]] = None
    notes: Optional[str] = None


class AnswersIn(SetupRef):
    answers: dict[str, Optional[bool]] = Field(max_length=100)


class QuestionIn(DiveRef):
    text: str


class QuestionRef(DiveRef):
    pass


class QuestionUpdateIn(DiveRef):
    text: str


def _bad_request(exc: Exception) -> HTTPException:
    status = 404 if isinstance(exc, LookupError) else 400
    return HTTPException(status_code=status, detail=str(exc.args[0]) if exc.args else str(exc))


async def _run(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except (ValueError, LookupError) as exc:
        raise _bad_request(exc) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("deep dive %s failed", getattr(fn, "__name__", "call"))
        raise HTTPException(status_code=500, detail="Deep dive request failed") from exc


# ── Reads ────────────────────────────────────────────────────────────────────

@router.get("/dives")
async def list_dives(user_id: str = Depends(get_request_user_id)):
    return {"dives": await _run(svc.list_dives, user_id)}


@router.get("/dive")
async def get_dive(category: str = Query(...), strategy: str = Query(...), owner_id: Optional[str] = Query(None),
                   user_id: str = Depends(get_request_user_id)):
    return await _run(svc.get_dive, user_id, category, strategy, owner_id)


@router.get("/stats")
async def get_stats(category: str = Query(...), strategy: str = Query(...), side: Optional[Side] = Query(None),
                    owner_id: Optional[str] = Query(None), user_id: str = Depends(get_request_user_id)):
    return await _run(svc.stats, user_id, category, strategy, side, owner_id)


@router.get("/stats/all")
async def get_stats_all(user_id: str = Depends(get_request_user_id)):
    return {"dives": await _run(svc.stats_all, user_id)}


# ── Marked days ──────────────────────────────────────────────────────────────

@router.put("/setup")
async def put_setup(req: SetupIn, user_id: str = Depends(get_request_user_id)):
    fields = req.model_dump(exclude_unset=True, exclude={"category", "strategy", "symbol", "date", "side"})
    return await _run(svc.upsert_setup, user_id, req.category, req.strategy, req.symbol, req.date, req.side, fields)


@router.delete("/setup")
async def delete_setup(category: str = Query(...), strategy: str = Query(...), symbol: str = Query(...),
                       date: str = Query(...), side: Side = Query(...), user_id: str = Depends(get_request_user_id)):
    deleted = await _run(svc.delete_setup, user_id, category, strategy, symbol, date, side)
    return {"status": "deleted" if deleted else "not_found"}


@router.put("/setup/answers")
async def put_answers(req: AnswersIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.set_answers, user_id, req.category, req.strategy, req.symbol, req.date, req.side, req.answers)


@router.post("/setup/save-to-patterns")
async def save_to_patterns(req: SetupRef, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.save_to_patterns, user_id, req.category, req.strategy, req.symbol, req.date, req.side)


# ── Questions ────────────────────────────────────────────────────────────────

@router.post("/questions")
async def add_question(req: QuestionIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.add_question, user_id, req.category, req.strategy, req.text)


@router.post("/questions/{question_id}/update")
async def update_question(question_id: str, req: QuestionUpdateIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.update_question, user_id, req.category, req.strategy, question_id, req.text)


@router.post("/questions/{question_id}/archive")
async def archive_question(question_id: str, req: QuestionRef, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.archive_question, user_id, req.category, req.strategy, question_id)


@router.post("/questions/{question_id}/restore")
async def restore_question(question_id: str, req: QuestionRef, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.restore_question, user_id, req.category, req.strategy, question_id)
