"""Sprint 3 screen and drawing APIs; all records are scoped to the caller."""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.dependencies import get_desktop_user_id
from app.services import desktop_persistence_service as persistence

router = APIRouter(prefix="/api/desktop/v1", tags=["desktop"])
logger = logging.getLogger(__name__)


class ScreenWrite(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    state: dict
    revision: int | None = Field(default=None, ge=1)
    mutation_id: str | None = None
    order: int = Field(default=0, ge=0)
    active: bool = False


class DrawingWrite(BaseModel):
    instrument: dict
    drawing: dict
    revision: int | None = Field(default=None, ge=1)
    mutation_id: str | None = None


class ChartSettingsWrite(BaseModel):
    settings: dict


def _conflict(error: ValueError) -> None:
    if str(error) == "revision_conflict":
        raise HTTPException(status_code=409, detail="Record was changed by another screen; reload and reconcile")
    raise HTTPException(status_code=422, detail=str(error))


@router.get("/chart-settings")
async def chart_settings(user_id: str = Depends(get_desktop_user_id)):
    logger.info("desktop chart settings load requested user_id=%s", user_id)
    return persistence.get_chart_settings(user_id)


@router.put("/chart-settings")
async def save_chart_settings(req: ChartSettingsWrite, user_id: str = Depends(get_desktop_user_id)):
    logger.info("desktop chart settings save requested user_id=%s keys=%s", user_id, sorted(req.settings.keys()))
    return persistence.save_chart_settings(user_id, req.settings)


@router.get("/screens")
async def screens(user_id: str = Depends(get_desktop_user_id)):
    return {"version": 1, "screens": persistence.list_screens(user_id)}


@router.post("/screens", status_code=201)
async def create_screen(req: ScreenWrite, user_id: str = Depends(get_desktop_user_id)):
    return persistence.create_screen(user_id, req.name, req.state, req.mutation_id, req.order, req.active)


@router.put("/screens/{screen_id}")
async def update_screen(screen_id: str, req: ScreenWrite, user_id: str = Depends(get_desktop_user_id)):
    if req.revision is None or req.mutation_id is None:
        raise HTTPException(status_code=422, detail="revision and mutation_id are required for updates")
    try:
        record = persistence.update_screen(user_id, screen_id, req.name, req.state, req.revision, req.mutation_id, req.order, req.active)
    except ValueError as error:
        _conflict(error)
    if not record:
        raise HTTPException(status_code=404, detail="Screen was not found")
    return record


@router.delete("/screens/{screen_id}", status_code=204)
async def delete_screen(screen_id: str, user_id: str = Depends(get_desktop_user_id)):
    if not persistence.delete_screen(user_id, screen_id):
        raise HTTPException(status_code=404, detail="Screen was not found")


@router.get("/drawings")
async def drawings(instrument: str, user_id: str = Depends(get_desktop_user_id)):
    import json
    try:
        return {"version": 1, "drawings": persistence.list_drawings(user_id, json.loads(instrument))}
    except (ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail=str(error))


@router.post("/drawings", status_code=201)
async def create_drawing(req: DrawingWrite, user_id: str = Depends(get_desktop_user_id)):
    try:
        return persistence.create_drawing(user_id, req.instrument, req.drawing, req.mutation_id)
    except ValueError as error:
        _conflict(error)


@router.put("/drawings/{drawing_id}")
async def update_drawing(drawing_id: str, req: DrawingWrite, user_id: str = Depends(get_desktop_user_id)):
    if req.revision is None or req.mutation_id is None:
        raise HTTPException(status_code=422, detail="revision and mutation_id are required for updates")
    try:
        record = persistence.update_drawing(user_id, drawing_id, req.drawing, req.revision, req.mutation_id)
    except ValueError as error:
        _conflict(error)
    if not record:
        raise HTTPException(status_code=404, detail="Drawing was not found")
    return record


@router.delete("/drawings/{drawing_id}")
async def delete_drawing(drawing_id: str, req: DrawingWrite, user_id: str = Depends(get_desktop_user_id)):
    if req.revision is None or req.mutation_id is None:
        raise HTTPException(status_code=422, detail="revision and mutation_id are required for deletes")
    try:
        record = persistence.update_drawing(user_id, drawing_id, req.drawing, req.revision, req.mutation_id, deleted=True)
    except ValueError as error:
        _conflict(error)
    if not record:
        raise HTTPException(status_code=404, detail="Drawing was not found")
    return record
