from fastapi import APIRouter, Depends, Query, HTTPException
from app.models.schemas import WalletResponse, WalletResetRequest
from app.services import wallet_service
from app.dependencies import get_request_user_id

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


@router.get("", response_model=WalletResponse)
async def get_wallet(
    date: str = Query(..., description="YYYY-MM-DD"),
    session_id: str | None = Query(default=None),
    user_id: str = Depends(get_request_user_id),
):
    if session_id:
        from app.services import simulation
        session = simulation.get_session(session_id)
        if not session or session.user_id != user_id:
            raise HTTPException(status_code=404, detail="Session not found")
        balance = wallet_service.get_ledger_balance(user_id, session.date, session.wallet_ledger_id)
        date = session.date
    else:
        balance = wallet_service.get_balance(user_id, date)
    return WalletResponse(user_id=user_id, date=date, balance=balance)


@router.post("/reset", response_model=WalletResponse)
async def reset_wallet(
    req: WalletResetRequest,
    date: str = Query(..., description="YYYY-MM-DD"),
    user_id: str = Depends(get_request_user_id),
):
    balance = wallet_service.reset(user_id, date, req.amount)
    return WalletResponse(user_id=user_id, date=date, balance=balance)
