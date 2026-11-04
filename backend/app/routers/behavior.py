"""
Behavior API — Manual Behavioral Analysis (Phase 23).

Prefix: /api/behavior

Questions are per user. Marks are per (session, round trip, question) and follow the
same access rules as trade labels: the session owner writes, a viewer with shared
read access (real sessions) can read.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.dependencies import get_request_user_id
from app.routers.performance import filters as performance_filters
from app.services import behavior_service as svc
from app.services import habit_ledger_service
from app.services import trade_label_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/behavior", tags=["behavior"])


class QuestionIn(BaseModel):
    text: str
    kind: Literal["entry", "exit"]


class QuestionUpdateIn(BaseModel):
    text: str


class QuestionOut(BaseModel):
    question_id: str
    kind: Literal["entry", "exit"]
    text: str
    status: Literal["active", "archived"]
    sort_order: int
    created_at: str
    archived_at: Optional[str] = None


class QuestionsResponse(BaseModel):
    questions: list[QuestionOut]


class MarkOut(BaseModel):
    round_trip_index: int
    question_id: str
    kind: str


class MarksResponse(BaseModel):
    marks: list[MarkOut]


class MarksIn(BaseModel):
    session_id: str
    round_trip_index: int = Field(ge=0)
    answers: dict[str, bool]


class DayCounts(BaseModel):
    date: str
    counts: dict[str, int]


class StatsResponse(BaseModel):
    questions: list[QuestionOut]
    days: list[DayCounts]


class FlaggedTrade(BaseModel):
    session_id: str
    date: str
    symbol: str
    session_type: str
    round_trip_index: int
    pnl: Optional[float] = None


class FlaggedTradesResponse(BaseModel):
    trades: list[FlaggedTrade]


def _session(session_id: str, user_id: str, *, write: bool) -> dict:
    from app.services.analysis_sharing import can_read
    session = trade_label_service._load_session(session_id)
    allowed = session and (session.get("user_id") == user_id if write else can_read(session, user_id))
    if not allowed:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


def _bad_request(exc: Exception) -> HTTPException:
    status = 404 if isinstance(exc, LookupError) else 400
    return HTTPException(status_code=status, detail=str(exc.args[0]) if exc.args else str(exc))


async def _run(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except (ValueError, LookupError) as exc:
        raise _bad_request(exc)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Behavior request failed")
        raise HTTPException(status_code=500, detail="Behavior data could not be read or saved; retry later") from exc


class LedgerTrade(BaseModel):
    cycle_id: str
    session_id: str
    date: str
    entry_time: int
    exit_time: Optional[int] = None
    symbol: str = ""
    right: Optional[str] = None
    strike: Optional[float] = None
    direction: str = ""
    net_pnl: float
    pnl_pct: Optional[float] = None
    capital_pct: Optional[float] = None
    risk_pct: Optional[float] = None
    entries: int
    exits: int
    holding_seconds: Optional[int] = None
    bars: Optional[int] = None
    r_multiple: Optional[float] = None
    entry_method: Optional[str] = None
    habits: list[str]


class LedgerCoverage(BaseModel):
    closed_trades: int
    marked_trades: int
    marks: int
    unmatched_marks: int
    open_marked_trades: int
    trades_without_capital: int
    trades_without_bars: int
    truncated: bool


class HabitLedgerResponse(BaseModel):
    questions: list[QuestionOut]
    trades: list[LedgerTrade]
    coverage: LedgerCoverage


# ── Questions ────────────────────────────────────────────────────────────────

@router.get("/questions", response_model=QuestionsResponse)
async def list_questions(include_archived: bool = Query(False), user_id: str = Depends(get_request_user_id)):
    return {"questions": await _run(svc.list_questions, user_id, include_archived)}


@router.post("/questions", response_model=QuestionOut)
async def add_question(req: QuestionIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.add_question, user_id, req.text, req.kind)


@router.post("/questions/{question_id}/update", response_model=QuestionOut)
async def update_question(question_id: str, req: QuestionUpdateIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.update_question, user_id, question_id, req.text)


@router.post("/questions/{question_id}/archive", response_model=QuestionOut)
async def archive_question(question_id: str, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.archive_question, user_id, question_id)


@router.post("/questions/{question_id}/restore", response_model=QuestionOut)
async def restore_question(question_id: str, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.restore_question, user_id, question_id)


# ── Marks ────────────────────────────────────────────────────────────────────

@router.get("/marks", response_model=MarksResponse)
async def get_marks(session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    await _run(_session, session_id, user_id, write=False)
    return {"marks": await _run(svc.get_marks, session_id)}


@router.post("/marks", response_model=MarksResponse)
async def set_marks(req: MarksIn, user_id: str = Depends(get_request_user_id)):
    session = await _run(_session, req.session_id, user_id, write=True)
    return {"marks": await _run(svc.set_marks, user_id, session, req.round_trip_index, req.answers)}


@router.get("/marks/by-question", response_model=FlaggedTradesResponse)
async def marks_by_question(
    question_id: str = Query(...),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    session_type: Optional[str] = Query(None),
    instrument_type: Optional[str] = Query(None),
    user_id: str = Depends(get_request_user_id),
):
    return {"trades": await _run(svc.marks_by_question, user_id, question_id, start_date, end_date, symbol, session_type, instrument_type)}


# ── Stats ────────────────────────────────────────────────────────────────────

@router.get("/stats", response_model=StatsResponse)
async def stats(
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    symbol: Optional[str] = Query(None),
    session_type: Optional[str] = Query(None),
    instrument_type: Optional[str] = Query(None),
    user_id: str = Depends(get_request_user_id),
):
    return await _run(svc.get_stats, user_id, start_date, end_date, symbol, session_type, instrument_type)


# ── Habit ledger (Stats → Habits) ─────────────────────────────────────────────

@router.get("/habit-ledger", response_model=HabitLedgerResponse)
async def habit_ledger(criteria: dict = Depends(performance_filters), user_id: str = Depends(get_request_user_id)):
    """One row per closed own intraday trade in the filtered scope, with the habits it was marked with."""
    return await _run(habit_ledger_service.load_ledger, user_id, criteria)
