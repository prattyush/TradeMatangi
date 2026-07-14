"""
Trade Labels API — REST endpoints for round-trips, labels, tags, stats.

Prefix: /api/analysis  (same prefix as existing analysis router)
"""
from __future__ import annotations

import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services import trade_label_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/analysis", tags=["trade_labels"])


# ── Response models ────────────────────────────────────────────────────────────

class RoundTripTradeOut(BaseModel):
    trade_id: str
    side: str
    quantity: int
    price: float
    timestamp: int
    right: Optional[str] = None
    strike: Optional[int] = None


class RoundTripOut(BaseModel):
    index: int
    right: Optional[str]
    entry_trades: list[RoundTripTradeOut]
    exit_trades: list[RoundTripTradeOut]
    pnl: float


class LabelIn(BaseModel):
    session_id: str
    round_trip_index: int
    expected_category: str = ""
    expected_strategy: str = ""
    actual_category: str = ""
    actual_strategy: str = ""
    entry_tag: str = "AS_PER_PATTERN"
    exit_tag: str = "AS_PER_PATTERN"


class BatchLabelRequest(BaseModel):
    labels: list[LabelIn]


class LabelOut(BaseModel):
    session_id: str
    round_trip_index: int
    expected_category: str
    expected_strategy: str
    actual_category: str
    actual_strategy: str
    entry_tag: str
    exit_tag: str
    round_trip_pnl: float
    round_trip_pnl_pct: float
    created_at: str
    updated_at: str


class StatsByPattern(BaseModel):
    category: str
    strategy: str
    count: int
    win_pct: float
    avg_pnl_pct: float


class StatsByTag(BaseModel):
    tag: str
    count: int
    avg_pnl_pct: float


class MismatchSummary(BaseModel):
    mismatch_pct: float
    profit_pct_matched: float
    profit_pct_mismatched: float
    most_mismatched_expected: Optional[StatsByPattern] = None
    most_mismatched_actual: Optional[StatsByPattern] = None


class StatsResponse(BaseModel):
    total_trades: int
    win_pct: float
    avg_pnl_pct: float
    pnl_95th_percentile: float
    per_pattern: list[StatsByPattern]
    mismatch: MismatchSummary
    by_entry_tag: list[StatsByTag]
    by_exit_tag: list[StatsByTag]


class TagListResponse(BaseModel):
    tags: list[str]


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/round-trips", response_model=list[RoundTripOut])
async def get_round_trips(
    session_id: str = Query(...),
    user_id: str = Depends(get_request_user_id),
):
    """Compute FIFO round-trips for a session."""
    try:
        trips = svc.compute_round_trips_for_session(session_id)
        return trips
    except Exception as exc:
        logger.error("round-trips error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to compute round trips")


@router.get("/labels", response_model=list[LabelOut])
async def get_labels(
    session_id: str = Query(...),
    user_id: str = Depends(get_request_user_id),
):
    """Return saved labels for a session."""
    try:
        return svc.get_labels_for_session(session_id)
    except Exception as exc:
        logger.error("get_labels error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to get labels")


@router.post("/labels", response_model=list[LabelOut])
async def save_labels(
    body: BatchLabelRequest,
    user_id: str = Depends(get_request_user_id),
):
    """Batch upsert labels for one or more sessions."""
    try:
        labels_by_session: dict[str, list[dict]] = {}
        for lbl in body.labels:
            sid = lbl.session_id
            if sid not in labels_by_session:
                labels_by_session[sid] = []
            labels_by_session[sid].append(lbl.model_dump())

        all_saved = []
        for sid, lbls in labels_by_session.items():
            saved = svc.save_labels(sid, lbls, user_id)
            all_saved.extend(saved)

        return all_saved
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.error("save_labels error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to save labels")


@router.put("/labels/{session_id}/{round_trip_index}", response_model=LabelOut)
async def update_label(
    session_id: str,
    round_trip_index: int,
    body: LabelIn,
    user_id: str = Depends(get_request_user_id),
):
    """Update a single label."""
    try:
        result = svc.update_label(session_id, round_trip_index, body.model_dump(exclude={"session_id", "round_trip_index"}))
        if result is None:
            raise HTTPException(status_code=404, detail="Label not found")
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("update_label error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to update label")


@router.get("/entry-tags", response_model=TagListResponse)
async def get_entry_tags(
    user_id: str = Depends(get_request_user_id),
):
    """Distinct entry tag values for user."""
    try:
        tags = svc.list_entry_tags(user_id)
        return {"tags": tags}
    except Exception as exc:
        logger.error("entry-tags error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list entry tags")


@router.get("/exit-tags", response_model=TagListResponse)
async def get_exit_tags(
    user_id: str = Depends(get_request_user_id),
):
    """Distinct exit tag values for user."""
    try:
        tags = svc.list_exit_tags(user_id)
        return {"tags": tags}
    except Exception as exc:
        logger.error("exit-tags error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list exit tags")


@router.get("/stats", response_model=StatsResponse)
async def get_stats(
    symbol: Optional[str] = Query(default=None),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    instrument_type: Optional[str] = Query(default=None),
    session_type: Optional[str] = Query(default=None),
    user_id: str = Depends(get_request_user_id),
):
    """Aggregated stats from labeled trades."""
    try:
        return svc.get_stats(
            user_id=user_id,
            symbol=symbol,
            start_date=start_date,
            end_date=end_date,
            instrument_type=instrument_type,
            session_type=session_type,
        )
    except Exception as exc:
        logger.error("stats error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to compute stats")
