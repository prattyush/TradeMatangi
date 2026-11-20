"""
Day score API — the 0 to 100 score of a trading day (Phase 27, S6).

Prefix: /api/analysis

Owner only (the score is read from the caller's own sessions and labels) and read only for the caller: the first read of a day that
can be scored computes it and stores it (``DayScores``); nothing here touches a trade, an order, a label or the broker.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_request_user_id
from app.services import day_score_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/analysis", tags=["day-score"])


async def _run(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(lambda: fn(*args, **kwargs))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/day-score")
async def day_score(date: str = Query(...), user_id: str = Depends(get_request_user_id)):
    """The score of a market date: ``status`` is ``scored``, ``pending_labels`` (label every closed trade first) or ``no_trades``."""
    return await _run(svc.get_day_score, user_id, date)


@router.get("/day-scores")
async def day_scores(start: str | None = Query(None), end: str | None = Query(None), compute: bool = Query(False), user_id: str = Depends(get_request_user_id)):
    """Stored scores over a date range, oldest first (for the Stats trend). ``compute=true`` also scores days that have none yet, a bounded number per call (``pending`` says how many are left)."""
    return await _run(svc.scores_in_range, user_id, start, end, compute=compute)
