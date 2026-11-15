"""Games (Phase 25) API. Prefix /api/desktop/v1/games; every route is scoped to the caller.

G2 serves progress only (``/state``). The cache-only market-data routes arrive in G1. Nothing here
touches orders, sessions, brokers or market data.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from app.dependencies import get_desktop_user_id
from app.services import games_persistence_service as persistence
from app.services.games_rate_limit import TokenBucket

router = APIRouter(prefix="/api/desktop/v1/games", tags=["desktop-games"])
logger = logging.getLogger(__name__)

# Progress writes happen once per finished session, so these limits are generous.
_state_reads = TokenBucket(rate_per_second=2, burst=10)
_state_writes = TokenBucket(rate_per_second=2, burst=10)


def _limit(bucket: TokenBucket, user_id: str) -> None:
    if not bucket.allow(user_id):
        raise HTTPException(status_code=429, detail="Too many requests", headers={"Retry-After": str(max(1, round(bucket.retry_after(user_id))))})


@router.get("/state")
async def get_state(user_id: str = Depends(get_desktop_user_id)):
    _limit(_state_reads, user_id)
    return persistence.get_state(user_id)


@router.put("/state")
async def put_state(body: dict, user_id: str = Depends(get_desktop_user_id)):
    _limit(_state_writes, user_id)
    try:
        return persistence.put_state(user_id, body)
    except persistence.ValidationFailed as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except persistence.RevisionConflict as error:
        logger.info("games state revision conflict user_id=%s records=%s", user_id, sorted(error.current))
        return JSONResponse(status_code=409, content={"detail": "Records changed since they were read; re-read and re-apply", "current": error.current})
