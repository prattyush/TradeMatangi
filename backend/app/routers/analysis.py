import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.services import analysis_service
from app.dependencies import get_request_user_id

logger = logging.getLogger(__name__)

_BAR_SECONDS = 180  # 3-min candle width — must match frontend Math.floor(t/180)*180

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
    underlying_price: float | None = None


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


@router.get("/trades")
async def get_trades_for_analysis(
    user_id: str = Query(...),
    from_date: str = Query(..., alias="from", description="YYYY-MM-DD"),
    to_date: str = Query(..., alias="to", description="YYYY-MM-DD"),
    symbol: str | None = Query(default=None),
    session_type: str | None = Query(default=None, description="sim, paper, or real"),
) -> list[dict]:
    """
    Fetch sessions + trades for a user in a date range.
    Used by aihelper analysis service — not for the frontend UI.
    Returns: [{session summary fields..., "trades": [{trade fields...}]}]
    """
    sessions = analysis_service.get_sessions_for_user(
        user_id, start_date=from_date, end_date=to_date,
        symbol=symbol, session_type=session_type,
    )
    result = []
    for s in sessions:
        trades = analysis_service.get_trades_for_session(s["session_id"])
        summary = analysis_service.compute_session_summary(s, trades)
        trade_list = [
            {
                "trade_id": t.get("trade_id", ""),
                "side": t.get("side", ""),
                "price": float(t.get("price", 0)),
                "quantity": int(t.get("quantity", 0)),
                "timestamp": int(t.get("timestamp", 0)),
                "right": t.get("right"),
                "strike": t.get("strike"),
                "expiry": t.get("expiry"),
                "commission": float(t.get("commission", 0)),
            }
            for t in trades
        ]
        result.append({
            "session_id": summary.get("session_id", ""),
            "date": summary.get("date", ""),
            "symbol": summary.get("symbol", ""),
            "session_type": summary.get("session_type", "sim"),
            "instrument_type": summary.get("instrument_type", "equity"),
            "expiry": summary.get("expiry"),
            "session_capital": summary.get("session_capital", 0),
            "net_pnl": summary.get("net_pnl", 0),
            "pnl_pct": summary.get("pnl_pct", 0),
            "total_commission": summary.get("total_commission", 0),
            "trade_count": summary.get("trade_count", 0),
            "trades": trade_list,
        })
    return result


@router.get("/ohlc-context")
async def get_ohlc_context(
    symbol: str = Query(...),
    date: str = Query(..., description="YYYY-MM-DD"),
    entry_ts: int = Query(...),
    exit_ts: int | None = Query(default=None),
    right: str | None = Query(default=None),
    strike: int | None = Query(default=None),
    expiry: str | None = Query(default=None),
    pre_bars: int = Query(default=6, ge=1, le=20),
    post_bars: int = Query(default=3, ge=1, le=10),
) -> dict:
    """
    Return labeled OHLC candles surrounding a trade's entry and exit timestamps.
    Used by aihelper pattern_detector for programmatic trade analysis.

    Labels: "pre" (before entry), "entry", "trade" (between), "exit", "post" (after exit).
    If entry and exit are in the same bar: labeled "entry_exit".
    """
    from app.services.data_loader import load_dataframe, resample_to_candles
    from app.services.options_service import load_options_dataframe

    is_options = right is not None and strike is not None and expiry is not None

    # Ensure data is present and complete before loading — handles both missing files
    # and partially-written files (e.g. paper/real session only downloaded 09:15–10:00).
    # fetch_historical / fetch_options_historical are no-ops when data is already complete.
    if is_options:
        try:
            from app.services.options_service import fetch_options_historical
            fetch_options_historical(symbol, date, int(strike), expiry, right)
        except Exception as exc:
            logger.warning("ohlc-context: options Breeze fetch failed %s %s %s %s %s: %s",
                           symbol, date, right, strike, expiry, exc)
    else:
        try:
            from app.services.broker_service import fetch_historical
            fetch_historical(symbol, date)
        except Exception as exc:
            logger.warning("ohlc-context: equity Breeze fetch failed %s %s: %s", symbol, date, exc)

    try:
        if is_options:
            df = load_options_dataframe(symbol, date, int(strike), expiry, right)
        else:
            df = load_dataframe(symbol, date)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    candles = resample_to_candles(df)
    records = [
        {
            "time": int(ts.timestamp()),
            "open": round(float(row.open), 2),
            "high": round(float(row.high), 2),
            "low": round(float(row.low), 2),
            "close": round(float(row.close), 2),
        }
        for ts, row in candles.iterrows()
    ]

    def _bar_time(ts: int) -> int:
        return (ts // _BAR_SECONDS) * _BAR_SECONDS

    entry_bar_time = _bar_time(entry_ts)
    entry_idx = next((i for i, r in enumerate(records) if r["time"] == entry_bar_time), None)
    if entry_idx is None:
        raise HTTPException(status_code=404, detail=f"Entry bar not found for ts={entry_ts}")

    if exit_ts is not None:
        exit_bar_time = _bar_time(exit_ts)
        exit_idx = next((i for i, r in enumerate(records) if r["time"] == exit_bar_time), None)
    else:
        exit_idx = None

    end_ref = exit_idx if exit_idx is not None else entry_idx
    start_idx = max(0, entry_idx - pre_bars)
    end_idx = min(len(records) - 1, end_ref + post_bars)

    labeled = []
    for i in range(start_idx, end_idx + 1):
        r = records[i]
        if i < entry_idx:
            label = "pre"
        elif i == entry_idx and exit_idx is not None and i == exit_idx:
            label = "entry_exit"
        elif i == entry_idx:
            label = "entry"
        elif exit_idx is not None and i == exit_idx:
            label = "exit"
        elif exit_idx is not None and i < exit_idx:
            label = "trade"
        else:
            label = "post"
        labeled.append({**r, "label": label})

    return {"symbol": symbol, "date": date, "bars": labeled}
