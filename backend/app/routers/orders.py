from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Order, OrderType, TradeSide, PlaceOrderRequest, UpdateOrderRequest
from app.services import order_service, simulation as sim_svc
from app.services.wallet_service import InsufficientFundsError, get_balance
from app.config import FIXED_USER_ID, LOT_SIZES

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
    if session.instrument_type == "options":
        order_right = req.right if req.right is not None else session.right
        if order_right is None:
            raise HTTPException(
                status_code=400,
                detail="right (CE or PE) is required when placing orders in a dual-stream options session",
            )

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
            current_wallet = get_balance(FIXED_USER_ID, session.date)
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
            current_wallet = get_balance(FIXED_USER_ID, session.date)
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
            target_deviation_pct=req.target_deviation_pct,
        )
    except InsufficientFundsError as exc:
        raise HTTPException(status_code=402, detail=str(exc))
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
