"""Browse: paged candles for an index or equity, read-only and independent of any session or portfolio."""
from datetime import date as calendar_date

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_desktop_user_id
from app.services import browse_history, swing_market
from app.services.history_workers import run_history

router = APIRouter(prefix="/browse", tags=["browse"])


@router.get("/history")
async def history(
    symbol: str = Query(...),
    interval: int = Query(3),
    date: str | None = Query(default=None, description="Anchor trading day (YYYY-MM-DD); today when omitted"),
    before: int | None = Query(default=None, ge=0, description="Open time of the oldest candle held (IST-as-UTC seconds): returns the days before it"),
    days: int | None = Query(default=None, ge=1, le=500, description="Trading days wanted in this page"),
    _: str = Depends(get_desktop_user_id),
):
    if interval not in browse_history.INTERVALS:
        raise HTTPException(422, "Unsupported interval")
    try:
        anchor = calendar_date.fromisoformat(date or swing_market.today())
    except ValueError as exc:
        raise HTTPException(422, "date must be YYYY-MM-DD") from exc
    try:
        return await run_history(browse_history.page, symbol, interval, anchor, before, days)
    except browse_history.BrowseUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
