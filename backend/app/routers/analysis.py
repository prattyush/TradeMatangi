from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.services import analysis_service
from app.dependencies import get_request_user_id

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


class SessionSummary(BaseModel):
    session_id: str
    user_id: str
    symbol: str
    date: str
    start_time: str | None = None
    instrument_type: str = "equity"
    session_type: str = "sim"
    strike: int | None = None
    expiry: str | None = None
    session_capital: float = 0.0
    net_pnl: float = 0.0
    pnl_pct: float = 0.0
    total_commission: float = 0.0
    trade_count: int = 0
    buy_count: int = 0
    sell_count: int = 0


class TradeSummary(BaseModel):
    trade_id: str
    session_id: str
    user_id: str
    symbol: str
    side: str
    quantity: int
    price: float
    timestamp: int
    instrument_type: str = "equity"
    right: str | None = None
    strike: int | None = None
    expiry: str | None = None
    commission: float = 0.0


class SessionDetail(SessionSummary):
    trades: list[TradeSummary] = []


@router.get("/sessions", response_model=list[SessionSummary])
async def get_sessions(
    symbol: str | None = Query(default=None),
    start_date: str | None = Query(default=None, description="YYYY-MM-DD"),
    end_date: str | None = Query(default=None, description="YYYY-MM-DD"),
    instrument_type: str | None = Query(default=None),
    session_type: str | None = Query(default=None, description="sim or paper"),
    user_id: str = Depends(get_request_user_id),
):
    sessions = analysis_service.get_sessions_for_user(
        user_id, symbol=symbol,
        start_date=start_date, end_date=end_date,
        instrument_type=instrument_type,
        session_type=session_type,
    )
    result = []
    for s in sessions:
        trades = analysis_service.get_trades_for_session(s["session_id"])
        summary = analysis_service.compute_session_summary(s, trades)
        result.append(summary)
    return result


@router.get("/sessions/{session_id}", response_model=SessionDetail)
async def get_session_detail(session_id: str):
    detail = analysis_service.get_session_summary_with_trades(session_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Session not found")
    return detail
