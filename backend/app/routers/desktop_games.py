"""Games (Phase 25) API. Prefix /api/desktop/v1/games; every route is scoped to the caller.

``/state`` (G2) keeps progress; ``/availability`` and ``/window`` (G1) serve cached second-level data and nothing
else. Nothing here touches orders, sessions or brokers, and a data miss is a 404, never a download.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response

from app.dependencies import get_desktop_user_id
from app.services import games_data_service as data
from app.services import games_persistence_service as persistence
from app.services.games_rate_limit import TokenBucket

router = APIRouter(prefix="/api/desktop/v1/games", tags=["desktop-games"])
logger = logging.getLogger(__name__)

# Progress writes happen once per finished session, so these limits are generous.
_state_reads = TokenBucket(rate_per_second=2, burst=10)
_state_writes = TokenBucket(rate_per_second=2, burst=10)
# Availability is read once per launch. Windows follow the client's prefetch pace (one request in flight, 250 ms apart).
_availability_reads = TokenBucket(rate_per_second=1, burst=5)
_window_reads = TokenBucket(rate_per_second=4, burst=10)


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


def _json(request: Request, payload: dict, status_code: int = 200) -> Response:
    body, headers = data.encode_json(payload, request.headers.get("accept-encoding", ""))
    return Response(content=body, status_code=status_code, media_type="application/json", headers=headers)


# The two data routes are plain ``def`` so FastAPI runs them in its thread pool: reading a parquet file must not
# block the event loop that also serves live trading streams.
@router.get("/availability")
def get_availability(request: Request, user_id: str = Depends(get_desktop_user_id)):
    _limit(_availability_reads, user_id)
    return _json(request, data.availability())


@router.get("/window")
def get_window(
    request: Request,
    symbol: str,
    date: str,
    start_sec: int = Query(..., ge=0, lt=data.DAY_SECONDS),
    duration_sec: int = Query(..., ge=1, le=data.DAY_SECONDS),
    interval_seconds: int = 1,
    expiry: str | None = None,
    strike: float | None = None,
    right: str | None = None,
    user_id: str = Depends(get_desktop_user_id),
):
    _limit(_window_reads, user_id)
    try:
        payload = data.get_window(symbol, date, start_sec, duration_sec, interval_seconds, expiry=expiry, strike=strike, right=right)
    except data.InvalidWindow as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except data.NotCached:
        return JSONResponse(status_code=404, content={"reason": "not_cached"})
    return _json(request, payload)
