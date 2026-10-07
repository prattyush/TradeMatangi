"""Authenticated desktop access to account settings and existing account actions."""
from fastapi import APIRouter, Depends
from app.dependencies import get_desktop_user_id, require_real_trading_access
from app.routers import admin, auth, breeze, kotak
from app.models.schemas import KotakLoginRequest, WhitelistAddRequest

router = APIRouter(prefix="/api/desktop/v1/settings", tags=["desktop"])


def require_admin(user_id: str = Depends(get_desktop_user_id)) -> str:
    return admin._require_admin(user_id)


def require_broker_access(user_id: str = Depends(get_desktop_user_id)) -> str:
    return require_real_trading_access(user_id)


@router.get("/profile")
async def profile(user_id: str = Depends(get_desktop_user_id)):
    info = await auth.get_me(user_id)
    access = await kotak.check_real_trading_access(user_id)
    return {**info.model_dump(), "real_trading_enabled": access["has_access"]}


@router.post("/change-password", status_code=204)
async def change_password(req: auth.ChangePasswordRequest, user_id: str = Depends(get_desktop_user_id)):
    await auth.change_password_endpoint(req, user_id)


@router.get("/kotak/status")
async def kotak_status(user_id: str = Depends(require_broker_access)):
    return await kotak.kotak_status(user_id)


@router.post("/kotak/login")
async def kotak_login(req: KotakLoginRequest, user_id: str = Depends(require_broker_access)):
    return await kotak.kotak_login(req, user_id)


@router.get("/breeze/status")
async def breeze_status(user_id: str = Depends(require_broker_access)):
    return await breeze.breeze_status(user_id)


@router.get("/admin/tokens")
async def tokens(user_id: str = Depends(require_admin)):
    return await admin.get_tokens(user_id)


@router.put("/admin/tokens")
async def save_tokens(req: admin.SetTokensRequest, user_id: str = Depends(require_admin)):
    return await admin.set_tokens(req, user_id)


@router.get("/admin/stream-source")
async def stream_source(user_id: str = Depends(require_admin)):
    return await admin.get_stream_source(user_id)


@router.put("/admin/stream-source")
async def save_stream_source(req: admin.StreamSourceRequest, user_id: str = Depends(require_admin)):
    return await admin.set_stream_source(req, user_id)


@router.get("/admin/historical-source")
async def historical_source(user_id: str = Depends(require_admin)):
    return await admin.get_historical_source(user_id)


@router.put("/admin/historical-source")
async def save_historical_source(req: admin.HistoricalSourceRequest, user_id: str = Depends(require_admin)):
    return await admin.set_historical_source(req, user_id)


@router.get("/admin/real-trading/whitelist")
async def whitelist(user_id: str = Depends(require_admin)):
    return await admin.get_real_trading_whitelist(user_id)


@router.post("/admin/real-trading/whitelist", status_code=201)
async def add_whitelist(req: WhitelistAddRequest, user_id: str = Depends(require_admin)):
    return await admin.add_real_trading_whitelist(req, user_id)


@router.delete("/admin/real-trading/whitelist/{email}", status_code=204)
async def remove_whitelist(email: str, user_id: str = Depends(require_admin)):
    await admin.remove_real_trading_whitelist(email, user_id)


from app.routers.users import HistorySharingRequest
from app.routers import users
from app.routers.desktop_analysis import get_analysis_user_id

@router.get('/real-history-sharing')
async def history_sharing(user_id: str = Depends(get_analysis_user_id)):
    return await users.get_history_sharing(user_id)

@router.put('/real-history-sharing')
async def save_history_sharing(req: HistorySharingRequest, user_id: str = Depends(get_analysis_user_id)):
    return await users.save_history_sharing(req, user_id)
