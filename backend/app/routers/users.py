from fastapi import APIRouter, Depends, HTTPException
from app.models.schemas import UserSettingsResponse, UserSettingsUpdateRequest
from app.services import user_settings_service
from app.dependencies import get_request_user_id

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/settings", response_model=UserSettingsResponse)
async def get_user_settings(user_id: str = Depends(get_request_user_id)):
    settings = user_settings_service.get_settings(user_id, strict=True)
    return UserSettingsResponse(**settings)


@router.put("/settings", response_model=UserSettingsResponse)
async def update_user_settings(
    req: UserSettingsUpdateRequest,
    user_id: str = Depends(get_request_user_id),
):
    try:
        updated = user_settings_service.update_settings(user_id, req.model_dump(exclude_none=True))
        return UserSettingsResponse(**updated)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.put("/settings/target-gap-migration", response_model=UserSettingsResponse)
async def migrate_target_gap(req: UserSettingsUpdateRequest, user_id: str = Depends(get_request_user_id)):
    if req.target_deviation_pct is None:
        raise HTTPException(status_code=400, detail="target_deviation_pct is required")
    return UserSettingsResponse(**user_settings_service.migrate_target_gap(user_id, req.target_deviation_pct))


@router.put("/settings/browser-migration", response_model=UserSettingsResponse)
async def migrate_browser_settings(req: UserSettingsUpdateRequest, user_id: str = Depends(get_request_user_id)):
    return UserSettingsResponse(**user_settings_service.migrate_browser_settings(user_id, req.model_dump(exclude_none=True)))


from pydantic import BaseModel, Field
import asyncio
from app.services import analysis_sharing

class HistorySharingRequest(BaseModel):
    emails: list[str] = Field(default_factory=list, max_length=20)

@router.get('/real-history-sharing')
async def get_history_sharing(user_id: str = Depends(get_request_user_id)):
    try:
        return await asyncio.to_thread(analysis_sharing.settings, user_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, 'History sharing settings could not be read; retry later') from exc

@router.put('/real-history-sharing')
async def save_history_sharing(req: HistorySharingRequest, user_id: str = Depends(get_request_user_id)):
    try:
        return await asyncio.to_thread(analysis_sharing.save, user_id, req.emails)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(503, 'History sharing could not be saved; refresh and retry') from exc
