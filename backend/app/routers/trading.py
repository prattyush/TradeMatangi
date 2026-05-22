import asyncio
import json
import logging
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from app.models.schemas import Trade, Position, TradeRequest, TradeSide
from app.services import trading as trading_svc
from app.services import simulation as sim_svc
from app.services import wallet_service
from app.services.wallet_service import InsufficientFundsError
from app.config import LOT_SIZES, KOTAK_SLIPPAGE_PCT
from app.dependencies import get_request_user_id

logger = logging.getLogger(__name__)

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


def _place_kotak_direct(session, side: TradeSide, price: float, lot_size: int, right) -> JSONResponse:
    """Place an immediate buy/sell on Kotak as a limit order; fill arrives via SSE order_filled."""
    from app.services.kotak_service import get_service as get_kotak, KotakError

    if side == TradeSide.BUY:
        kotak_price = round(price * (1 + KOTAK_SLIPPAGE_PCT), 2)
        side_code = "B"
    else:
        kotak_price = round(price * (1 - KOTAK_SLIPPAGE_PCT), 2)
        side_code = "S"

    try:
        kotak_svc = get_kotak()
        kotak_order_id = kotak_svc.place_limit_order(
            symbol=session.symbol,
            side=side_code,
            qty=lot_size,
            price=kotak_price,
        )
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    loop = asyncio.get_event_loop()

    def _make_cb(sess, trade_side: TradeSide, qty: int, rt):
        def on_fill(k_id: str, fill_side: str, fill_qty: int, fill_price: float):
            if trade_side == TradeSide.BUY:
                try:
                    wallet_service.debit(sess.user_id, round(fill_price * fill_qty, 2), sess.date)
                except Exception:
                    pass
            else:
                wallet_service.credit(sess.user_id, round(fill_price * fill_qty, 2), sess.date)

            trading_svc.record_trade(
                sess.session_id, trade_side,
                price=fill_price,
                timestamp=int(sess.current_time) if sess.current_time else 0,
                symbol=sess.symbol,
                instrument_type=sess.instrument_type,
                strike=_strike_for_right(sess, rt),
                expiry=sess.expiry,
                right=rt,
                quantity=fill_qty,
                brokerage_per_order=sess.brokerage_per_order,
                user_id=sess.user_id,
                session_type=sess.session_type,
            )
            evt = {
                "type": "order_filled",
                "order_id": f"direct_{k_id}",
                "side": trade_side.value,
                "quantity": fill_qty,
                "trigger_price": fill_price,
                "filled_price": fill_price,
                "filled_at": int(sess.current_time) if sess.current_time else 0,
                "right": rt,
            }
            try:
                sess.queue.put_nowait(json.dumps(evt))
            except Exception:
                pass

        return on_fill

    kotak_svc.register_fill_callback(
        kotak_order_id, _make_cb(session, side, lot_size, right), loop
    )

    def _make_direct_reject_cb(sess):
        def on_reject(kotak_id: str, reason: str):
            import logging as _log
            import json as _json
            _log.getLogger(__name__).warning(
                "Kotak rejected direct order %s for session %s: %s",
                kotak_id, sess.session_id, reason,
            )
            error_event = {"type": "broker_error", "message": f"Kotak rejected order: {reason}"}
            try:
                sess.queue.put_nowait(_json.dumps(error_event))
            except Exception:
                pass
        return on_reject

    kotak_svc.register_reject_callback(
        kotak_order_id, _make_direct_reject_cb(session), loop
    )
    return JSONResponse(
        status_code=202,
        content={"status": "broker_pending", "kotak_order_id": kotak_order_id},
    )


@router.post("/buy")
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

    if session.session_type == "real":
        return _place_kotak_direct(session, TradeSide.BUY, price, lot_size, right)

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
        session_type=session.session_type,
    )
    return trade


@router.post("/sell")
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

    if session.session_type == "real":
        return _place_kotak_direct(session, TradeSide.SELL, price, lot_size, right)

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
        session_type=session.session_type,
    )
    return trade


@router.get("/by-context")
async def get_trades_by_context(
    symbol: str = Query(...),
    date: str = Query(...),
    instrument_type: str = Query(...),
    session_type: str = Query("sim"),
    user_id: str = Depends(get_request_user_id),
):
    """
    Return all trades across all sessions for a given user + symbol + date +
    instrument_type + session_type combination. Used to populate trade history
    with previous sessions when the user restarts a sim or paper session.
    """
    try:
        from app.services.analysis_service import get_sessions_for_user, get_trades_for_session
        sessions = get_sessions_for_user(
            user_id=user_id,
            symbol=symbol,
            start_date=date,
            end_date=date,
            instrument_type=instrument_type,
            session_type=session_type,
        )
        session_ids = [s.get("session_id") for s in sessions if s.get("session_id")]
        all_trades: list[dict] = []
        for sid in session_ids:
            all_trades.extend(get_trades_for_session(sid))
        all_trades.sort(key=lambda t: int(t.get("timestamp", 0)))
        return {"trades": all_trades, "session_ids": session_ids}
    except Exception as exc:
        logger.warning(
            "get_trades_by_context failed for %s %s %s %s: %s",
            symbol, date, instrument_type, session_type, exc,
        )
        return {"trades": [], "session_ids": []}


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
