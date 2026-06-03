"""
AICommands table — active commands per session.

Schema:
  PK: user_id (S)
  SK: command_id (S)
  GSI SessionCommandsIndex: PK=session_id (fast lookup per bar-close hook)
"""
import logging
from datetime import datetime, timezone
from typing import Any

from botocore.exceptions import ClientError
from db.dynamo import get_dynamodb_resource

logger = logging.getLogger("aihelper.db.commands_store")

TABLE_NAME = "AICommands"


def _table():
    return get_dynamodb_resource().Table(TABLE_NAME)


def put_command(item: dict[str, Any]) -> None:
    """Write a new AICommand item. caller must supply all required fields."""
    _table().put_item(Item=item)


def get_command(user_id: str, command_id: str) -> dict | None:
    resp = _table().get_item(Key={"user_id": user_id, "command_id": command_id})
    return resp.get("Item")


def get_active_commands_for_session(session_id: str) -> list[dict]:
    """Query SessionCommandsIndex GSI to get active commands for a session."""
    resp = _table().query(
        IndexName="SessionCommandsIndex",
        KeyConditionExpression="session_id = :sid",
        FilterExpression="#s = :active",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":sid": session_id, ":active": "active"},
    )
    return resp.get("Items", [])


def mark_command_executed(user_id: str, command_id: str) -> None:
    _table().update_item(
        Key={"user_id": user_id, "command_id": command_id},
        UpdateExpression="SET #s = :executed, fired_at = :ts",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":executed": "executed",
            ":ts": datetime.now(timezone.utc).isoformat(),
        },
    )


def claim_command_execution(user_id: str, command_id: str) -> bool:
    """Atomically transition active → executing. Returns False if already claimed/done."""
    try:
        _table().update_item(
            Key={"user_id": user_id, "command_id": command_id},
            UpdateExpression="SET #s = :executing",
            ConditionExpression="#s = :active",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":active": "active", ":executing": "executing"},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


def unclaim_command_execution(user_id: str, command_id: str) -> None:
    """Revert executing → active so the command retries on the next bar after a backend failure."""
    try:
        _table().update_item(
            Key={"user_id": user_id, "command_id": command_id},
            UpdateExpression="SET #s = :active",
            ConditionExpression="#s = :executing",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":active": "active", ":executing": "executing"},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def _get_nonterminal_commands_for_session(session_id: str) -> list[dict]:
    """Return active + executing commands for a session (both non-terminal states)."""
    resp = _table().query(
        IndexName="SessionCommandsIndex",
        KeyConditionExpression="session_id = :sid",
        FilterExpression="#s IN (:active, :executing)",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":sid": session_id, ":active": "active", ":executing": "executing"},
    )
    return resp.get("Items", [])


def cancel_commands_for_session(session_id: str, reason: str = "session_ended") -> int:
    """Cancel all active and executing commands for a session. Returns count cancelled."""
    commands = _get_nonterminal_commands_for_session(session_id)
    table = _table()
    for cmd in commands:
        table.update_item(
            Key={"user_id": cmd["user_id"], "command_id": cmd["command_id"]},
            UpdateExpression="SET #s = :cancelled, cancel_reason = :reason",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":cancelled": "cancelled", ":reason": reason},
        )
    logger.info("Cancelled %d commands for session %s (reason: %s)", len(commands), session_id, reason)
    return len(commands)


def cancel_command(user_id: str, command_id: str, reason: str = "user_cancelled") -> None:
    _table().update_item(
        Key={"user_id": user_id, "command_id": command_id},
        UpdateExpression="SET #s = :cancelled, cancel_reason = :reason",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":cancelled": "cancelled", ":reason": reason},
    )


def list_active_commands_for_session(session_id: str) -> list[dict]:
    return get_active_commands_for_session(session_id)


def list_all_commands_for_session(session_id: str) -> list[dict]:
    """Query SessionCommandsIndex GSI — all statuses, newest-first by created_at."""
    resp = _table().query(
        IndexName="SessionCommandsIndex",
        KeyConditionExpression="session_id = :sid",
        ExpressionAttributeValues={":sid": session_id},
    )
    items = resp.get("Items", [])
    items.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return items
