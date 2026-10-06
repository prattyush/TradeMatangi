"""Read-only, user-owned performance reports. Heavy work leaves the event loop."""

import asyncio
from datetime import date
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from app.dependencies import get_request_user_id
from app.services import performance_service as svc

router = APIRouter(prefix="/api/analysis/performance", tags=["performance"])


def filters(
    start_date: date | None = None,
    end_date: date | None = None,
    symbol: str | None = None,
    session_type: Literal["sim", "paper", "stepwise", "real"] | None = None,
    instrument_type: Literal["equity", "options"] | None = None,
    client: Literal["website", "desktop"] | None = None,
    direction: Literal["LONG", "SHORT"] | None = None,
    entry_method: str | None = None,
    exit_method: str | None = None,
    sizing_method: str | None = None,
    requested_pct: float | None = Query(None, ge=0, le=100),
    entry_tag: str | None = None,
    exit_tag: str | None = None,
    expected_strategy: str | None = None,
    actual_strategy: str | None = None,
    data_quality: Literal["known", "executions"] | None = None,
):
    if start_date and end_date and start_date > end_date:
        raise HTTPException(422, "Start date must not follow end date")
    return dict(
        start_date=start_date.isoformat() if start_date else None,
        end_date=end_date.isoformat() if end_date else None,
        symbol=symbol,
        session_type=session_type,
        instrument_type=instrument_type,
        client=client,
        direction=direction,
        entry_method=entry_method,
        exit_method=exit_method,
        sizing_method=sizing_method,
        requested_pct=requested_pct,
        entry_tag=entry_tag,
        exit_tag=exit_tag,
        expected_strategy=expected_strategy,
        actual_strategy=actual_strategy,
        data_quality=data_quality,
    )


async def read(user_id, criteria):
    try:
        return await asyncio.to_thread(svc.load_cycles, user_id, **criteria)
    except Exception as exc:
        import logging

        logging.getLogger(__name__).exception("Performance read failed")
        raise HTTPException(
            503, "Performance data could not be read; retry later"
        ) from exc


@router.get("")
async def performance(
    criteria: dict = Depends(filters), user_id: str = Depends(get_request_user_id)
):
    cycles = await read(user_id, criteria)
    return await asyncio.to_thread(svc.cached_report, cycles)


@router.get("/cycles")
async def cycles(
    criteria: dict = Depends(filters),
    user_id: str = Depends(get_request_user_id),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    rows = await read(user_id, criteria)
    page = rows[offset : offset + limit]
    return dict(
        items=page,
        total=len(rows),
        next_offset=offset + limit if offset + limit < len(rows) else None,
    )


@router.get("/cycles/{cycle_id}")
async def cycle_detail(
    cycle_id: str,
    session_id: str = Query(...),
    enrich: bool = False,
    user_id: str = Depends(get_request_user_id),
):
    def load():
        from app.services.db import get_dynamodb_resource

        session = (
            get_dynamodb_resource()
            .Table("Sessions")
            .get_item(Key={"session_id": session_id}, ConsistentRead=True)
            .get("Item")
        )
        if not session or session.get("user_id") != user_id:
            return None
        return next(
            (c for c in svc.load_session_cycles(session) if c["cycle_id"] == cycle_id),
            None,
        )

    try:
        item = await asyncio.to_thread(load)
        if item is None:
            raise HTTPException(404, "Trade cycle not found")
        if enrich:
            from app.services.excursion_service import enrich_cycle

            item = await asyncio.to_thread(enrich_cycle, item)
        return item
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            503, "Trade details could not be read; retry later"
        ) from exc
