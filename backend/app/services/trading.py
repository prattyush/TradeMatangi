"""
Trading service: in-memory store (source of truth) with async DynamoDB persistence.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Literal

from app.models.schemas import Trade, TradeSide, Position
from app.config import FIXED_USER_ID, DEFAULT_SYMBOL  # FIXED_USER_ID kept for default arg

logger = logging.getLogger(__name__)

# {session_id: [Trade, ...]}
_trades: dict[str, list[Trade]] = {}


def ensure_session(session_id: str) -> None:
    if session_id not in _trades:
        _trades[session_id] = []


def compute_commission(side: TradeSide, price: float, quantity: int, brokerage_per_order: float = 1.0) -> float:
    """
    Compute total commission for one order.

    Exchange charges (ICICI Direct / Indian markets):
      BUY:  STT 0.006803% of order value
      SELL: STT 0.0625% + (exchange txn charge 0.06% × 1.18 GST) of order value
    Plus flat brokerage per order.
    """
    total_value = price * quantity
    if side == TradeSide.BUY:
        charges = total_value * 0.006803 / 100
    else:
        charges = total_value * 0.0625 / 100 + 1.18 * (0.06 / 100) * total_value
    return round(charges + brokerage_per_order, 4)


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
            "commission": Decimal(str(trade.commission)),
        }
        if trade.underlying_price is not None:
            item["underlying_price"] = Decimal(str(trade.underlying_price))

        if trade.instrument_type == "options":
            if trade.strike is not None:
                item["strike"] = trade.strike
            if trade.expiry is not None:
                item["expiry"] = trade.expiry
            if trade.right is not None:
                item["right"] = trade.right
        item["session_type"] = trade.session_type
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
    brokerage_per_order: float = 1.0,
    user_id: str = FIXED_USER_ID,
    session_type: str = "sim",
) -> Trade:
    ensure_session(session_id)

    # Automatically lookup underlying price if it is an options trade
    underlying_price = None
    if instrument_type == "options":
        # 1. Try to get it from an active in-memory session (Paper/Real/Live Sim)
        try:
            from app.services import simulation as sim_svc
            session = sim_svc.get_session(session_id)
            if session and session.last_price > 0:
                underlying_price = session.last_price
        except Exception:
            pass

        # 2. Fallback to parquet lookup (Historical Sim / Import / Offline)
        if underlying_price is None:
            try:
                from app.services.options_service import get_underlying_price_at
                from datetime import datetime
                dt = datetime.fromtimestamp(timestamp)
                date_str = dt.strftime("%Y-%m-%d")
                underlying_price = get_underlying_price_at(symbol, date_str, timestamp)
            except Exception:
                logger.debug("Automatic underlying price lookup failed for %s at %s", symbol, timestamp)

    trade = Trade(
        user_id=user_id,
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
        commission=compute_commission(side, price, quantity, brokerage_per_order),
        session_type=session_type,
        underlying_price=underlying_price,
    )
    _trades[session_id].append(trade)
    _write_trade_to_db(trade)
    try:
        from app.services.guardrail_service import on_trade_record
        on_trade_record(session_id)
    except Exception:
        logger.debug("guardrail on_trade_record skipped for session %s", session_id)
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

    # FIFO matching: only lots that are still open contribute to avg_entry and entry_commission.
    # Without FIFO, a closed trade followed by a new entry would dilute avg_entry
    # with already-realised lots (e.g. buy@100 → sell@90 → buy@85 → avg shown as 92.5
    # instead of the correct 85).
    # Each queue entry: (price, qty, commission_per_unit) so commission is apportioned
    # correctly when a trade is only partially consumed by the opposite side.
    from collections import deque
    buy_queue: deque = deque()   # (price, qty, comm_per_unit) open long lots
    sell_queue: deque = deque()  # (price, qty, comm_per_unit) open short lots
    net_qty = 0

    for t in symbol_trades:
        remaining = t.quantity
        comm_per_unit = (t.commission / t.quantity) if t.quantity > 0 else 0.0
        if t.side == TradeSide.BUY:
            net_qty += t.quantity
            # Consume any open short lots first (covers a short)
            while remaining > 0 and sell_queue:
                s_price, s_qty, s_cpu = sell_queue[0]
                matched = min(remaining, s_qty)
                remaining -= matched
                if matched == s_qty:
                    sell_queue.popleft()
                else:
                    sell_queue[0] = (s_price, s_qty - matched, s_cpu)
            if remaining > 0:
                buy_queue.append((t.price, remaining, comm_per_unit))
        else:  # SELL
            net_qty -= t.quantity
            # Consume open long lots first (closes a long)
            while remaining > 0 and buy_queue:
                b_price, b_qty, b_cpu = buy_queue[0]
                matched = min(remaining, b_qty)
                remaining -= matched
                if matched == b_qty:
                    buy_queue.popleft()
                else:
                    buy_queue[0] = (b_price, b_qty - matched, b_cpu)
            if remaining > 0:
                sell_queue.append((t.price, remaining, comm_per_unit))

    if net_qty > 0:
        side: Literal["LONG", "SHORT", "FLAT"] = "LONG"
        total_qty = sum(q for _, q, _ in buy_queue)
        avg_entry = sum(p * q for p, q, _ in buy_queue) / total_qty if total_qty > 0 else 0.0
        entry_commission = round(sum(cpu * q for _, q, cpu in buy_queue), 4)
    elif net_qty < 0:
        side = "SHORT"
        total_qty = sum(q for _, q, _ in sell_queue)
        avg_entry = sum(p * q for p, q, _ in sell_queue) / total_qty if total_qty > 0 else 0.0
        entry_commission = round(sum(cpu * q for _, q, cpu in sell_queue), 4)
    else:
        side = "FLAT"
        avg_entry = 0.0
        entry_commission = 0.0

    return Position(
        symbol=symbol,
        quantity=abs(net_qty),
        avg_entry_price=round(avg_entry, 2),
        side=side,
        entry_commission=entry_commission,
    )


def clear_session(session_id: str) -> None:
    _trades.pop(session_id, None)


def reload_trades_from_db(session_id: str) -> None:
    """Repopulate in-memory _trades from DynamoDB when a paper/real session is resumed.

    Called by rebuild_session_from_db so that position checks, trade history,
    and Day P&L all reflect trades taken in earlier restarts of the same session.
    """
    try:
        from app.services.analysis_service import get_trades_for_session
        raw = get_trades_for_session(session_id)
        trades: list[Trade] = []
        for item in raw:
            try:
                trades.append(Trade(
                    trade_id=str(item["trade_id"]),
                    user_id=str(item["user_id"]),
                    symbol=str(item["symbol"]),
                    side=TradeSide(item["side"]),
                    quantity=int(item["quantity"]),
                    price=float(item["price"]),
                    timestamp=int(item["timestamp"]),
                    session_id=str(item["session_id"]),
                    instrument_type=str(item.get("instrument_type", "equity")),
                    strike=int(item["strike"]) if item.get("strike") is not None else None,
                    expiry=item.get("expiry"),
                    right=item.get("right"),
                    commission=float(item.get("commission", 0)),
                    session_type=str(item.get("session_type", "paper")),
                    underlying_price=float(item.get("underlying_price")) if item.get("underlying_price") is not None else None,
                ))
            except Exception:
                logger.warning("Skipping malformed trade during reload for session %s: %s", session_id, item)
        _trades[session_id] = trades
        logger.info("reload_trades_from_db: loaded %d trades for session %s", len(trades), session_id)
    except Exception:
        logger.exception("reload_trades_from_db failed for session %s", session_id)
        _trades[session_id] = []
