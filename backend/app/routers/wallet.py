import asyncio
import logging

from fastapi import APIRouter, Depends, Query, HTTPException
from app.models.schemas import WalletResponse, WalletResetRequest
from app.services import wallet_service
from app.dependencies import get_request_user_id
from app.config import EQUITY_MIS_MARGIN_RATE

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


def _session_wallet_metrics(session, balance: float) -> dict:
    if session.session_type == "real":
        return {"session_capital": session.session_capital}
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
            "capital_balance": round(balance + margin_used, 2),
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
    mode: str | None = Query(default=None, pattern="^(paper|sim|replay|stepwise)$"),
):
    if session_id:
        from app.services import simulation
        session = simulation.get_session(session_id)
        if not session or session.user_id != user_id:
            raise HTTPException(status_code=404, detail="Session not found")
        if session.session_type == "real":
            try:
                snapshot = await asyncio.to_thread(wallet_service.get_real_wallet_snapshot, user_id, session.date)
                if "session_capital" in snapshot:
                    from app.services.real_accounting import apply_session_capital
                    apply_session_capital(session, snapshot["session_capital"])
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc))
            except Exception:
                logger.exception("Real wallet snapshot unavailable user_id=%s", user_id)
                raise HTTPException(status_code=503, detail="Could not read broker wallet snapshot")
            return WalletResponse(user_id=user_id, date=session.date, ledger_kind="real",
                **{"session_capital": session.session_capital, **snapshot})
        from app.services.practice_wallets import read
        kind = "paper" if session.session_type == "paper" else "sim"
        balance = float(read(user_id, session.date, kind)["current_balance"])
        date = session.date
        return WalletResponse(user_id=user_id, date=date, balance=balance, ledger_kind=kind, **_session_wallet_metrics(session, balance))
    else:
        from app.services.practice_wallets import kind_for, read, blocked
        try:
            kind = kind_for(date, mode)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        balance = float(read(user_id, date, kind)["current_balance"])
        reason = blocked(user_id, date, kind)
        return WalletResponse(user_id=user_id, date=date, balance=balance, ledger_kind=kind,
            reset_allowed=not reason, reset_reason=reason)


@router.post("/reset", response_model=WalletResponse)
async def reset_wallet(
    req: WalletResetRequest,
    date: str = Query(..., description="YYYY-MM-DD"),
    user_id: str = Depends(get_request_user_id),
    mode: str | None = Query(default=None, pattern="^(paper|sim|replay|stepwise)$"),
):
    from app.services.practice_wallets import kind_for, reset
    try:
        kind = kind_for(date, mode)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    balance = reset(user_id, date, kind, req.amount)
    return WalletResponse(user_id=user_id, date=date, balance=balance, ledger_kind=kind, reset_allowed=True)



@router.post("/refresh", response_model=WalletResponse)
async def refresh_real_wallet(
    session_id: str = Query(...),
    user_id: str = Depends(get_request_user_id),
):
    from app.services import simulation
    from app.services.kotak_service import get_service, KotakError
    session = simulation.get_session(session_id)
    if not session or session.user_id != user_id:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.session_type != "real":
        raise HTTPException(status_code=400, detail="Broker funds refresh requires a real session")
    try:
        from app.services import real_accounting
        await real_accounting.refresh(user_id, session.date, get_service(), reason="refresh")
        snapshot = await asyncio.to_thread(wallet_service.get_real_wallet_snapshot, user_id, session.date)
        real_accounting.apply_session_capital(session, snapshot["session_capital"])
    except KotakError as exc:
        raise HTTPException(status_code=502, detail=f"Could not fetch Kotak funds: {exc}")
    except Exception:
        logger.exception("Could not persist real wallet refresh user_id=%s", user_id)
        raise HTTPException(status_code=503, detail="Could not save broker wallet refresh")
    return WalletResponse(user_id=user_id, date=session.date, **snapshot)
