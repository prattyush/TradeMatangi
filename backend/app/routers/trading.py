from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Trade, Position, TradeRequest, TradeSide
from app.services import trading as trading_svc
from app.services import simulation as sim_svc
from app.services import wallet_service
from app.services.wallet_service import InsufficientFundsError
from app.config import LOT_SIZES

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


def _strike_for_right(session, right: str | None) -> int | None:
    """Return the correct strike for the given right (CE/PE uses per-right strike if set)."""
    if right == "CE" and session.strike_ce is not None:
        return session.strike_ce
    if right == "PE" and session.strike_pe is not None:
        return session.strike_pe
    return session.strike


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

    lot_size = LOT_SIZES.get(session.symbol, 1) if session.instrument_type == "options" else 1

    try:
        wallet_service.debit(session.user_id, price * lot_size, session.date)
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc))

    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.BUY, price=price, timestamp=timestamp,
        symbol=session.symbol,
        instrument_type=session.instrument_type,
        strike=_strike_for_right(session, right),
        expiry=session.expiry,
        right=right,
        quantity=lot_size,
        brokerage_per_order=session.brokerage_per_order,
        user_id=session.user_id,
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

    lot_size = LOT_SIZES.get(session.symbol, 1) if session.instrument_type == "options" else 1

    wallet_service.credit(session.user_id, price * lot_size, session.date)

    timestamp = int(session.current_time)
    trade = trading_svc.record_trade(
        req.session_id, TradeSide.SELL, price=price, timestamp=timestamp,
        symbol=session.symbol,
        instrument_type=session.instrument_type,
        strike=_strike_for_right(session, right),
        expiry=session.expiry,
        right=right,
        quantity=lot_size,
        brokerage_per_order=session.brokerage_per_order,
        user_id=session.user_id,
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
