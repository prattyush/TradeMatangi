from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr

from app.services.user_service import login_user, register_user

router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthRequest(BaseModel):
    email: str
    password: str


class AuthResponse(BaseModel):
    user_id: str
    email: str


@router.post("/login", response_model=AuthResponse)
async def login(req: AuthRequest):
    result = login_user(req.email, req.password)
    if not result:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return result


@router.post("/register", response_model=AuthResponse)
async def register(req: AuthRequest):
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    try:
        return register_user(req.email, req.password)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
