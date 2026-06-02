"""
GET  /ai/session/{session_id}/commands  — list all commands for a session (any status).
DELETE /ai/commands/{command_id}?user_id={user_id} — cancel a specific active command.
"""
import logging
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from db import commands_store

logger = logging.getLogger("aihelper.routers.commands")

router = APIRouter()


class CommandItem(BaseModel):
    command_id: str
    user_id: str
    session_id: str
    command_text: str
    status: str                 # active | executed | cancelled
    order_type: str
    quantity_type: str
    quantity_value: float | None = None
    parsed_trigger: str
    parsed_price_expr: str
    symbol: str | None = None
    right: str | None = None    # CE | PE | null (equity)
    strike: float | None = None
    hotword: str | None = None
    one_shot: bool = True
    created_at: str
    fired_at: str | None = None
    cancel_reason: str | None = None


def _to_command_item(item: dict) -> CommandItem:
    return CommandItem(
        command_id=item["command_id"],
        user_id=item["user_id"],
        session_id=item["session_id"],
        command_text=item.get("command_text", ""),
        status=item.get("status", "active"),
        order_type=item.get("order_type", "market"),
        quantity_type=item.get("quantity_type", "ratio_l"),
        quantity_value=float(item["quantity_value"]) if item.get("quantity_value") is not None else None,
        parsed_trigger=item.get("parsed_trigger", ""),
        parsed_price_expr=item.get("parsed_price_expr", "market"),
        symbol=item.get("symbol") or None,
        right=item.get("right") or None,
        strike=float(item["strike"]) if item.get("strike") is not None else None,
        hotword=item.get("hotword") or None,
        one_shot=bool(item.get("one_shot", True)),
        created_at=item.get("created_at", ""),
        fired_at=item.get("fired_at") or None,
        cancel_reason=item.get("cancel_reason") or None,
    )


@router.get("/ai/session/{session_id}/commands", response_model=list[CommandItem])
async def list_commands(session_id: str):
    """
    Returns all commands for the session (active, executed, cancelled), newest-first.
    Frontend uses this to populate the Commands tab with status badges.
    """
    logger.debug("list_commands: session=%s", session_id)
    try:
        items = commands_store.list_all_commands_for_session(session_id)
    except Exception:
        logger.exception("Error listing commands for session %s", session_id)
        items = []
    return [_to_command_item(i) for i in items]


@router.delete("/ai/commands/{command_id}", status_code=200)
async def cancel_command(
    command_id: str,
    user_id: str = Query(..., description="Owner of the command"),
):
    """
    Cancel a single active command.
    Returns 404 if not found, 400 if already executed or cancelled.
    """
    logger.info("cancel_command: command_id=%s user_id=%s", command_id, user_id)
    item = commands_store.get_command(user_id, command_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Command not found")
    if item.get("status") != "active":
        raise HTTPException(
            status_code=400,
            detail=f"Command is already '{item.get('status')}' and cannot be cancelled",
        )
    commands_store.cancel_command(user_id, command_id, reason="user_cancelled")
    logger.info("Command %s cancelled by user %s", command_id, user_id)
    return {"cancelled": True, "command_id": command_id}
