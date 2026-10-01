"""
Kotak Neo broker endpoints for real trading.

All endpoints require the user to be in the real-trading whitelist
(or be an admin).  The TOTP login must be called before starting a
real-trading session.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query

from app.dependencies import get_request_user_id, require_real_trading_access

logger = logging.getLogger(__name__)
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
    except Exception as e:

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
    """Replace today's scoped trading state with validated broker facts."""
    from app.services import simulation, real_broker_state
    session = simulation.get_session(session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.session_type != "real":
        raise HTTPException(status_code=400, detail="Only real sessions support reconciliation")
    try:
        return await real_broker_state.refresh(session, get_service())
    except (KotakError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except real_broker_state.SnapshotPersistenceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

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
    reason = "admin" if info and info.get("is_admin") else (
        "whitelisted" if has_access else "user_missing" if not info else "not_whitelisted")
    logger.debug("real_trading_access_check user_id=%s has_access=%s reason=%s", user_id, has_access, reason)
    return {"has_access": has_access}
