"""
Video links API — saved YouTube links for Trading Video Maker videos (Phase 24, Y3).

Prefix: /api/video-links

Owner only, for reads as well as writes. A link can point at a private video, so it is
not covered by the "share real trading history" read access that Analysis uses.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services import trade_label_service
from app.services import video_links_service as svc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/video-links", tags=["video-links"])


class LinkIn(BaseModel):
    session_id: str
    video_id: str
    title: str
    privacy: Literal["private", "unlisted", "public"]
    chapters: str = ""


class LinkOut(BaseModel):
    session_id: str
    video_id: str
    url: str
    title: str
    privacy: str
    chapters: str
    uploaded_at: str


class LinksResponse(BaseModel):
    links: list[LinkOut]


class DeleteResponse(BaseModel):
    deleted: bool


def _own_session(session_id: str, user_id: str) -> None:
    session = trade_label_service._load_session(session_id)
    if not session or session.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Session not found")


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc.args[0]) if exc.args else "Not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc.args[0]) if exc.args else str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Video links request failed")
        raise HTTPException(status_code=500, detail="Saved videos could not be read or saved; retry later") from exc


@router.get("", response_model=LinksResponse)
async def list_links(session_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    await asyncio.to_thread(_own_session, session_id, user_id)
    return {"links": await _run(svc.list_links, session_id)}


@router.post("", response_model=LinkOut)
async def save_link(req: LinkIn, user_id: str = Depends(get_request_user_id)):
    await asyncio.to_thread(_own_session, req.session_id, user_id)
    return await _run(svc.save_link, user_id, req.session_id, req.video_id, req.title, req.privacy, req.chapters)


@router.delete("", response_model=DeleteResponse)
async def delete_link(session_id: str = Query(...), video_id: str = Query(...), user_id: str = Depends(get_request_user_id)):
    await asyncio.to_thread(_own_session, session_id, user_id)
    await _run(svc.delete_link, session_id, video_id)
    return {"deleted": True}
