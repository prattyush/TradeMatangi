"""
Strategies router: start, cancel, and list automated trading strategies.

POST /api/strategies/start       — register a new strategy for a running session
POST /api/strategies/cancel-all  — cancel all running strategies for a session
GET  /api/strategies             — list running strategies for a session
"""
from fastapi import APIRouter, Depends, HTTPException

from app.models.schemas import (
    StartStrategyRequest,
    StrategyResponse,
    CancelAllStrategiesRequest,
    StrategyType,
)
from app.services import simulation as sim_svc
from app.services import strategy_service
from app.services.trading import get_position
from app.dependencies import get_request_user_id

router = APIRouter(prefix="/api/strategies", tags=["strategies"])


def _session_or_404(session_id: str):
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.post("/start", response_model=StrategyResponse)
def start_strategy(req: StartStrategyRequest, user_id: str = Depends(get_request_user_id)):
    session = _session_or_404(req.session_id)

    right = req.right.upper() if req.right else None

    # Validate right for options sessions
    if right and right not in ("CE", "PE"):
        raise HTTPException(status_code=400, detail="right must be 'CE' or 'PE'")

    # Exit and TradeManagement strategies require an open position
    if req.strategy_type in (StrategyType.BREAK_EVEN, StrategyType.AGGRESSIVE_STOPLOSS):
        position = get_position(session.session_id, session.symbol, right)
        if position.side == "FLAT":
            raise HTTPException(
                status_code=400,
                detail=f"{req.strategy_type.value} requires an open position",
            )

    # AutoStop requires a sizing parameter
    if req.strategy_type == StrategyType.AUTO_STOP:
        if req.quantity is None and req.funds_ratio_pct is None:
            raise HTTPException(
                status_code=400,
                detail="AutoStop requires quantity or funds_ratio_pct",
            )

    # For options sessions AutoStop is always BUY
    direction = req.direction.upper()
    if session.instrument_type == "options" and req.strategy_type == StrategyType.AUTO_STOP:
        direction = "BUY"

    # Build metadata from request
    metadata: dict = {
        "autostop_trigger_type": req.autostop_trigger_type,
        "autostop_deviation_pct": req.autostop_deviation_pct,
        "direction": direction,
        "only_in_profit": req.only_in_profit,
    }
    if req.quantity is not None:
        metadata["quantity"] = req.quantity
    if req.funds_ratio_pct is not None:
        metadata["funds_ratio_pct"] = req.funds_ratio_pct

    instance = strategy_service.start_strategy(
        session=session,
        strategy_type=req.strategy_type.value,
        right=right,
        metadata=metadata,
    )
    return StrategyResponse(
        strategy_id=instance.strategy_id,
        strategy_type=instance.strategy_type,
        symbol=instance.symbol,
        right=instance.right,
        status=instance.status.value,
    )


@router.post("/cancel-all")
def cancel_all_strategies(
    req: CancelAllStrategiesRequest,
    user_id: str = Depends(get_request_user_id),
):
    _session_or_404(req.session_id)
    count = strategy_service.cancel_all(req.session_id)
    return {"cancelled": count}


@router.get("", response_model=list[StrategyResponse])
def list_strategies(session_id: str, user_id: str = Depends(get_request_user_id)):
    _session_or_404(session_id)
    running = strategy_service.list_running(session_id)
    return [
        StrategyResponse(
            strategy_id=s.strategy_id,
            strategy_type=s.strategy_type,
            symbol=s.symbol,
            right=s.right,
            status=s.status.value,
        )
        for s in running
    ]
