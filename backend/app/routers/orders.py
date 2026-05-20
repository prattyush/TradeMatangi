from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Order, OrderType, TradeSide, PlaceOrderRequest, UpdateOrderRequest
from app.services import order_service, simulation as sim_svc
from app.services.wallet_service import InsufficientFundsError, get_balance
from app.config import LOT_SIZES

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.post("", response_model=Order)
async def place_order(req: PlaceOrderRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")

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
            order_service._write_order_to_db(order)
        except KotakError as exc:
            # Roll back the local order placement on Kotak failure
            order.status = order_service.OrderStatus.CANCELLED
            order_service._write_order_to_db(order)
            raise HTTPException(status_code=502, detail=f"Kotak SL order failed: {exc}")

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
    return order
