"""
In-memory trading service for Phase-I.
Stores trades per session; computes position and P&L.
"""
from __future__ import annotations

from typing import Literal
from app.models.schemas import Trade, TradeSide, Position
from app.config import PLACEHOLDER_USER_ID, DEFAULT_SYMBOL

# {session_id: [Trade, ...]}
_trades: dict[str, list[Trade]] = {}


def ensure_session(session_id: str) -> None:
    if session_id not in _trades:
        _trades[session_id] = []


def record_trade(
    session_id: str,
    side: TradeSide,
    price: float,
    timestamp: int,
    quantity: int = 1,
    symbol: str = DEFAULT_SYMBOL,
) -> Trade:
    ensure_session(session_id)
    trade = Trade(
        user_id=PLACEHOLDER_USER_ID,
        symbol=symbol,
        side=side,
        quantity=quantity,
        price=price,
        timestamp=timestamp,
        session_id=session_id,
    )
    _trades[session_id].append(trade)
    return trade


def get_trades(session_id: str) -> list[Trade]:
    return _trades.get(session_id, [])


def get_position(session_id: str, symbol: str | None = None) -> Position:
    trades = _trades.get(session_id, [])
    # If symbol not provided, infer from the first recorded trade
    if symbol is None:
        symbol = trades[0].symbol if trades else DEFAULT_SYMBOL
    symbol_trades = [t for t in trades if t.symbol == symbol]

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
