"""
Deep Dive API — Patterns Strategy Deep Dive (Phase 26).

Prefix: /api/deep-dive

One deep dive is one category + strategy. The caller's own dives are editable; dives of an owner who shared
patterns with the caller are readable (``owner_id``) and never writable. Nothing here touches orders, sessions,
brokers or streams.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.dependencies import get_request_user_id
from app.routers.pattern_logger import AnnotationItem
from app.services import deep_dive_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/deep-dive", tags=["deep-dive"])

Side = Literal["buy", "sell"]


class DiveRef(BaseModel):
    category: str
    strategy: str


class SetupRef(DiveRef):
    symbol: str
    date: str
    side: Side


class SetupIn(SetupRef):
    """Only the fields the client sends change; ``outcome`` / strikes sent as null are cleared."""
    strike_ce: Optional[int] = None
    strike_pe: Optional[int] = None
    strike_mode: Optional[Literal["max_price", "otm", "manual"]] = None
    interval_minutes: Optional[int] = None
    annotations: Optional[list[AnnotationItem]] = None
    outcome: Optional[Literal["success", "failed"]] = None
    strength: Optional[Literal["ideal", "average", "poor"]] = None  # only with a success; grading a day makes it a success
    notes: Optional[str] = None


class TagValuesIn(SetupRef):
    tag_values: dict[str, Optional[bool]] = Field(max_length=100)  # true valid, false not valid, null unmarked


class TagIn(DiveRef):
    name: str


class TagRef(DiveRef):
    pass


class TagUpdateIn(DiveRef):
    name: str


def _bad_request(exc: Exception) -> HTTPException:
    status = 404 if isinstance(exc, LookupError) else 400
    return HTTPException(status_code=status, detail=str(exc.args[0]) if exc.args else str(exc))


async def _run(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except (ValueError, LookupError) as exc:
        raise _bad_request(exc) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc.args[0]) if exc.args else str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("deep dive %s failed", getattr(fn, "__name__", "call"))
        raise HTTPException(status_code=500, detail="Deep dive request failed") from exc


# ── Reads ────────────────────────────────────────────────────────────────────

@router.get("/dives")
async def list_dives(user_id: str = Depends(get_request_user_id)):
    return {"dives": await _run(svc.list_dives, user_id)}


@router.get("/dive")
async def get_dive(category: str = Query(...), strategy: str = Query(...), owner_id: Optional[str] = Query(None),
                   user_id: str = Depends(get_request_user_id)):
    return await _run(svc.get_dive, user_id, category, strategy, owner_id)


@router.get("/stats")
async def get_stats(category: str = Query(...), strategy: str = Query(...), side: Optional[Side] = Query(None),
                    owner_id: Optional[str] = Query(None), user_id: str = Depends(get_request_user_id)):
    return await _run(svc.stats, user_id, category, strategy, side, owner_id)


@router.get("/timings")
async def get_timings(category: Optional[str] = Query(None), strategy: Optional[str] = Query(None), side: Optional[Side] = Query(None),
                      owner_id: Optional[str] = Query(None), user_id: str = Depends(get_request_user_id)):
    """The entry and exit time of every marked day, read from its chart marks (all deep dives unless one is named)."""
    return {"days": await _run(svc.list_timings, user_id, category, strategy, side, owner_id)}


# ── Strategy Practice ────────────────────────────────────────────────────────

class PracticeDayRef(BaseModel):
    date: str
    symbol: str


class PracticePickIn(DiveRef):
    symbol: Optional[str] = None
    grades: Optional[list[Literal["ideal", "average", "poor", "ungraded", "failed", "open"]]] = None
    include_negatives: bool = False  # also offer days the strategy was absent (about 1 pick in 4)
    exclude: Optional[list[PracticeDayRef]] = Field(default=None, max_length=100)  # days that could not be started: not offered again


@router.get("/practice/strategies")
async def practice_strategies(user_id: str = Depends(get_request_user_id)):
    """The strategies of the user's own deep dives that have Entry-marked days to practise."""
    from app.services import strategy_practice_service as practice
    return {"strategies": await _run(practice.list_strategies, user_id)}


@router.post("/practice/pick")
async def practice_pick(req: PracticePickIn, user_id: str = Depends(get_request_user_id)):
    """Choose a day and a replay start (a few minutes before the first Entry). Never the side or the marks."""
    from app.services import strategy_practice_service as practice
    return await _run(practice.pick, user_id, req.category, req.strategy, req.symbol, req.grades, None, req.include_negatives,
                      {(d.date, d.symbol) for d in req.exclude or []})


@router.get("/practice/runs")
async def practice_runs(user_id: str = Depends(get_request_user_id)):
    from app.services import strategy_practice_service as practice
    return {"runs": await _run(practice.list_runs, user_id)}


@router.get("/practice/evaluate")
async def practice_evaluate(session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    """The review of an ended practice run (409 while the session still runs)."""
    from app.services import strategy_practice_service as practice
    return await _run(practice.evaluate, user_id, session_id)


@router.get("/stats/all")
async def get_stats_all(user_id: str = Depends(get_request_user_id)):
    return {"dives": await _run(svc.stats_all, user_id)}


# ── Marked days ──────────────────────────────────────────────────────────────

@router.put("/setup")
async def put_setup(req: SetupIn, user_id: str = Depends(get_request_user_id)):
    fields = req.model_dump(exclude_unset=True, exclude={"category", "strategy", "symbol", "date", "side"})
    return await _run(svc.upsert_setup, user_id, req.category, req.strategy, req.symbol, req.date, req.side, fields)


@router.delete("/setup")
async def delete_setup(category: str = Query(...), strategy: str = Query(...), symbol: str = Query(...),
                       date: str = Query(...), side: Side = Query(...), user_id: str = Depends(get_request_user_id)):
    deleted = await _run(svc.delete_setup, user_id, category, strategy, symbol, date, side)
    return {"status": "deleted" if deleted else "not_found"}


@router.put("/setup/tag-values")
async def put_tag_values(req: TagValuesIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.set_tag_values, user_id, req.category, req.strategy, req.symbol, req.date, req.side, req.tag_values)


@router.post("/setup/save-to-patterns")
async def save_to_patterns(req: SetupRef, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.save_to_patterns, user_id, req.category, req.strategy, req.symbol, req.date, req.side)


# ── Tags ────────────────────────────────────────────────────────────────

@router.post("/tags")
async def add_tag(req: TagIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.add_tag, user_id, req.category, req.strategy, req.name)


@router.post("/tags/{tag_id}/update")
async def update_tag(tag_id: str, req: TagUpdateIn, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.update_tag, user_id, req.category, req.strategy, tag_id, req.name)


@router.post("/tags/{tag_id}/archive")
async def archive_tag(tag_id: str, req: TagRef, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.archive_tag, user_id, req.category, req.strategy, tag_id)


@router.post("/tags/{tag_id}/restore")
async def restore_tag(tag_id: str, req: TagRef, user_id: str = Depends(get_request_user_id)):
    return await _run(svc.restore_tag, user_id, req.category, req.strategy, tag_id)
