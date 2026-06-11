from fastapi import APIRouter, Depends, HTTPException
from app.models.schemas import UserSettingsResponse, UserSettingsUpdateRequest
from app.services import user_settings_service
from app.dependencies import get_request_user_id

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/settings", response_model=UserSettingsResponse)
async def get_user_settings(user_id: str = Depends(get_request_user_id)):
    settings = user_settings_service.get_settings(user_id)
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
