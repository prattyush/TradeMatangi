"""
Kotak Neo broker endpoints for real trading.

All endpoints require the user to be in the real-trading whitelist
(or be an admin).  The TOTP login must be called before starting a
real-trading session.
"""
from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_request_user_id, require_real_trading_access
from app.models.schemas import KotakLoginRequest, KotakStatusResponse, KotakFundsResponse
from app.services.kotak_service import get_service, KotakError

router = APIRouter(prefix="/api/kotak", tags=["kotak"])


@router.post("/login")
async def kotak_login(
    req: KotakLoginRequest,
    user_id: str = Depends(require_real_trading_access),
):
    """
    Authenticate with Kotak Neo using a TOTP.
    Must be called before starting a real trading session.
    Returns 502 with the exact Kotak error message on failure.
    """
    try:
        get_service().login_with_totp(req.totp)
        return {"status": "ok", "broker": "KotakNeo"}
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/status", response_model=KotakStatusResponse)
async def kotak_status(
    user_id: str = Depends(require_real_trading_access),
):
    """Return whether the Kotak client is currently authenticated."""
    return KotakStatusResponse(authenticated=get_service().is_authenticated())


@router.get("/funds", response_model=KotakFundsResponse)
async def kotak_funds(
    user_id: str = Depends(require_real_trading_access),
):
    """Return the available funds (Net balance) from Kotak."""
    try:
        balance = get_service().get_funds()
        return KotakFundsResponse(balance=balance)
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/order-history")
async def kotak_order_history(
    user_id: str = Depends(require_real_trading_access),
):
    """Return today's order history from Kotak."""
    try:
        orders = get_service().get_order_history()
        return {"orders": orders}
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/reconcile")
async def kotak_reconcile(
    session_id: str = Query(...),
    user_id: str = Depends(require_real_trading_access),
):
    """
    Reconcile fills from Kotak's order_report() against local pending orders.
    Called by the frontend refresh button to pick up fills that the order-feed
    WebSocket may have missed.  Returns the number of newly-recorded fills.
    """
    import asyncio
    import json as _json
    from app.services import simulation as sim_svc, order_service, wallet_service
    from app.services.trading import record_trade
    from app.models.schemas import OrderStatus

    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.session_type != "real":
        raise HTTPException(status_code=400, detail="Only real sessions support reconciliation")

    try:
        kotak_orders = get_service().get_order_history()
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    # Invert kotak_order_map (order_id → kotak_id) to find by kotak_id
    reverse_map: dict[str, str] = {v: k for k, v in session.kotak_order_map.items()}

    reconciled = 0
    for ko in kotak_orders:
        k_id = ko.get("kotak_order_id", "")
        if ko.get("status") not in ("complete", "filled"):
            continue

        order_id = reverse_map.get(k_id)
        if not order_id:
            continue

        o = order_service.get_order(session_id, order_id)
        if o is None or o.status != OrderStatus.PENDING:
            continue  # already processed or unknown

        avg_prc = ko.get("filled_price", 0.0)
        fill_qty = ko.get("filled_quantity") or ko.get("quantity", 0)
        if avg_prc <= 0 or fill_qty <= 0:
            continue

        fill_ts = int(session.current_time) if session.current_time else 0

        o.status = OrderStatus.FILLED
        o.filled_price = avg_prc
        o.filled_at = fill_ts

        record_trade(
            session_id=session_id,
            side=o.side,
            price=avg_prc,
            timestamp=fill_ts,
            quantity=fill_qty,
            symbol=o.symbol,
            instrument_type=session.instrument_type,
            strike=o.strike if o.strike is not None else session.strike,
            expiry=session.expiry,
            right=o.right,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
        )

        if o.side.value == "SELL":
            wallet_service.credit(session.user_id, round(avg_prc * fill_qty, 2), session.date)
        else:
            # BUY: reserved_amount was debited at placement; debit fill delta
            wallet_service.debit(session.user_id, round(avg_prc * fill_qty, 2), session.date)

        order_service._write_order_to_db(o)

        evt = {
            "type": "order_filled",
            "order_id": order_id,
            "side": o.side.value,
            "quantity": fill_qty,
            "trigger_price": o.trigger_price,
            "filled_price": avg_prc,
            "filled_at": fill_ts,
            "right": o.right,
        }
        try:
            session.queue.put_nowait(_json.dumps(evt))
        except Exception:
            pass

        logger.info(
            "Reconciled fill for order %s (kotak %s): side=%s qty=%d price=%.2f",
            order_id, k_id, o.side.value, fill_qty, avg_prc,
        )
        reconciled += 1

    # Collect currently open/pending Kotak orders for informational display
    open_kotak_orders = [
        ko for ko in kotak_orders
        if ko.get("status") in ("open", "trigger pending", "amo")
    ]
    return {"reconciled": reconciled, "open_orders": open_kotak_orders}


@router.get("/check-access")
async def check_real_trading_access(
    user_id: str = Depends(get_request_user_id),
):
    """
    Returns whether the current user has real trading access.
    Used by the frontend to decide whether to show the real trading option.
    Does NOT require whitelist access itself (so non-whitelisted users can
    call this safely to find out they don't have access).
    """
    from app.services.user_service import get_user_info
    from app.services import real_trading_service
    info = get_user_info(user_id)
    has_access = bool(
        (info and info.get("is_admin"))
        or real_trading_service.is_whitelisted_user(user_id)
    )
    return {"has_access": has_access}
