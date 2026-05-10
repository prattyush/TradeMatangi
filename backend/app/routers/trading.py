from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Trade, Position, TradeRequest, TradeSide
from app.services import trading as trading_svc
from app.services import simulation as sim_svc

router = APIRouter(prefix="/api/trades", tags=["trades"])


def _get_latest_price(session) -> float:
    """Return the last known close price for the session."""
    return getattr(session, "last_price", 0.0)


@router.post("/buy", response_model=Trade)
async def buy(req: TradeRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    price = _get_latest_price(session)
    if price <= 0.0:
        raise HTTPException(status_code=400, detail="No valid price available yet")
    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.BUY, price=price, timestamp=timestamp,
        symbol=session.symbol,
    )
    return trade


@router.post("/sell", response_model=Trade)
async def sell(req: TradeRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    price = _get_latest_price(session)
    if price <= 0.0:
        raise HTTPException(status_code=400, detail="No valid price available yet")
    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.SELL, price=price, timestamp=timestamp,
        symbol=session.symbol,
    )
    return trade


@router.get("", response_model=list[Trade])
async def get_trades(session_id: str = Query(...)):
    return trading_svc.get_trades(session_id)


@router.get("/position", response_model=Position)
async def get_position(session_id: str = Query(...)):
    session = sim_svc.get_session(session_id)
    symbol = session.symbol if session else None
    return trading_svc.get_position(session_id, symbol=symbol)
