"""
Hotword strategy management — saved strategies per user.
GET  /ai/strategies           — list all saved strategies
DELETE /ai/strategies/{hotword} — remove a saved strategy
"""
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator

from db import strategies_store

logger = logging.getLogger("aihelper.routers.strategies")

router = APIRouter()


class StrategyItem(BaseModel):
    hotword: str
    strategy_text: str
    description: Optional[str] = None
    created_at: str
    last_used_at: Optional[str] = None
    use_count: Optional[int] = None
    is_template: Optional[bool] = None
    template_text: Optional[str] = None
    template_type: Optional[str] = None

    @field_validator("use_count", mode="before")
    @classmethod
    def coerce_decimal(cls, v):
        return int(v) if v is not None else None

    @field_validator("is_template", mode="before")
    @classmethod
    def coerce_bool(cls, v):
        return bool(v) if v is not None else None


@router.get("/ai/strategies", response_model=dict)
async def list_strategies(user_id: str):
    """List all saved hotword strategies for a user."""
    try:
        items = strategies_store.list_strategies(user_id)
    except Exception:
        logger.exception("Error listing strategies for user %s", user_id)
        items = []
    parsed = [StrategyItem(**item).model_dump(exclude_none=False) for item in items]
    return {"strategies": parsed}


@router.delete("/ai/strategies/{hotword}")
async def delete_strategy(hotword: str, user_id: str):
    """Delete a saved hotword strategy."""
    try:
        deleted = strategies_store.delete_strategy(user_id, hotword)
    except Exception:
        logger.exception("Error deleting strategy %r for user %s", hotword, user_id)
        raise HTTPException(status_code=500, detail="Failed to delete strategy")
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Strategy '{hotword}' not found")
    return {"status": "deleted", "hotword": hotword}
