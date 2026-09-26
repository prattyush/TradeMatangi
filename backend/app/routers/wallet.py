from fastapi import APIRouter, Depends, Query, HTTPException
from app.models.schemas import WalletResponse, WalletResetRequest
from app.services import wallet_service
from app.dependencies import get_request_user_id
from app.config import EQUITY_MIS_MARGIN_RATE

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


def _session_wallet_metrics(session, balance: float) -> dict:
    if session.instrument_type != "equity" or session.session_type not in ("sim", "stepwise", "paper", "real"):
        return {}
    try:
        from app.services import order_service, trading
        position = trading.get_position(session.session_id, symbol=session.symbol)
        exposure = 0.0
        if position.side != "FLAT" and position.quantity > 0:
            exposure = position.avg_entry_price * position.quantity
        pending_exposure = sum(
            order.limit_price * order.quantity
            for order in order_service.get_open_orders(session.session_id)
            if order.right is None and not order.is_stoploss
        )
        reserved = sum(
            order.reserved_amount
            for order in order_service.get_open_orders(session.session_id)
            if order.right is None and order.reserved_amount > 0
        )
        open_margin = exposure * EQUITY_MIS_MARGIN_RATE
        margin_used = max(0.0, open_margin + reserved)
        available_margin = max(0.0, balance)
        return {
            "session_capital": session.session_capital,
            "margin_used": round(margin_used, 2),
            "available_margin": round(available_margin, 2),
            "buying_power": round(available_margin / EQUITY_MIS_MARGIN_RATE, 2),
            "exposure": round(exposure + pending_exposure, 2),
            "margin_rate": EQUITY_MIS_MARGIN_RATE,
        }
    except Exception:
        return {}


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
        return WalletResponse(user_id=user_id, date=date, balance=balance, **_session_wallet_metrics(session, balance))
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
