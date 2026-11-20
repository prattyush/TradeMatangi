"""
Day notes API — improvement notes and carried-over TODOs of a trading day (Phase 27, S5).

Prefix: /api/day-notes

Owner only, for reads as well as writes: the notes are the trader's own words, so they are not covered by the "share real trading
history" read access that Analysis uses. Nothing here touches a session, a trade, an order or a label.

Every path is exact (no path parameters) and every write is a POST or a DELETE with the id in the body or the query, so the desktop
native command, which supports only GET, POST and DELETE on a fixed list of paths, can carry all of it.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.dependencies import get_request_user_id
from app.services import day_notes_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/day-notes", tags=["day-notes"])


class NoteIn(BaseModel):
    date: str
    went_well: str = Field(default="", max_length=svc.NOTE_MAX_CHARS)
    to_improve: str = Field(default="", max_length=svc.NOTE_MAX_CHARS)
    specific_points: str = Field(default="", max_length=svc.NOTE_MAX_CHARS)
    context: str = Field(default="", max_length=svc.NOTE_MAX_CHARS)


class TodoIn(BaseModel):
    date: str
    text: str = Field(max_length=svc.TODO_MAX_CHARS * 2)


class StatusIn(BaseModel):
    todo_id: str
    date: str
    status: Literal["open", "working", "done", "improved"]


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("")
async def get_day(date: str = Query(...), user_id: str = Depends(get_request_user_id)):
    """The note of a market date and the TODOs that belong on it (carried ones first)."""
    return await _run(svc.day_view, user_id, date)


@router.post("")
async def save_note(body: NoteIn, user_id: str = Depends(get_request_user_id)):
    parts = body.model_dump()
    date = parts.pop("date")
    await _run(svc.save_note, user_id, date, parts)
    return await _run(svc.day_view, user_id, date)


@router.get("/todos")
async def list_todos(user_id: str = Depends(get_request_user_id)):
    """Every TODO with its status history, newest first (the review list)."""
    return {"todos": await _run(svc.list_todos, user_id)}


@router.post("/todos")
async def add_todo(body: TodoIn, user_id: str = Depends(get_request_user_id)):
    await _run(svc.add_todo, user_id, body.date, body.text)
    return await _run(svc.day_view, user_id, body.date)


@router.post("/todos/status")
async def set_status(body: StatusIn, user_id: str = Depends(get_request_user_id)):
    await _run(svc.set_status, user_id, body.todo_id, body.date, body.status)
    return await _run(svc.day_view, user_id, body.date)


@router.delete("/todos")
async def delete_todo(todo_id: str = Query(...), date: str = Query(...), user_id: str = Depends(get_request_user_id)):
    await _run(svc.delete_todo, user_id, todo_id)
    return await _run(svc.day_view, user_id, date)
