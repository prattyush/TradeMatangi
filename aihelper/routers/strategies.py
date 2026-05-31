"""
Hotword strategy management — saved strategies per user.
GET  /ai/strategies           — list all saved strategies
DELETE /ai/strategies/{hotword} — remove a saved strategy
Full implementation in Step 6 (hotword strategies).
"""
import logging
from fastapi import APIRouter, HTTPException

from db import strategies_store

logger = logging.getLogger("aihelper.routers.strategies")

router = APIRouter()


@router.get("/ai/strategies")
async def list_strategies(user_id: str):
    """List all saved hotword strategies for a user."""
    try:
        items = strategies_store.list_strategies(user_id)
    except Exception:
        logger.exception("Error listing strategies for user %s", user_id)
        items = []
    return {"strategies": items}


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
