"""Durable end-of-day settlement for stopped desktop Paper sessions."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from app.models.schemas import TradeSide
from app.services import paper_wallet, simulation, trading
from app.services.db import get_dynamodb_resource

logger = logging.getLogger(__name__)
_CLOSE = "15:09:00"
_QUOTE_START = "15:04:00"
_QUOTE_END = "15:14:00"


def _clock(date: str, value: str) -> int:
    # Market data deliberately encodes IST wall time as UTC; match that convention.
    return int(datetime.strptime(f"{date} {value}", "%Y-%m-%d %H:%M:%S")
        .replace(tzinfo=timezone.utc).timestamp())


def _due(date: str) -> bool:
    now = datetime.now(ZoneInfo("Asia/Kolkata"))
    return date < now.date().isoformat() or (date == now.date().isoformat() and now.strftime("%H:%M:%S") >= _CLOSE)


def _open_contracts(session) -> list[tuple[str, str | None, int | None, str | None, object]]:
    from types import SimpleNamespace
    quantities: dict[tuple, int] = {}
    for trade in trading.get_trades(session.session_id):
        key = (trade.symbol, trade.right, trade.strike, trade.expiry)
        quantities[key] = quantities.get(key, 0) + (trade.quantity if trade.side == TradeSide.BUY else -trade.quantity)
    result = []
    for (symbol, right, strike, expiry), net in sorted(quantities.items(), key=lambda item: str(item[0])):
        if net:
            position = SimpleNamespace(side="LONG" if net > 0 else "SHORT", quantity=abs(net))
            result.append((symbol, right, strike, expiry, position))
    return result


def _near_close_quote(session, symbol: str, right: str | None, strike: int | None, expiry: str | None):
    if right:
        if strike is None or not expiry:
            return None
        from app.services.options_service import fetch_options_historical, options_iter_ticks
        fetch_options_historical(symbol, session.date, strike, expiry, right)
        ticks = options_iter_ticks(symbol, session.date, strike, expiry, right, _QUOTE_START)
    else:
        from app.services.broker_service import fetch_historical
        from app.services.data_loader import iter_ticks
        fetch_historical(symbol, session.date)
        ticks = iter_ticks(symbol, session.date, _QUOTE_START)
    close = _clock(session.date, _CLOSE)
    end = _clock(session.date, _QUOTE_END)
    choices = [tick for tick in ticks if close - 300 <= int(tick["time"]) <= end and float(tick["close"]) > 0]
    if not choices:
        return None
    tick = min(choices, key=lambda item: (abs(int(item["time"]) - close), int(item["time"]) > close))
    return {"price": Decimal(str(tick["close"])), "timestamp": int(tick["time"]),
        "source": "historical_close", "right": right or "equity", "strike": strike or 0, "expiry": expiry or ""}


def _chosen_quote(session, symbol: str, right: str | None, strike: int | None, expiry: str | None):
    contract = f"{symbol}:{expiry or '-'}:{strike or 0}:{right or 'EQ'}"
    key = {"user_id": session.user_id,
        "ledger_id": f"paper:{session.date}:eod:{session.session_id}:{contract}"}
    table = paper_wallet._table()
    existing = table.get_item(Key=key, ConsistentRead=True).get("Item")
    if existing:
        return existing
    quote = _near_close_quote(session, symbol, right, strike, expiry)
    if quote is None:
        return None
    try:
        table.put_item(Item={**key, **quote}, ConditionExpression="attribute_not_exists(user_id)")
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    return table.get_item(Key=key, ConsistentRead=True).get("Item")


def reconcile_session(record: dict) -> bool:
    """Return True when all positions are settled or none remain."""
    if record.get("desktop_origin") != "desktop_paper" or not _due(record["date"]):
        return False
    user_id, date, symbol, session_id = (record[key] for key in ("user_id", "date", "symbol", "session_id"))
    claim = paper_wallet.session_claim(user_id, date, symbol)
    if not claim or claim.get("session_id") != session_id or claim.get("session_status") == "settled":
        return bool(claim and claim.get("session_status") == "settled")
    if claim.get("session_status") != "stopped":
        return False
    if int(claim.get("settlement_retry_after") or 0) > int(time.time()):
        return False
    from app.routers.desktop_trading import _reconcile_saved_paper
    claim = _reconcile_saved_paper(record, claim)
    if claim.get("cleanup_pending"):
        return False
    token = str(uuid.uuid4())
    table = paper_wallet._table()
    key = {"user_id": user_id, "ledger_id": f"paper:{date}:session:{symbol}"}
    try:
        table.update_item(Key=key,
            UpdateExpression="SET settlement_token = :token, settlement_until = :until",
            ConditionExpression="session_id = :session AND session_status = :stopped AND "
                "(attribute_not_exists(settlement_until) OR settlement_until < :now)",
            ExpressionAttributeValues={":token": token, ":until": int(time.time()) + 120,
                ":now": int(time.time()), ":session": session_id, ":stopped": "stopped"})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    try:
        session = simulation.rebuild_session_from_db(record, user_id, read_only=True)
        pending = False
        for contract_symbol, right, strike, expiry, position in _open_contracts(session):
            try:
                quote = _chosen_quote(session, contract_symbol, right, strike, expiry)
            except Exception:
                logger.exception("desktop_paper_eod_quote_failed session_id=%s contract=%s/%s/%s", session_id, right, strike, expiry)
                quote = None
            if quote is None:
                pending = True
                continue
            side = TradeSide.SELL if position.side == "LONG" else TradeSide.BUY
            identity = f"eod:{session_id}:{contract_symbol}:{expiry or '-'}:{strike or 0}:{right or 'EQ'}"
            trading.settle_wallet_for_trade(session, side, float(quote["price"]), position.quantity,
                right=right, strike=strike, expiry=expiry, operation_id=identity)
            from app.services.execution_analytics import snapshot
            trading.record_trade(session_id, side, float(quote["price"]), int(quote["timestamp"]),
                quantity=position.quantity, symbol=contract_symbol,
                instrument_type="options" if right else session.instrument_type, strike=strike,
                expiry=expiry, right=right, brokerage_per_order=session.brokerage_per_order,
                user_id=user_id, session_type="paper", source="desktop_paper", trade_id=identity,
                analytics=snapshot(session, quantity=position.quantity, price=float(quote["price"]), side=side.value, exit_method="EOD_CLOSE", action_id=identity))
        table.update_item(Key=key, UpdateExpression="SET settlement_pending = :pending, settlement_retry_after = :retry",
            ConditionExpression="settlement_token = :token AND session_status = :stopped",
            ExpressionAttributeValues={":pending": pending, ":retry": int(time.time()) + 60 if pending else 0,
                ":token": token, ":stopped": "stopped"})
        if not pending:
            paper_wallet.settle_desktop_session(user_id, date, symbol, session_id)
        return not pending
    finally:
        try:
            table.update_item(Key=key, UpdateExpression="REMOVE settlement_token, settlement_until",
                ConditionExpression="settlement_token = :token",
                ExpressionAttributeValues={":token": token})
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                logger.exception("Could not release Paper settlement lock for %s", session_id)


def reconcile_due_sessions() -> None:
    """Run after restart and periodically; conditional locks make workers safe."""
    table = get_dynamodb_resource().Table("Sessions")
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    params = {"FilterExpression": Attr("desktop_origin").eq("desktop_paper") & Attr("date").lte(today)}
    while True:
        page = table.scan(**params)
        for record in page.get("Items", []):
            if _due(record["date"]):
                try:
                    reconcile_session(record)
                except Exception:
                    logger.exception("desktop_paper_eod_reconcile_failed session_id=%s", record.get("session_id"))
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]


async def reconciliation_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(reconcile_due_sessions)
        except Exception:
            logger.exception("desktop_paper_eod_scan_failed")
        await asyncio.sleep(300)
