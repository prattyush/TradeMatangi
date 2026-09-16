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


def get_desktop_user_id(
    authorization: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None),
) -> str:
    """Authenticate desktop API calls without silently granting the dev user.

    The explicit ``X-User-Id`` fallback keeps the existing web/auth transition
    compatible, but unlike legacy routes an omitted identity is always 401.
    """
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(status_code=401, detail="Invalid Authorization header")
        from app.services.desktop_auth_service import verify_access_token
        user_id = verify_access_token(token)
        if user_id:
            return user_id
        raise HTTPException(status_code=401, detail="Access token is invalid or expired")
    if x_user_id:
        return x_user_id
    raise HTTPException(status_code=401, detail="Authentication required")


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
