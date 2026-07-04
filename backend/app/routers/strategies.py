"""
Strategies router: start, cancel, and list automated trading strategies.

POST /api/strategies/start            — register a new strategy for a running session
POST /api/strategies/cancel-all       — cancel all running strategies for a session
POST /api/strategies/{id}/cancel      — cancel a single strategy
PATCH /api/strategies/{id}/price      — update lock price for LockProfit / TargetProfit
GET  /api/strategies                  — list running strategies for a session
"""
from fastapi import APIRouter, Depends, HTTPException

from app.models.schemas import (
    StartStrategyRequest,
    UpdateStrategyPriceRequest,
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
    if req.strategy_type in (
        StrategyType.BREAK_EVEN,
        StrategyType.AGGRESSIVE_STOPLOSS,
        StrategyType.TARGET_PROFIT,
        StrategyType.LOCK_PROFIT,
        StrategyType.UNDERLYING_TARGET_PROFIT,
    ):
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

    # TargetProfit and UnderlyingTargetProfit require a target value
    if req.strategy_type in (StrategyType.TARGET_PROFIT, StrategyType.UNDERLYING_TARGET_PROFIT):
        if req.target_profit_value is None:
            raise HTTPException(
                status_code=400,
                detail=f"{req.strategy_type.value} requires target_profit_value",
            )
        if req.target_profit_value <= 0:
            raise HTTPException(
                status_code=400,
                detail="target_profit_value must be positive",
            )

    # UnderlyingTargetProfit is options-only — right must be CE or PE
    if req.strategy_type == StrategyType.UNDERLYING_TARGET_PROFIT:
        if right not in ("CE", "PE"):
            raise HTTPException(
                status_code=400,
                detail="UnderlyingTargetProfit requires right='CE' or 'PE' (options only)",
            )

    # LockProfit requires a lock price value
    if req.strategy_type == StrategyType.LOCK_PROFIT:
        if req.lock_profit_value is None:
            raise HTTPException(
                status_code=400,
                detail="LockProfit requires lock_profit_value",
            )
        if req.lock_profit_value <= 0:
            raise HTTPException(
                status_code=400,
                detail="lock_profit_value must be positive",
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
        "breakeven_mode": req.breakeven_mode,
        "target_profit_value": req.target_profit_value,
        "target_profit_is_pct": req.target_profit_is_pct,
        "target_profit_buffer_ticks": max(1, min(5, req.target_profit_buffer_ticks)),
        "triggered": False,
    }
    if req.quantity is not None:
        metadata["quantity"] = req.quantity
    if req.funds_ratio_pct is not None:
        metadata["funds_ratio_pct"] = req.funds_ratio_pct

    # LockProfit: resolve pct → absolute price at start time
    if req.strategy_type == StrategyType.LOCK_PROFIT:
        lock_value = req.lock_profit_value  # validated non-None above
        if req.lock_profit_is_pct:
            session_capital = float(getattr(session, "session_capital", 0))
            position = get_position(session.session_id, session.symbol, right)
            if position.side != "FLAT" and position.quantity > 0 and session_capital > 0:
                target_pnl = (lock_value / 100.0) * session_capital
                from app.services.strategy_service import _ceil_tick
                if position.side == "LONG":
                    lock_value = _ceil_tick(position.avg_entry_price + target_pnl / position.quantity)
                else:
                    lock_value = _ceil_tick(position.avg_entry_price - target_pnl / position.quantity)
        metadata["lock_profit_price"] = lock_value

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
        triggered=bool(instance.metadata.get("triggered", False)),
    )


@router.post("/cancel-all")
def cancel_all_strategies(
    req: CancelAllStrategiesRequest,
    user_id: str = Depends(get_request_user_id),
):
    _session_or_404(req.session_id)
    count = strategy_service.cancel_all(req.session_id)
    return {"cancelled": count}


@router.post("/{strategy_id}/cancel")
def cancel_strategy(
    strategy_id: str,
    req: CancelAllStrategiesRequest,
    user_id: str = Depends(get_request_user_id),
):
    _session_or_404(req.session_id)
    found = strategy_service.cancel_strategy(req.session_id, strategy_id)
    if not found:
        raise HTTPException(status_code=404, detail="Strategy not found or not running")
    return {"cancelled": strategy_id}


@router.patch("/{strategy_id}/price")
def update_strategy_price(
    strategy_id: str,
    req: UpdateStrategyPriceRequest,
    user_id: str = Depends(get_request_user_id),
):
    _session_or_404(req.session_id)
    if req.price <= 0:
        raise HTTPException(status_code=400, detail="price must be positive")
    found = strategy_service.update_strategy_price(req.session_id, strategy_id, req.price)
    if not found:
        raise HTTPException(status_code=404, detail="Strategy not found, not running, or not price-updatable")
    return {"updated": strategy_id, "price": req.price}


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
            triggered=bool(s.metadata.get("triggered", False)),
        )
        for s in running
    ]
