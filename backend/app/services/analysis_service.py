"""
Trade analysis service: queries Sessions and Trades from DynamoDB to produce
per-session P&L summaries for the Trade Analysis screen.
"""
from __future__ import annotations

import logging
from decimal import Decimal

logger = logging.getLogger(__name__)


def _safe_float(val) -> float:
    if isinstance(val, Decimal):
        return float(val)
    return float(val) if val is not None else 0.0


def get_sessions_for_user(
    user_id: str,
    symbol: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    instrument_type: str | None = None,
    session_type: str | None = None,
) -> list[dict]:
    """
    Return sessions for a user, optionally filtered by symbol, date range,
    and instrument type. Results are sorted newest-first.
    """
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        table = get_dynamodb_resource().Table("Sessions")
        resp = table.query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
        )
        items = resp.get("Items", [])

        if symbol:
            items = [s for s in items if s.get("symbol") == symbol]
        if start_date:
            items = [s for s in items if s.get("date", "") >= start_date]
        if end_date:
            items = [s for s in items if s.get("date", "") <= end_date]
        if instrument_type:
            items = [s for s in items if s.get("instrument_type") == instrument_type]
        if session_type:
            items = [s for s in items if s.get("session_type", "sim") == session_type]

        return sorted(items, key=lambda s: (s.get("date", ""), s.get("session_id", "")), reverse=True)
    except Exception:
        logger.exception("Failed to query sessions for user %s", user_id)
        return []


def get_trades_for_session(session_id: str) -> list[dict]:
    """Return all trades for a session from DynamoDB."""
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        table = get_dynamodb_resource().Table("Trades")
        resp = table.query(
            KeyConditionExpression=Key("session_id").eq(session_id),
        )
        items = resp.get("Items", [])
        return sorted(items, key=lambda t: int(t.get("timestamp", 0)))
    except Exception:
        logger.exception("Failed to query trades for session %s", session_id)
        return []


def compute_session_summary(session: dict, trades: list[dict]) -> dict:
    """
    Given a session record and its trades, compute P&L metrics.

    Net realized P&L = sum(SELL proceeds) - sum(BUY costs) - sum(commission)
    P&L % = net P&L / session_capital * 100  (if session_capital > 0)
    """
    session_capital = _safe_float(session.get("session_capital", 0))

    buy_cost = sum(
        _safe_float(t.get("price")) * int(t.get("quantity", 1))
        for t in trades if t.get("side") == "BUY"
    )
    sell_proceeds = sum(
        _safe_float(t.get("price")) * int(t.get("quantity", 1))
        for t in trades if t.get("side") == "SELL"
    )
    total_commission = sum(_safe_float(t.get("commission", 0)) for t in trades)

    net_pnl = sell_proceeds - buy_cost - total_commission
    pnl_pct = (net_pnl / session_capital * 100) if session_capital > 0 else 0.0

    buy_count = sum(1 for t in trades if t.get("side") == "BUY")
    sell_count = sum(1 for t in trades if t.get("side") == "SELL")

    return {
        "session_id": session.get("session_id"),
        "user_id": session.get("user_id"),
        "symbol": session.get("symbol"),
        "date": session.get("date"),
        "start_time": session.get("start_time"),
        "instrument_type": session.get("instrument_type", "equity"),
        "session_type": session.get("session_type", "sim"),
        "strike": session.get("strike"),
        "expiry": session.get("expiry"),
        "session_capital": round(session_capital, 2),
        "net_pnl": round(net_pnl, 2),
        "pnl_pct": round(pnl_pct, 4),
        "total_commission": round(total_commission, 4),
        "trade_count": len(trades),
        "buy_count": buy_count,
        "sell_count": sell_count,
    }


def get_session_summary_with_trades(session_id: str) -> dict | None:
    """Return a full session summary including trades list."""
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Sessions")
        resp = table.get_item(Key={"session_id": session_id})
        session = resp.get("Item")
        if not session:
            return None
        trades = get_trades_for_session(session_id)
        summary = compute_session_summary(session, trades)
        summary["trades"] = [_serialize_trade(t) for t in trades]
        return summary
    except Exception:
        logger.exception("Failed to get session summary for %s", session_id)
        return None


def _serialize_trade(t: dict) -> dict:
    return {
        "trade_id": t.get("trade_id", ""),
        "session_id": t.get("session_id", ""),
        "user_id": t.get("user_id", ""),
        "symbol": t.get("symbol", ""),
        "side": t.get("side", ""),
        "quantity": int(t.get("quantity", 1)),
        "price": _safe_float(t.get("price")),
        "timestamp": int(t.get("timestamp", 0)),
        "instrument_type": t.get("instrument_type", "equity"),
        "right": t.get("right"),
        "strike": int(t.get("strike")) if t.get("strike") is not None else None,
        "expiry": t.get("expiry"),
        "commission": _safe_float(t.get("commission", 0)),
    }
