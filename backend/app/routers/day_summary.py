"""
Day summary API — one card per market date for the Analysis Summary (Phase 27, S10).

Prefix: /api/analysis

Owner only and read only. The filters are the Stats screen's (``performance.filters``); the Summary always covers the caller's own
intraday sessions (no swing, no Strategy Practice, nothing shared), newest day first, at most 62 days per call.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException

from app.dependencies import get_request_user_id
from app.routers.performance import filters
from app.services import day_summary_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/analysis", tags=["day-summary"])


@router.get("/day-summary")
async def day_summary(criteria: dict = Depends(filters), user_id: str = Depends(get_request_user_id)):
    """``days`` (newest first), ``total_days`` in the filter and ``truncated`` when older days were left out (``svc.MAX_DAYS`` per call)."""
    try:
        return await asyncio.to_thread(svc.day_summary, user_id, criteria)
    except Exception as exc:
        logger.exception("Day summary read failed")
        raise HTTPException(503, "The day summary could not be read; retry later") from exc
