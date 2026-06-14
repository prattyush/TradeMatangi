from fastapi import APIRouter, Depends, Query
from app.models.schemas import WalletResponse, WalletResetRequest
from app.services import wallet_service
from app.dependencies import get_request_user_id

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


@router.get("", response_model=WalletResponse)
async def get_wallet(
    date: str = Query(..., description="YYYY-MM-DD"),
    user_id: str = Depends(get_request_user_id),
):
    balance = wallet_service.get_balance(user_id, date)
    return WalletResponse(user_id=user_id, date=date, current_balance=balance)


@router.post("/reset", response_model=WalletResponse)
async def reset_wallet(
    req: WalletResetRequest,
    date: str = Query(..., description="YYYY-MM-DD"),
    user_id: str = Depends(get_request_user_id),
):
    balance = wallet_service.reset(user_id, date, req.amount)
    return WalletResponse(user_id=user_id, date=date, current_balance=balance)
