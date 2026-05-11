from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Order, OrderType, PlaceOrderRequest
from app.services import order_service, simulation as sim_svc
from app.services.wallet_service import InsufficientFundsError, get_balance
from app.config import FIXED_USER_ID

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
                lot_size=1,  # equity in Sprint 2; Sprint 3 options will pass actual lot size
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
