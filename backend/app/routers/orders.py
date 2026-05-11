from fastapi import APIRouter, HTTPException, Query
from app.models.schemas import Order, OrderType, PlaceOrderRequest
from app.services import order_service, simulation as sim_svc
from app.services.wallet_service import InsufficientFundsError

router = APIRouter(prefix="/api/orders", tags=["orders"])


@router.post("", response_model=Order)
async def place_order(req: PlaceOrderRequest):
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.current_time is None:
        raise HTTPException(status_code=400, detail="Simulation has not started yet")
    if req.quantity < 1:
        raise HTTPException(status_code=400, detail="quantity must be at least 1")

    if req.order_type == OrderType.TARGET:
        if not req.trigger_price or req.trigger_price <= 0:
            raise HTTPException(status_code=400, detail="trigger_price is required and must be positive for TARGET orders")
    else:  # LIMIT
        if not req.limit_price or req.limit_price <= 0:
            raise HTTPException(status_code=400, detail="limit_price is required and must be positive for LIMIT orders")

    try:
        order = order_service.place_order(
            session_id=req.session_id,
            symbol=session.symbol,
            side=req.side,
            order_type=req.order_type,
            quantity=req.quantity,
            created_at=int(session.current_time),
            trading_date=session.date,
            trigger_price=req.trigger_price,
            limit_price=req.limit_price,
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
