"""
Session cleanup service — cascade delete all data for a session.

Deletes records from: Trades, Orders, Strategies, TradeLabels, EventSnapshots,
AICommands, AIDecisionLog, and the Sessions record itself.
Also resets the wallet entry for the given user+date.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _delete_query(table_name, key_attr, session_id, keys, index_name=None):
    """Read every page, preserve key types and retry unprocessed writes."""
    import time
    from boto3.dynamodb.types import TypeSerializer
    from app.services.db import get_dynamodb_resource, get_dynamodb_client
    table = get_dynamodb_resource().Table(table_name)
    params = dict(KeyConditionExpression="#k = :sid",
                  ExpressionAttributeNames={"#k": key_attr},
                  ExpressionAttributeValues={":sid": session_id})
    if index_name:
        params["IndexName"] = index_name
    else:
        params["ConsistentRead"] = True
    items = []
    while True:
        page = table.query(**params)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    client = get_dynamodb_client()
    serializer = TypeSerializer()
    for offset in range(0, len(items), 25):
        pending = [{"DeleteRequest": {"Key": {k: serializer.serialize(row[k]) for k in keys}}}
                   for row in items[offset:offset + 25]]
        for attempt in range(5):
            pending = client.batch_write_item(RequestItems={table_name: pending}).get("UnprocessedItems", {}).get(table_name, [])
            if not pending:
                break
            if attempt < 4:
                time.sleep(0.1 * 2 ** attempt)
        if pending:
            raise RuntimeError(f"Incomplete deletion from {table_name} for {session_id}")
    return len(items)


def _batch_delete_by_query(table_name: str, key_attr: str, session_id: str,
                           index_name: str | None = None) -> int:
    keys = {"Strategies": ("strategy_id",), "AICommands": ("user_id", "command_id")}
    return _delete_query(table_name, key_attr, session_id, keys[table_name], index_name)


def _batch_delete_composite_key(table_name: str, pk_attr: str, sk_attr: str,
                                session_id: str, index_name: str | None = None) -> int:
    return _delete_query(table_name, pk_attr, session_id, (pk_attr, sk_attr), index_name)


def delete_session_cascade(session_id: str, user_id: str, date: str, reset_wallet: bool = True) -> None:
    """Delete all data for a session: trades, orders, strategies, labels, snapshots, AI commands/logs, session record, and wallet entry."""
    logger.info("Starting cascade delete for session %s (user=%s, date=%s)", session_id, user_id, date)

    # Stop the session if it's currently running in-memory
    try:
        from app.services.simulation import get_session, stop_session
        session = get_session(session_id)
        if session is not None:
            stop_session(session)
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

    # Fail before removing the root if snapshot cleanup is incomplete.
    from app.services.snapshot_service import delete_snapshots
    delete_snapshots(session_id)

    # AICommands (GSI: SessionCommandsIndex on session_id, PK: user_id, SK: command_id)
    _batch_delete_by_query("AICommands", "session_id", session_id, index_name="SessionCommandsIndex")

    # AIDecisionLog (PK: session_id, SK: ts_command_id)
    _batch_delete_composite_key("AIDecisionLog", "session_id", "ts_command_id", session_id)

    # Session root last; storage failures must reach the caller.
    from app.services.db import get_dynamodb_resource
    get_dynamodb_resource().Table("Sessions").delete_item(Key={"session_id": session_id})

    if reset_wallet:
        try:
            from app.services.wallet_service import delete_entry
            delete_entry(user_id, date)
        except Exception:
            logger.exception("Error deleting wallet entry for user=%s date=%s", user_id, date)

    logger.info("Cascade delete complete for session %s", session_id)
