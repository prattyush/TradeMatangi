"""
FastAPI shared dependencies.
"""
from fastapi import Header, HTTPException, Depends
from app.config import FIXED_USER_ID


def get_request_user_id(x_user_id: str = Header(default=FIXED_USER_ID)) -> str:
    """
    Read the logged-in user's ID from the X-User-Id request header.
    Falls back to FIXED_USER_ID when the header is absent (tests, dev without auth).
    """
    return x_user_id or FIXED_USER_ID


def require_real_trading_access(user_id: str = Depends(get_request_user_id)) -> str:
    """
    Dependency: raises 403 if the user is not in the RealTradingWhitelist table.
    Admin users are always allowed (they have is_admin=True on their user record).
    """
    from app.services.user_service import get_user_info
    from app.services import real_trading_service
    info = get_user_info(user_id)
    if info and info.get("is_admin"):
        return user_id
    if real_trading_service.is_whitelisted_user(user_id):
        return user_id
    raise HTTPException(
        status_code=403,
        detail="Real trading access is not enabled for this account. Contact admin.",
    )
