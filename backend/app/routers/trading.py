from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Trade, Position, TradeRequest, TradeSide
from app.services import trading as trading_svc
from app.services import simulation as sim_svc
from app.services import wallet_service
from app.services.user_service import get_user_id
from app.services.wallet_service import InsufficientFundsError

router = APIRouter(prefix="/api/trades", tags=["trades"])


def _get_price_for_right(session, right: str | None) -> float:
    """Return the last known close price for the given right (CE/PE) or equity."""
    if right == "CE":
        return getattr(session, "last_price_ce", 0.0)
    if right == "PE":
        return getattr(session, "last_price_pe", 0.0)
    return getattr(session, "last_price", 0.0)


def _resolve_right(session, req_right: str | None) -> str | None:
    """For options sessions: use req.right if provided, else fall back to session.right."""
    if session.instrument_type != "options":
        return None
    return req_right if req_right is not None else session.right


@router.post("/buy", response_model=Trade)
async def buy(req: TradeRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    right = _resolve_right(session, req.right)
    price = _get_price_for_right(session, right)
    if price <= 0.0:
        raise HTTPException(status_code=400, detail="No valid price available yet")

    try:
        wallet_service.debit(get_user_id(), price, session.date)
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc))

    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.BUY, price=price, timestamp=timestamp,
        symbol=session.symbol,
        instrument_type=session.instrument_type,
        strike=session.strike,
        expiry=session.expiry,
        right=right,
    )
    return trade


@router.post("/sell", response_model=Trade)
async def sell(req: TradeRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    right = _resolve_right(session, req.right)
    price = _get_price_for_right(session, right)
    if price <= 0.0:
        raise HTTPException(status_code=400, detail="No valid price available yet")

    wallet_service.credit(get_user_id(), price, session.date)

    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.SELL, price=price, timestamp=timestamp,
        symbol=session.symbol,
        instrument_type=session.instrument_type,
        strike=session.strike,
        expiry=session.expiry,
        right=right,
    )
    return trade


@router.get("", response_model=list[Trade])
async def get_trades(session_id: str = Query(...)):
    return trading_svc.get_trades(session_id)


@router.get("/position", response_model=Position)
async def get_position(session_id: str = Query(...), right: str | None = Query(default=None)):
    session = sim_svc.get_session(session_id)
    symbol = session.symbol if session else None
    # Resolve effective right: explicit param > session.right (Sprint 3 compat)
    effective_right = right if right is not None else (session.right if session else None)
    return trading_svc.get_position(session_id, symbol=symbol, right=effective_right)
