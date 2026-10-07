import asyncio
import json
import logging
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from app.models.schemas import Trade, Position, TradeRequest, TradeSide
from app.services import trading as trading_svc
from app.services import simulation as sim_svc
from app.services import wallet_service, order_service
from app.services.execution_analytics import snapshot
from app.services.wallet_service import InsufficientFundsError
from app.config import LOT_SIZES, EQUITY_MIS_MARGIN_RATE
from app.dependencies import get_request_user_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/trades", tags=["trades"])


def _emit_trade_event(session, trade: Trade) -> None:
    """Push a new_trade SSE event so the frontend adds the trade without a page reload."""
    try:
        event = {"type": "new_trade"}
        event.update(trade.model_dump(mode="json"))
        session.queue.put_nowait(json.dumps(event))
    except Exception:
        logger.debug("Could not emit new_trade SSE event for trade %s", trade.trade_id)


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


def _uses_equity_intraday_margin(session, right: str | None = None) -> bool:
    return (
        right is None
        and session.instrument_type == "equity"
        and session.session_type in ("sim", "stepwise", "paper", "real")
    )


def _margin_rate_for(session, right: str | None = None) -> float:
    return EQUITY_MIS_MARGIN_RATE if _uses_equity_intraday_margin(session, right) else 1.0


def _place_kotak_direct(session, side: TradeSide, price: float, lot_size: int, right, capital_fraction=None) -> JSONResponse:
    """Place an immediate, tracked marketable LIMIT with exact contract identity."""
    from app.services import order_service
    from app.services.broker_order_service import submit_immediate
    from app.models.schemas import Order, OrderType
    if getattr(session, "broker_refresh_events", None) is not None:
        raise HTTPException(status_code=409, detail="Broker refresh is in progress; retry shortly")
    from app.services.execution_price_service import gap_for, limit_price
    gap = gap_for(session.user_id)
    from app.services.execution_analytics import snapshot
    order = Order(analytics=snapshot(session, quantity=lot_size, price=price, side=side.value, capital_fraction=capital_fraction, margin_rate=_margin_rate_for(session, right), entry_method="MARKET", exit_method="MARKET"), session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
        side=side, order_type=OrderType.LIMIT, quantity=lot_size, limit_price=limit_price(side, price, gap),
        market_order=True, execution_gap_pct=gap, quote_price=price,
        trigger_price=price, created_at=int(session.current_time or 0), right=right,
        strike=_strike_for_right(session, right), expiry=session.expiry if right else None,
        source="direct_market", wallet_ledger_kind="real", wallet_ledger_id=session.wallet_ledger_id or None)
    order_service._orders.setdefault(session.session_id, {})[order.order_id] = order
    try:
        submit_immediate(session, order, asyncio.get_running_loop())
    except Exception as exc:
        if not order.kotak_order_id:
            order_service._orders[session.session_id].pop(order.order_id, None)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return JSONResponse(status_code=202, content={"status": "broker_pending", "kotak_order_id": order.kotak_order_id})


def _direct_trade_quantity(session, right, price, funds_ratio_pct):
    lot_size = LOT_SIZES.get(session.symbol, 1) if session.instrument_type == "options" else 1
    if funds_ratio_pct is None:
        return lot_size
    if not 0 < funds_ratio_pct <= 1:
        raise HTTPException(status_code=400, detail="funds_ratio_pct must be between 0 and 1")
    try:
        current_wallet = wallet_service.get_ledger_balance(session.user_id, session.date, session.wallet_ledger_id)
        return order_service.compute_funds_ratio_quantity(
            symbol=session.symbol, price=price, session_capital=session.session_capital,
            funds_ratio_pct=funds_ratio_pct, current_wallet=current_wallet,
            lot_size=lot_size, margin_rate=_margin_rate_for(session, right),
        )
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/buy")
async def buy(req: TradeRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    from app.services.guardrail_service import check_guardrails
    blocked, reason = check_guardrails(session)
    if blocked:
        raise HTTPException(status_code=403, detail=f"GUARDRAIL:{reason}")

    right = _resolve_right(session, req.right)
    price = _get_price_for_right(session, right)
    if price <= 0.0:
        raise HTTPException(status_code=400, detail="No valid price available yet")

    quantity = _direct_trade_quantity(session, right, price, req.funds_ratio_pct)

    if session.session_type == "real":
        from app.services.guardrail_service import check_maxsize
        blocked, reason = check_maxsize(session, price, quantity, "BUY", right=right, strike=_strike_for_right(session, right), expiry=session.expiry)
        if blocked:
            raise HTTPException(status_code=403, detail=reason)
        return _place_kotak_direct(session, TradeSide.BUY, price, quantity, right, req.funds_ratio_pct)

    from app.services.guardrail_service import check_maxsize
    blocked, reason = check_maxsize(session, price, quantity, "BUY", right=right, strike=_strike_for_right(session, right), expiry=session.expiry)
    if blocked:
        raise HTTPException(status_code=403, detail=reason)

    timestamp = int(session.current_time)
    try:
        trading_svc.settle_wallet_for_trade(
            session,
            TradeSide.BUY,
            price,
            quantity,
            right=right,
            strike=_strike_for_right(session, right),
            expiry=session.expiry,
        )
        trade = trading_svc.record_trade(
            req.session_id, TradeSide.BUY, price=price, timestamp=timestamp,
            analytics=snapshot(session, quantity=quantity, price=price, side="BUY", capital_fraction=req.funds_ratio_pct, margin_rate=_margin_rate_for(session, right), entry_method="MARKET", exit_method="MARKET"),
            symbol=session.symbol,
            instrument_type=session.instrument_type,
            strike=_strike_for_right(session, right),
            expiry=session.expiry,
            right=right,
            quantity=quantity,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
        )
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc))
    _emit_trade_event(session, trade)
    return trade


@router.post("/sell")
async def sell(req: TradeRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    from app.services.guardrail_service import check_guardrails
    blocked, reason = check_guardrails(session)
    if blocked:
        raise HTTPException(status_code=403, detail=f"GUARDRAIL:{reason}")

    right = _resolve_right(session, req.right)
    price = _get_price_for_right(session, right)
    if price <= 0.0:
        raise HTTPException(status_code=400, detail="No valid price available yet")

    quantity = _direct_trade_quantity(session, right, price, req.funds_ratio_pct)

    if session.session_type == "real":
        from app.services.guardrail_service import check_maxsize
        blocked, reason = check_maxsize(session, price, quantity, "SELL", right=right, strike=_strike_for_right(session, right), expiry=session.expiry)
        if blocked:
            raise HTTPException(status_code=403, detail=reason)
        return _place_kotak_direct(session, TradeSide.SELL, price, quantity, right, req.funds_ratio_pct)

    from app.services.guardrail_service import check_maxsize
    blocked, reason = check_maxsize(session, price, quantity, "SELL", right=right, strike=_strike_for_right(session, right), expiry=session.expiry)
    if blocked:
        raise HTTPException(status_code=403, detail=reason)

    timestamp = int(session.current_time)
    try:
        trading_svc.settle_wallet_for_trade(
            session,
            TradeSide.SELL,
            price,
            quantity,
            right=right,
            strike=_strike_for_right(session, right),
            expiry=session.expiry,
        )
        trade = trading_svc.record_trade(
            req.session_id, TradeSide.SELL, price=price, timestamp=timestamp,
            analytics=snapshot(session, quantity=quantity, price=price, side="SELL", capital_fraction=req.funds_ratio_pct, margin_rate=_margin_rate_for(session, right), entry_method="MARKET", exit_method="MARKET"),
            symbol=session.symbol,
            instrument_type=session.instrument_type,
            strike=_strike_for_right(session, right),
            expiry=session.expiry,
            right=right,
            quantity=quantity,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
        )
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc))
    _emit_trade_event(session, trade)
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


@router.get("/open-option-contracts")
async def get_open_option_contracts(
    session_id: str = Query(...), user_id: str = Depends(get_request_user_id),
):
    """Open website paper positions, keyed by their actual option contract."""
    session = sim_svc.get_session(session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.session_type != "paper" or session.instrument_type != "options" or getattr(session, "desktop_origin", None) == "desktop_paper":
        return []
    return trading_svc.get_open_option_contracts(session_id, session.symbol)


@router.get("/position-snapshot")
async def position_snapshot(session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    session = sim_svc.get_session(session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.session_type != "real":
        raise HTTPException(status_code=400, detail="Only real sessions have a broker position snapshot")
    from app.services.real_broker_state import STATE_GENERATION
    return {"session_id": session_id, "positions": getattr(session, "broker_positions", None) or [],
            "trades": [trade.model_dump(mode="json") for trade in trading_svc.get_trades(session_id)],
            "application_orders": [order.model_dump(mode="json") for order in order_service.get_open_orders(session_id)],
            "state_generation": STATE_GENERATION, "state_version": getattr(session, "_broker_state_version", 0),
            "calculation_verified": getattr(session, "_fifo_executions", None) is not None}


@router.get("/position", response_model=Position)
async def get_position(session_id: str = Query(...), right: str | None = Query(default=None),
                       strike: int | None = Query(default=None), expiry: str | None = Query(default=None)):
    session = sim_svc.get_session(session_id)
    symbol = session.symbol if session else None
    # Resolve effective right: explicit param > session.right (Sprint 3 compat)
    effective_right = right if right is not None else (session.right if session else None)
    return trading_svc.get_position(session_id, symbol=symbol, right=effective_right,
                                    strike=strike, expiry=expiry, exact_contract=strike is not None and expiry is not None)


@router.post('/sessions/{session_id}/exit-all', status_code=202)
async def exit_all_now(session_id: str, user_id: str = Depends(get_request_user_id)):
    session = sim_svc.get_session(session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(404, 'Session not found')
    from app.services.emergency_exit import exit_all
    return await exit_all(session)


@router.get('/real-day-status')
async def real_day_status(user_id: str = Depends(get_request_user_id)):
    from app.services import real_trading_day
    status = await asyncio.to_thread(real_trading_day.state, user_id)
    if status['state'] == 'closing':
        real_trading_day.monitor(user_id)
    return status


@router.post('/sessions/{session_id}/done-for-day', status_code=202)
async def done_for_day(session_id: str, user_id: str = Depends(get_request_user_id)):
    session = sim_svc.get_session(session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(404, 'Session not found')
    if session.session_type != 'real':
        raise HTTPException(400, 'Done for day applies only to real trading')
    from app.services.real_trading_day import done_for_day as finish_day
    return await finish_day(user_id)
