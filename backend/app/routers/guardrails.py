"""
GuardRails API router.

POST /api/guardrails/block    — manually trigger BLOCK for the running session
GET  /api/guardrails/status   — get current guardrail state for a session
GET  /api/guardrails/settings — get guardrail settings for the current user
POST /api/guardrails/settings — update guardrail settings for the current user
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from fastapi import Depends

from app.models.schemas import (
    TriggerBlockRequest,
    GuardRailStatusResponse,
    GuardRailSettingsResponse,
    GuardRailSettingsUpdateRequest,
)
from app.services import simulation as sim_svc
from app.services import user_settings_service as settings_svc
from app.dependencies import get_request_user_id

router = APIRouter(prefix="/api/guardrails", tags=["guardrails"])


@router.post("/block")
def trigger_block(req: TriggerBlockRequest):
    """Manually trigger the BLOCK guardrail on a running session."""
    session = sim_svc.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    from app.services.guardrail_service import trigger_block as _trigger_block, check_guardrails
    # BAN already active — no point triggering BLOCK
    if session.guardrail_ban_active:
        raise HTTPException(status_code=409, detail="BAN guardrail is already active")

    reason, until_bar = _trigger_block(session)
    return {"status": "blocked", "reason": reason, "until_bar": until_bar}


@router.get("/status")
def get_status(session_id: str):
    """Return current guardrail state for a session."""
    session = sim_svc.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    from app.services.guardrail_service import _current_bar_slot
    current_slot = _current_bar_slot(session)
    block_active = (
        not session.guardrail_ban_active
        and session.guardrail_block_until_bar > 0
        and current_slot <= session.guardrail_block_until_bar
    )

    return GuardRailStatusResponse(
        block_active=block_active,
        block_until_bar=session.guardrail_block_until_bar,
        ban_active=session.guardrail_ban_active,
        cooldown_enabled=session.guardrail_cooldown_enabled,
        consecutive_losses=session.guardrail_consecutive_losses,
        settings=GuardRailSettingsResponse(
            guardrail_block_bars=session.guardrail_block_bars,
            guardrail_cooldown_losses=session.guardrail_cooldown_losses,
            guardrail_ban_capital_pct=session.guardrail_ban_capital_pct,
            guardrail_ban_loss_trade_pct=session.guardrail_ban_loss_trade_pct,
            guardrail_ban_min_trades=getattr(session, "guardrail_ban_min_trades", 5),
            guardrail_ban_enabled=session.guardrail_ban_enabled,
            guardrail_cooldown_enabled=session.guardrail_cooldown_enabled,
            guardrail_maxsize_enabled=session.guardrail_maxsize_enabled,
            guardrail_maxsize_mode=session.guardrail_maxsize_mode,
            guardrail_maxsize_pct=session.guardrail_maxsize_pct,
            guardrail_maxsize_value=session.guardrail_maxsize_value,
        ),
    )


@router.get("/settings")
def get_settings(user_id: str = Depends(get_request_user_id)):
    """Return guardrail settings for the current user."""
    s = settings_svc.get_settings(user_id)
    return GuardRailSettingsResponse(
        guardrail_block_bars=s.get("guardrail_block_bars", 3),
        guardrail_cooldown_block_bars=s.get("guardrail_cooldown_block_bars", 3),
        guardrail_cooldown_losses=s.get("guardrail_cooldown_losses", 3),
        guardrail_ban_capital_pct=s.get("guardrail_ban_capital_pct", 10.0),
        guardrail_ban_loss_trade_pct=s.get("guardrail_ban_loss_trade_pct", 60.0),
        guardrail_ban_min_trades=s.get("guardrail_ban_min_trades", 5),
        guardrail_ban_enabled=s.get("guardrail_ban_enabled", False),
        guardrail_cooldown_enabled=s.get("guardrail_cooldown_enabled", False),
        guardrail_maxsize_enabled=s.get("guardrail_maxsize_enabled", False),
        guardrail_maxsize_mode=s.get("guardrail_maxsize_mode", "percentage"),
        guardrail_maxsize_pct=s.get("guardrail_maxsize_pct", 20.0),
        guardrail_maxsize_value=s.get("guardrail_maxsize_value", 0.0),
    )


@router.post("/settings")
def update_settings(req: GuardRailSettingsUpdateRequest, user_id: str = Depends(get_request_user_id)):
    """Update guardrail settings for the current user."""
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    updated = settings_svc.update_settings(user_id, updates)
    return GuardRailSettingsResponse(
        guardrail_block_bars=updated.get("guardrail_block_bars", 3),
        guardrail_cooldown_block_bars=updated.get("guardrail_cooldown_block_bars", 3),
        guardrail_cooldown_losses=updated.get("guardrail_cooldown_losses", 3),
        guardrail_ban_capital_pct=updated.get("guardrail_ban_capital_pct", 10.0),
        guardrail_ban_loss_trade_pct=updated.get("guardrail_ban_loss_trade_pct", 60.0),
        guardrail_ban_min_trades=updated.get("guardrail_ban_min_trades", 5),
        guardrail_ban_enabled=updated.get("guardrail_ban_enabled", False),
        guardrail_cooldown_enabled=updated.get("guardrail_cooldown_enabled", False),
        guardrail_maxsize_enabled=updated.get("guardrail_maxsize_enabled", False),
        guardrail_maxsize_mode=updated.get("guardrail_maxsize_mode", "percentage"),
        guardrail_maxsize_pct=updated.get("guardrail_maxsize_pct", 20.0),
        guardrail_maxsize_value=updated.get("guardrail_maxsize_value", 0.0),
    )
