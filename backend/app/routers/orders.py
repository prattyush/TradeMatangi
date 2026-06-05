import json
import logging
from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Order, OrderType, TradeSide, PlaceOrderRequest, UpdateOrderRequest, BulkUpdateSLRequest
from app.services import order_service, simulation as sim_svc
from app.services.wallet_service import InsufficientFundsError, get_balance
from app.config import LOT_SIZES, EQUITY_MIS_MARGIN_RATE

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.post("", response_model=Order)
async def place_order(req: PlaceOrderRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

    from app.services.guardrail_service import check_guardrails
    blocked, reason = check_guardrails(session)
    if blocked:
        raise HTTPException(status_code=403, detail=f"GUARDRAIL:{reason}")

    if req.order_type == OrderType.TARGET:
        if not req.trigger_price or req.trigger_price <= 0:
            raise HTTPException(status_code=400, detail="trigger_price is required and must be positive for TARGET orders")
    elif req.order_type == OrderType.STOPLOSS:
        if not req.trigger_price or req.trigger_price <= 0:
            raise HTTPException(status_code=400, detail="trigger_price is required and must be positive for STOPLOSS orders")
    else:  # LIMIT
        if not req.limit_price or req.limit_price <= 0:
            raise HTTPException(status_code=400, detail="limit_price is required and must be positive for LIMIT orders")

    # Resolve which options contract this order targets
    order_right: str | None = None
    order_strike: int | None = None
    if session.instrument_type == "options":
        order_right = req.right if req.right is not None else session.right
        if order_right is None:
            raise HTTPException(
                status_code=400,
                detail="right (CE or PE) is required when placing orders in a dual-stream options session",
            )
        order_strike = session.strike_ce if order_right == "CE" else session.strike_pe

    # Naked short margin check for options sessions
    if (
        session.instrument_type == "options"
        and req.side == TradeSide.SELL
        and not req.is_stoploss
        and req.order_type != OrderType.STOPLOSS
    ):
        from app.services.trading import get_position
        position = get_position(session.session_id, session.symbol, right=order_right)
        if position.side != "LONG":  # no open buy position — naked short
            from app.services.options_service import compute_short_margin, get_underlying_price_at
            current_ts = int(session.current_time) if session.current_time else 0
            underlying_price = get_underlying_price_at(session.symbol, session.date, current_ts)
            if underlying_price is None:
                underlying_price = session.last_price  # fallback
            margin = compute_short_margin(session.symbol, underlying_price)
            current_wallet = get_balance(session.user_id, session.date)
            if current_wallet < margin:
                raise HTTPException(
                    status_code=402,
                    detail=(
                        f"Insufficient funds for naked short margin. "
                        f"Required: ₹{margin:,.2f}, Available: ₹{current_wallet:,.2f}"
                    ),
                )

    # Resolve lot_size: 1 for equity; actual lot size for options
    lot_size = LOT_SIZES.get(session.symbol, 1) if session.instrument_type == "options" else 1

    # Resolve quantity: either from funds_ratio_pct (FundsRatio mode) or explicit quantity
    if req.funds_ratio_pct is not None:
        if req.funds_ratio_pct <= 0 or req.funds_ratio_pct > 1:
            raise HTTPException(status_code=400, detail="funds_ratio_pct must be between 0 and 1")
        # Price for quantity computation: trigger for TARGET/SL, limit for LIMIT
        ratio_price = req.trigger_price if req.order_type in (OrderType.TARGET, OrderType.STOPLOSS) else req.limit_price
        if ratio_price is None or ratio_price <= 0:
            raise HTTPException(status_code=400, detail="A valid price is required for FundsRatio quantity computation")
        try:
            current_wallet = get_balance(session.user_id, session.date)
            quantity = order_service.compute_funds_ratio_quantity(
                symbol=session.symbol,
                price=ratio_price,
                session_capital=session.session_capital,
                funds_ratio_pct=req.funds_ratio_pct,
                current_wallet=current_wallet,
                lot_size=lot_size,
            )
        except InsufficientFundsError as exc:
            raise HTTPException(status_code=402, detail=str(exc))
    else:
        if req.quantity is None or req.quantity < 1:
            raise HTTPException(status_code=400, detail="quantity must be at least 1")
        quantity = req.quantity

    # Real equity MIS: only 20% margin deducted from wallet for BUY orders.
    is_real_equity = session.session_type == "real" and session.instrument_type == "equity"
    order_margin_rate = EQUITY_MIS_MARGIN_RATE if is_real_equity else 1.0

    # Auto-split large options orders that exceed per-symbol max contracts limit.
    # qty_chunks[0] goes through the existing full code path below.
    # Any additional chunks are created afterwards using the same parameters.
    if session.instrument_type == "options" and req.is_stoploss:
        qty_chunks = order_service.split_quantity(session.symbol, quantity)
        quantity = qty_chunks[0]  # first chunk processed by existing code
    else:
        qty_chunks = [quantity]

    try:
        order = order_service.place_order(
            session_id=req.session_id,
            symbol=session.symbol,
            side=req.side,
            order_type=req.order_type,
            quantity=quantity,
            created_at=int(session.current_time),
            trading_date=session.date,
            trigger_price=req.trigger_price,
            limit_price=req.limit_price,
            is_stoploss=req.is_stoploss,
            right=order_right,
            strike=order_strike,
            target_deviation_pct=req.target_deviation_pct,
            user_id=session.user_id,
            margin_rate=order_margin_rate,
        )
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc))

    # For real sessions: SL orders go directly to Kotak as SL-M orders.
    # LIMIT/TARGET stay local and are forwarded to Kotak when triggered.
    if session.session_type == "real" and req.order_type == OrderType.STOPLOSS:
        import asyncio
        from app.services.kotak_service import get_service as get_kotak, KotakError
        from app.services.order_service import get_order
        from app.services import wallet_service
        from app.config import KOTAK_SLIPPAGE_PCT

        trigger = req.trigger_price  # already validated non-null above
        # SL-M: limit slightly worse than trigger to ensure fill
        if req.side == TradeSide.BUY:
            kotak_limit = round(trigger * (1 + KOTAK_SLIPPAGE_PCT), 2)
        else:
            kotak_limit = round(trigger * (1 - KOTAK_SLIPPAGE_PCT), 2)

        try:
            kotak_svc = get_kotak()
            if session.instrument_type == "options":
                kotak_order_id = kotak_svc.place_options_sl_order(
                    symbol=session.symbol,
                    right=order.right,
                    strike=order.strike if order.strike is not None else session.strike,
                    expiry=session.expiry,
                    side="B" if req.side == TradeSide.BUY else "S",
                    qty=quantity,
                    trigger_price=trigger,
                    limit_price=kotak_limit,
                )
            else:
                kotak_order_id = kotak_svc.place_sl_order(
                    symbol=session.symbol,
                    side="B" if req.side == TradeSide.BUY else "S",
                    qty=quantity,
                    trigger_price=trigger,
                    limit_price=kotak_limit,
                )
            order.kotak_order_id = kotak_order_id
            session.kotak_order_map[order.order_id] = kotak_order_id

            loop = asyncio.get_event_loop()

            def _make_sl_fill_cb(ord_id: str, sess):
                def on_fill(k_id: str, fill_side: str, fill_qty: int, fill_price: float):
                    from app.services.trading import record_trade
                    o = get_order(sess.session_id, ord_id)
                    if o is None:
                        return
                    if o.kotak_fill_confirmed:
                        return  # already recorded by a prior callback or reconcile call
                    o.kotak_fill_confirmed = True
                    o.status = order_service.OrderStatus.FILLED
                    o.filled_price = fill_price
                    o.filled_at = int(sess.current_time) if sess.current_time else 0
                    record_trade(
                        session_id=sess.session_id,
                        side=o.side,
                        price=fill_price,
                        timestamp=o.filled_at,
                        quantity=fill_qty,
                        symbol=o.symbol,
                        instrument_type=sess.instrument_type,
                        strike=o.strike if o.strike is not None else sess.strike,
                        expiry=sess.expiry,
                        right=o.right,
                        brokerage_per_order=sess.brokerage_per_order,
                        user_id=sess.user_id,
                        session_type=sess.session_type,
                    )
                    if o.side.value == "SELL":
                        wallet_service.credit(sess.user_id, round(fill_price * fill_qty, 2), sess.date)
                    evt = {
                        "type": "order_filled",
                        "order_id": ord_id,
                        "side": o.side.value,
                        "quantity": fill_qty,
                        "trigger_price": o.trigger_price,
                        "filled_price": fill_price,
                        "filled_at": o.filled_at,
                        "right": o.right,
                    }
                    try:
                        sess.queue.put_nowait(__import__("json").dumps(evt))
                    except Exception:
                        pass
                return on_fill

            kotak_svc.register_fill_callback(kotak_order_id, _make_sl_fill_cb(order.order_id, session), loop)

            def _make_sl_reject_cb(ord_id: str, sess):
                def on_reject(kotak_id: str, reason: str):
                    import logging as _log
                    import json as _json
                    from app.services.order_service import get_order, _write_order_to_db
                    from app.models.schemas import OrderStatus
                    o = get_order(sess.session_id, ord_id)
                    if o is None:
                        return
                    _log.getLogger(__name__).warning(
                        "Kotak rejected SL order %s for session %s: %s",
                        ord_id, sess.session_id, reason,
                    )
                    o.status = OrderStatus.CANCELLED
                    _write_order_to_db(o)
                    cancel_event = {"type": "order_cancelled", "order_id": ord_id}
                    error_event = {"type": "broker_error", "message": f"Kotak rejected SL order: {reason}"}
                    for evt in (cancel_event, error_event):
                        try:
                            sess.queue.put_nowait(_json.dumps(evt))
                        except Exception:
                            pass
                return on_reject

            kotak_svc.register_reject_callback(kotak_order_id, _make_sl_reject_cb(order.order_id, session), loop)
            order_service._write_order_to_db(order)
        except KotakError as exc:
            # Roll back the local order placement on Kotak failure
            order.status = order_service.OrderStatus.CANCELLED
            order_service._write_order_to_db(order)
            raise HTTPException(status_code=502, detail=f"Kotak SL order failed: {exc}")

    try:
        session.queue.put_nowait(json.dumps({
            "type": "order_placed",
            "order_id": order.order_id,
            "session_id": order.session_id,
            "user_id": order.user_id,
            "symbol": order.symbol,
            "side": order.side.value,
            "order_type": order.order_type.value,
            "quantity": order.quantity,
            "trigger_price": order.trigger_price,
            "limit_price": order.limit_price,
            "status": order.status.value,
            "created_at": order.created_at,
            "filled_at": order.filled_at,
            "filled_price": order.filled_price,
            "is_stoploss": order.is_stoploss,
            "right": order.right,
            "strike": order.strike,
        }))
    except Exception:
        pass

    # Place additional split orders (chunks 2..N) for large options SL orders
    if len(qty_chunks) > 1:
        import asyncio as _asyncio
        _loop = _asyncio.get_event_loop()
        for extra_qty in qty_chunks[1:]:
            try:
                extra_order = order_service.place_order(
                    session_id=req.session_id,
                    symbol=session.symbol,
                    side=req.side,
                    order_type=req.order_type,
                    quantity=extra_qty,
                    created_at=int(session.current_time),
                    trading_date=session.date,
                    trigger_price=req.trigger_price,
                    is_stoploss=req.is_stoploss,
                    right=order_right,
                    strike=order_strike,
                    user_id=session.user_id,
                    margin_rate=order_margin_rate,
                )
                if session.session_type == "real" and req.order_type == OrderType.STOPLOSS:
                    from app.services.simulation import _register_kotak_sl_for_order
                    _register_kotak_sl_for_order(session, extra_order, _loop)
                try:
                    session.queue.put_nowait(json.dumps({
                        "type": "order_placed",
                        "order_id": extra_order.order_id,
                        "session_id": extra_order.session_id,
                        "user_id": extra_order.user_id,
                        "symbol": extra_order.symbol,
                        "side": extra_order.side.value,
                        "order_type": extra_order.order_type.value,
                        "quantity": extra_order.quantity,
                        "trigger_price": extra_order.trigger_price,
                        "limit_price": extra_order.limit_price,
                        "status": extra_order.status.value,
                        "created_at": extra_order.created_at,
                        "filled_at": extra_order.filled_at,
                        "filled_price": extra_order.filled_price,
                        "is_stoploss": extra_order.is_stoploss,
                        "right": extra_order.right,
                        "strike": extra_order.strike,
                    }))
                except Exception:
                    pass
            except Exception as exc:
                logger.warning("Auto-split SL order (qty=%d) failed: %s", extra_qty, exc)

    return order


@router.get("", response_model=list[Order])
async def get_orders(session_id: str = Query(...), open_only: bool = Query(default=True)):
    if open_only:
        return order_service.get_open_orders(session_id)
    return order_service.get_all_orders(session_id)


@router.delete("/{order_id}", response_model=Order)
async def cancel_order(order_id: str, session_id: str = Query(...)):
    session = sim_svc.get_session(session_id)
    trading_date = session.date if session else ""
    order = order_service.cancel_order(session_id, order_id, trading_date)
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found or already closed")
    # Cancel the Kotak-side order if this was placed directly on Kotak
    if order.kotak_order_id:
        try:
            from app.services.kotak_service import get_service as get_kotak, KotakError
            get_kotak().cancel_order(order.kotak_order_id)
            get_kotak().deregister_fill_callback(order.kotak_order_id)
        except Exception:
            pass  # best-effort; local cancel already recorded
    return order


@router.patch("/bulk-update-sl")
async def bulk_update_sl_route(req: BulkUpdateSLRequest):
    """
    Set all pending SL orders for a session's symbol/right to the same trigger price.
    Handles Kotak real-trading orders too.
    """
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if req.trigger_price <= 0:
        raise HTTPException(status_code=400, detail="trigger_price must be positive")

    right = req.right.upper() if req.right else None
    open_orders = order_service.get_open_orders(req.session_id)
    sl_orders = [o for o in open_orders if o.is_stoploss and (o.right or None) == right]

    if not sl_orders:
        return {"updated": 0}

    updated = 0
    for order in sl_orders:
        order_service.update_order(
            session_id=req.session_id,
            order_id=order.order_id,
            trading_date=session.date,
            trigger_price=req.trigger_price,
        )
        updated += 1

        # Forward to Kotak for real sessions
        if session.session_type == "real" and getattr(order, "kotak_order_id", None):
            try:
                from app.services.kotak_service import get_service as get_kotak
                from app.config import KOTAK_SLIPPAGE_PCT
                if order.side == TradeSide.BUY:
                    kotak_limit = round(req.trigger_price * (1 + KOTAK_SLIPPAGE_PCT), 2)
                else:
                    kotak_limit = round(req.trigger_price * (1 - KOTAK_SLIPPAGE_PCT), 2)
                get_kotak().modify_sl_order(order.kotak_order_id, req.trigger_price, kotak_limit, order.quantity)
            except Exception as exc:
                logger.warning(
                    "bulk_update_sl: failed to update Kotak SL %s: %s",
                    order.kotak_order_id, exc,
                )

    return {"updated": updated}


@router.patch("/{order_id}", response_model=Order)
async def update_order(order_id: str, req: UpdateOrderRequest, session_id: str = Query(...)):
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if req.trigger_price is None and req.limit_price is None:
        raise HTTPException(status_code=400, detail="Provide trigger_price or limit_price to update")
    order = order_service.update_order(
        session_id=session_id,
        order_id=order_id,
        trading_date=session.date,
        trigger_price=req.trigger_price,
        limit_price=req.limit_price,
        target_deviation_pct=req.target_deviation_pct,
    )
    if order is None:
        raise HTTPException(status_code=404, detail="Order not found or not pending")

    # For real sessions: STOPLOSS orders are placed directly on Kotak as SL orders.
    # Forward price changes to Kotak so the broker-side order stays in sync.
    # TARGET orders are held locally until triggered, so no Kotak call is needed.
    if (
        session.session_type == "real"
        and order.kotak_order_id
        and order.order_type == OrderType.STOPLOSS
    ):
        try:
            from app.services.kotak_service import get_service as get_kotak, KotakError
            from app.config import KOTAK_SLIPPAGE_PCT
            import logging as _log
            new_trigger = order.trigger_price
            if order.side == TradeSide.BUY:
                kotak_limit = round(new_trigger * (1 + KOTAK_SLIPPAGE_PCT), 2)
            else:
                kotak_limit = round(new_trigger * (1 - KOTAK_SLIPPAGE_PCT), 2)
            get_kotak().modify_sl_order(order.kotak_order_id, new_trigger, kotak_limit, order.quantity)
        except Exception as exc:
            logger.warning(
                "Failed to forward SL price change to Kotak (order %s kotak_id %s): %s",
                order_id, order.kotak_order_id, exc,
            )

    return order
