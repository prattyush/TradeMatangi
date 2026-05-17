"""
Admin-only endpoints for broker token management.
All routes return 403 when the requesting user does not have is_admin=True.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services import token_service
from app.services.user_service import get_user_info

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
