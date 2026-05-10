from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Trade, Position, TradeRequest, TradeSide
from app.services import trading as trading_svc
from app.services import simulation as sim_svc
from app.config import DEFAULT_SYMBOL

router = APIRouter(prefix="/api/trades", tags=["trades"])


def _current_price(session_id: str) -> float:
    """Get the most recent tick price from the session queue (non-destructive peek via trades)."""
    # The frontend sends the current price; for backend records we use the last known trade price
    # or fall back to 0 if no session exists. The price is passed in the request body.
    return 0.0


@router.post("/buy", response_model=Trade)
async def buy(req: TradeRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    # Get the latest price from last tick (stored in session)
    price = _get_latest_price(session)
    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.BUY, price=price, timestamp=timestamp
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
    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.SELL, price=price, timestamp=timestamp
    )
    return trade


@router.get("", response_model=list[Trade])
async def get_trades(session_id: str = Query(...)):
    return trading_svc.get_trades(session_id)


@router.get("/position", response_model=Position)
async def get_position(session_id: str = Query(...)):
    return trading_svc.get_position(session_id)


def _get_latest_price(session) -> float:
    """Return the last known close price for the session (stored on session object)."""
    return getattr(session, "last_price", 0.0)
