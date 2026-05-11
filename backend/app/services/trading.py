"""
Trading service: in-memory store (source of truth) with async DynamoDB persistence.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Literal

from app.models.schemas import Trade, TradeSide, Position
from app.config import FIXED_USER_ID, DEFAULT_SYMBOL

logger = logging.getLogger(__name__)

# {session_id: [Trade, ...]}
_trades: dict[str, list[Trade]] = {}


def ensure_session(session_id: str) -> None:
    if session_id not in _trades:
        _trades[session_id] = []


def _write_trade_to_db(trade: Trade) -> None:
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Trades")
        item: dict = {
            "session_id": trade.session_id,
            "trade_id": trade.trade_id,
            "user_id": trade.user_id,
            "symbol": trade.symbol,
            "side": trade.side.value,
            "quantity": trade.quantity,
            "price": Decimal(str(trade.price)),
            "timestamp": trade.timestamp,
            "instrument_type": trade.instrument_type,
        }
        if trade.instrument_type == "options":
            if trade.strike is not None:
                item["strike"] = trade.strike
            if trade.expiry is not None:
                item["expiry"] = trade.expiry
            if trade.right is not None:
                item["right"] = trade.right
        table.put_item(Item=item)
    except Exception:
        logger.exception("DynamoDB write failed for trade %s", trade.trade_id)


def record_trade(
    session_id: str,
    side: TradeSide,
    price: float,
    timestamp: int,
    quantity: int = 1,
    symbol: str = DEFAULT_SYMBOL,
    instrument_type: str = "equity",
    strike: int | None = None,
    expiry: str | None = None,
    right: str | None = None,
) -> Trade:
    ensure_session(session_id)
    trade = Trade(
        user_id=FIXED_USER_ID,
        symbol=symbol,
        side=side,
        quantity=quantity,
        price=price,
        timestamp=timestamp,
        session_id=session_id,
        instrument_type=instrument_type,
        strike=strike,
        expiry=expiry,
        right=right,
    )
    _trades[session_id].append(trade)
    _write_trade_to_db(trade)
    return trade


def get_trades(session_id: str) -> list[Trade]:
    return _trades.get(session_id, [])


def get_position(session_id: str, symbol: str | None = None, right: str | None = None) -> Position:
    trades = _trades.get(session_id, [])
    if symbol is None:
        symbol = trades[0].symbol if trades else DEFAULT_SYMBOL
    # For options: filter by right so CE and PE positions are tracked independently.
    # right=None matches equity trades (those with right=None on the trade record).
    symbol_trades = [t for t in trades if t.symbol == symbol and t.right == right]

    net_qty = 0
    total_buy_value = 0.0
    total_buy_qty = 0

    for t in symbol_trades:
        if t.side == TradeSide.BUY:
            net_qty += t.quantity
            total_buy_value += t.price * t.quantity
            total_buy_qty += t.quantity
        else:
            net_qty -= t.quantity

    if net_qty > 0:
        side: Literal["LONG", "SHORT", "FLAT"] = "LONG"
        avg_entry = total_buy_value / total_buy_qty if total_buy_qty > 0 else 0.0
    elif net_qty < 0:
        side = "SHORT"
        # For short positions avg_entry is the avg sell price — compute separately
        sell_trades = [t for t in symbol_trades if t.side == TradeSide.SELL]
        total_sell_value = sum(t.price * t.quantity for t in sell_trades)
        total_sell_qty = sum(t.quantity for t in sell_trades)
        avg_entry = total_sell_value / total_sell_qty if total_sell_qty > 0 else 0.0
    else:
        side = "FLAT"
        avg_entry = 0.0

    return Position(
        symbol=symbol,
        quantity=abs(net_qty),
        avg_entry_price=round(avg_entry, 2),
        side=side,
    )


def clear_session(session_id: str) -> None:
    _trades.pop(session_id, None)
