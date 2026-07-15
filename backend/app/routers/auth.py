from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.dependencies import get_request_user_id
from app.services.user_service import (
    login_user, register_user, get_user_info, change_password,
    google_auth, set_account_name,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthRequest(BaseModel):
    email: str
    password: str
    account_name: str | None = None


class AuthResponse(BaseModel):
    user_id: str
    email: str
    is_admin: bool = False
    account_name: str | None = None


class GoogleAuthRequest(BaseModel):
    id_token: str
    account_name: str | None = None


class SetAccountNameRequest(BaseModel):
    account_name: str


@router.post("/login", response_model=AuthResponse)
async def login(req: AuthRequest):
    result = login_user(req.email, req.password)
    if not result:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return AuthResponse(
        user_id=result["user_id"],
        email=result["email"],
        is_admin=bool(result.get("is_admin", False)),
        account_name=result.get("account_name"),
    )


@router.post("/register", response_model=AuthResponse)
async def register(req: AuthRequest):
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    try:
        return register_user(req.email, req.password, account_name=req.account_name)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


@router.post("/change-password", status_code=204)
async def change_password_endpoint(
    req: ChangePasswordRequest,
    user_id: str = Depends(get_request_user_id),
):
    if len(req.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters")
    try:
        ok = change_password(user_id, req.old_password, req.new_password)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    if not ok:
        raise HTTPException(status_code=401, detail="Current password is incorrect")


@router.get("/me", response_model=AuthResponse)
async def get_me(user_id: str = Depends(get_request_user_id)):
    """Return profile of the currently authenticated user."""
    info = get_user_info(user_id)
    if not info:
        raise HTTPException(status_code=404, detail="User not found")
    return AuthResponse(
        user_id=info["user_id"],
        email=info["email"],
        is_admin=bool(info.get("is_admin", False)),
        account_name=info.get("account_name"),
    )


@router.post("/google", response_model=AuthResponse)
async def google_login(req: GoogleAuthRequest):
    """Sign in or sign up with Google ID token."""
    result = google_auth(req.id_token, account_name=req.account_name)
    if not result:
        raise HTTPException(status_code=401, detail="Invalid Google token or account_name required")
    return AuthResponse(
        user_id=result["user_id"],
        email=result["email"],
        is_admin=bool(result.get("is_admin", False)),
        account_name=result.get("account_name"),
    )


@router.post("/account-name", response_model=AuthResponse)
async def set_account_name_endpoint(
    req: SetAccountNameRequest,
    user_id: str = Depends(get_request_user_id),
):
    """Set the account_name for the current user. Used for Google sign-in users who haven't set one yet."""
    if not req.account_name.strip():
        raise HTTPException(status_code=400, detail="account_name is required")
    result = set_account_name(user_id, req.account_name.strip())
    if not result:
        raise HTTPException(status_code=404, detail="User not found")
    return AuthResponse(
        user_id=result["user_id"],
        email=result["email"],
        is_admin=bool(result.get("is_admin", False)),
        account_name=result.get("account_name"),
    )
