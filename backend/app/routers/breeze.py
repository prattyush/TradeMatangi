"""
ICICI Direct (Breeze) broker endpoints.
Provides status checks for Breeze credentials/connectivity.
"""
import logging
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services.broker_service import _get_breeze, BreezeTokenError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/breeze", tags=["breeze"])


class BreezeStatusResponse(BaseModel):
    authenticated: bool
    broker: str = "ICICIDirect"


@router.get("/status", response_model=BreezeStatusResponse)
async def breeze_status(user_id: str = Depends(get_request_user_id)):
    """Return whether Breeze (ICICI Direct) credentials are valid and connected."""
    try:
        _get_breeze()  # validates session token; raises BreezeTokenError if bad
        return BreezeStatusResponse(authenticated=True)
    except BreezeTokenError as exc:
        logger.warning("Breeze status check failed for user %s: %s", user_id, exc)
        return BreezeStatusResponse(authenticated=False)
    except Exception as exc:
        logger.warning("Breeze status check error for user %s: %s", user_id, exc)
        return BreezeStatusResponse(authenticated=False)
