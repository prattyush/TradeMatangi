"""
Session cleanup service — cascade delete all data for a session.

Deletes records from: Trades, Orders, Strategies, TradeLabels, EventSnapshots,
AICommands, AIDecisionLog, and the Sessions record itself.
Also resets the wallet entry for the given user+date.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _batch_delete_by_query(table_name: str, key_attr: str, session_id: str,
                           index_name: str | None = None) -> int:
    """Query a table (optionally via GSI) for items matching session_id and batch-delete them."""
    from app.services.db import get_dynamodb_resource, get_dynamodb_client
    resource = get_dynamodb_resource()
    table = resource.Table(table_name)

    try:
        if index_name:
            resp = table.query(
                IndexName=index_name,
                KeyConditionExpression="#k = :sid",
                ExpressionAttributeNames={"#k": key_attr},
                ExpressionAttributeValues={":sid": session_id},
            )
        else:
            resp = table.query(
                KeyConditionExpression="#k = :sid",
                ExpressionAttributeNames={"#k": key_attr},
                ExpressionAttributeValues={":sid": session_id},
            )
    except Exception:
        logger.exception("Failed to query %s for deletion, session %s", table_name, session_id)
        return 0

    items = resp.get("Items", [])
    if not items:
        return 0

    client = get_dynamodb_client()

    for i in range(0, len(items), 25):
        chunk = items[i:i + 25]
        delete_requests = [
            {"DeleteRequest": {"Key": {key_attr: {"S": str(it[key_attr])}}}}
            for it in chunk
        ]
        try:
            client.batch_write_item(RequestItems={table_name: delete_requests})
        except Exception:
            logger.exception("Failed to batch-delete from %s for session %s", table_name, session_id)

    logger.info("Deleted %d items from %s for session %s", len(items), table_name, session_id)
    return len(items)


def _batch_delete_composite_key(table_name: str, pk_attr: str, sk_attr: str,
                                session_id: str, index_name: str | None = None) -> int:
    """Query a table with composite key (PK+SK) and batch-delete matching items."""
    from app.services.db import get_dynamodb_resource, get_dynamodb_client
    resource = get_dynamodb_resource()
    table = resource.Table(table_name)

    try:
        if index_name:
            resp = table.query(
                IndexName=index_name,
                KeyConditionExpression="#k = :sid",
                ExpressionAttributeNames={"#k": pk_attr},
                ExpressionAttributeValues={":sid": session_id},
            )
        else:
            resp = table.query(
                KeyConditionExpression="#k = :sid",
                ExpressionAttributeNames={"#k": pk_attr},
                ExpressionAttributeValues={":sid": session_id},
            )
    except Exception:
        logger.exception("Failed to query %s for deletion, session %s", table_name, session_id)
        return 0

    items = resp.get("Items", [])
    if not items:
        return 0

    client = get_dynamodb_client()

    for i in range(0, len(items), 25):
        chunk = items[i:i + 25]
        delete_requests = [
            {"DeleteRequest": {"Key": {
                pk_attr: {"S": str(it[pk_attr])},
                sk_attr: {"S": str(it[sk_attr])},
            }}}
            for it in chunk
        ]
        try:
            client.batch_write_item(RequestItems={table_name: delete_requests})
        except Exception:
            logger.exception("Failed to batch-delete from %s for session %s", table_name, session_id)

    logger.info("Deleted %d items from %s for session %s", len(items), table_name, session_id)
    return len(items)


def delete_session_cascade(session_id: str, user_id: str, date: str) -> None:
    """Delete all data for a session: trades, orders, strategies, labels, snapshots, AI commands/logs, session record, and wallet entry."""
    logger.info("Starting cascade delete for session %s (user=%s, date=%s)", session_id, user_id, date)

    # Stop the session if it's currently running in-memory
    try:
        from app.services.simulation import get_session, stop_session
        session = get_session(session_id)
        if session is not None:
            stop_session(session_id)
            logger.info("Stopped running session %s", session_id)
    except Exception:
        logger.exception("Error stopping session %s during cascade delete", session_id)

    # Trades (PK: session_id, SK: trade_id)
    _batch_delete_composite_key("Trades", "session_id", "trade_id", session_id)

    # Orders (PK: session_id, SK: order_id)
    _batch_delete_composite_key("Orders", "session_id", "order_id", session_id)

    # Strategies (GSI: SessionIdIndex on session_id, PK: strategy_id)
    _batch_delete_by_query("Strategies", "session_id", session_id, index_name="SessionIdIndex")

    # TradeLabels (PK: session_id, SK: round_trip_index — stored as N)
    _batch_delete_composite_key("TradeLabels", "session_id", "round_trip_index", session_id)

    # EventSnapshots (existing service)
    try:
        from app.services.snapshot_service import delete_snapshots
        delete_snapshots(session_id)
    except Exception:
        logger.exception("Error deleting snapshots for session %s", session_id)

    # AICommands (GSI: SessionCommandsIndex on session_id, PK: user_id, SK: command_id)
    _batch_delete_by_query("AICommands", "session_id", session_id, index_name="SessionCommandsIndex")

    # AIDecisionLog (PK: session_id, SK: ts_command_id)
    _batch_delete_composite_key("AIDecisionLog", "session_id", "ts_command_id", session_id)

    # Sessions record (PK: session_id)
    try:
        from app.services.db import get_dynamodb_resource
        get_dynamodb_resource().Table("Sessions").delete_item(Key={"session_id": session_id})
        logger.info("Deleted session record %s", session_id)
    except Exception:
        logger.exception("Failed to delete session record %s", session_id)

    # Wallet entry for user+date
    try:
        from app.services.wallet_service import delete_entry
        delete_entry(user_id, date)
    except Exception:
        logger.exception("Error deleting wallet entry for user=%s date=%s", user_id, date)

    logger.info("Cascade delete complete for session %s", session_id)
