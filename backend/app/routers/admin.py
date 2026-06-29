"""
Admin-only endpoints for broker token management, real-trading whitelist,
and live streaming source selection.
All routes return 403 when the requesting user does not have is_admin=True.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

from app.dependencies import get_request_user_id
from app.services import token_service
from app.services.user_service import get_user_info
from app.models.schemas import WhitelistAddRequest, WhitelistEntry

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _require_admin(user_id: str = Depends(get_request_user_id)) -> str:
    info = get_user_info(user_id)
    if not info or not info.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user_id


class TokensResponse(BaseModel):
    icici_session: str | None = None
    kite_access: str | None = None


class SetTokensRequest(BaseModel):
    icici_session: str | None = None
    kite_access: str | None = None


@router.get("/tokens", response_model=TokensResponse)
async def get_tokens(user_id: str = Depends(_require_admin)):
    """Return masked broker tokens (last 4 chars shown, rest redacted)."""
    masked = token_service.get_tokens_masked()
    return TokensResponse(
        icici_session=masked.get("icici_session"),
        kite_access=masked.get("kite_access"),
    )


@router.put("/tokens", response_model=TokensResponse)
async def set_tokens(req: SetTokensRequest, user_id: str = Depends(_require_admin)):
    """Set one or both broker tokens. Only provided (non-null) fields are updated."""
    if req.icici_session is not None:
        token_service.set_token("icici_session", req.icici_session)
    if req.kite_access is not None:
        token_service.set_token("kite_access", req.kite_access)
    masked = token_service.get_tokens_masked()
    return TokensResponse(
        icici_session=masked.get("icici_session"),
        kite_access=masked.get("kite_access"),
    )


# ── Real Trading Whitelist ─────────────────────────────────────────────────────

@router.get("/real-trading/whitelist", response_model=list[WhitelistEntry])
async def get_real_trading_whitelist(user_id: str = Depends(_require_admin)):
    """Return all emails whitelisted for real trading."""
    from app.services import real_trading_service
    items = real_trading_service.get_whitelist()
    return [WhitelistEntry(**item) for item in items]


@router.post("/real-trading/whitelist", response_model=WhitelistEntry, status_code=201)
async def add_real_trading_whitelist(
    req: WhitelistAddRequest,
    user_id: str = Depends(_require_admin),
):
    """Add an email to the real trading whitelist."""
    from app.services import real_trading_service
    email = req.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email address")
    item = real_trading_service.add_to_whitelist(email)
    return WhitelistEntry(**item)


@router.delete("/real-trading/whitelist/{email}", status_code=204)
async def remove_real_trading_whitelist(
    email: str,
    user_id: str = Depends(_require_admin),
):
    """Remove an email from the real trading whitelist."""
    from app.services import real_trading_service
    real_trading_service.remove_from_whitelist(email)
    return None


# ── Live streaming source ──────────────────────────────────────────────────────

class StreamSourceRequest(BaseModel):
    source: str  # "kite" | "kotak" | "breeze"


class StreamSourceResponse(BaseModel):
    source: str


@router.get("/stream-source", response_model=StreamSourceResponse)
async def get_stream_source(user_id: str = Depends(_require_admin)):
    """Return the current live streaming source for paper/real sessions."""
    from app.services import token_service
    src = token_service.get_token("live_stream_source") or "kite"
    logger.info("Admin %s: GET stream-source → %s", user_id, src)
    return StreamSourceResponse(source=src)


@router.put("/stream-source", response_model=StreamSourceResponse)
async def set_stream_source(req: StreamSourceRequest, user_id: str = Depends(_require_admin)):
    """
    Set the live streaming source for all future paper/real sessions.
    Allowed values: "kite", "kotak", "breeze".
    The new value takes effect immediately for newly started sessions;
    active sessions are unaffected.
    """
    if req.source not in ("kite", "kotak", "breeze"):
        raise HTTPException(status_code=400, detail="source must be 'kite', 'kotak', or 'breeze'")
    from app.services import token_service
    token_service.set_token("live_stream_source", req.source)
    logger.info("Admin %s: SET stream-source → %s", user_id, req.source)
    return StreamSourceResponse(source=req.source)
