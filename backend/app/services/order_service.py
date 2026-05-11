"""
Order service: in-memory LIMIT and TARGET (stop-limit) orders with DynamoDB persistence.

TARGET: user supplies trigger_price; limit auto-set at 1% deviation.
        BUY fills when price >= trigger; SELL fills when price <= trigger.
LIMIT:  user supplies limit_price directly; no deviation.
        BUY fills when price <= limit;   SELL fills when price >= limit.
"""
from __future__ import annotations

import logging
from decimal import Decimal

from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.config import FIXED_USER_ID

logger = logging.getLogger(__name__)

# {session_id: {order_id: Order}}
_orders: dict[str, dict[str, Order]] = {}

_TARGET_DEVIATION = 0.01  # 1% buffer for stop-limit orders


def _ensure_session(session_id: str) -> None:
    if session_id not in _orders:
        _orders[session_id] = {}


def _target_limit_price(side: TradeSide, trigger_price: float) -> float:
    if side == TradeSide.BUY:
        return round(trigger_price * (1 + _TARGET_DEVIATION), 2)
    return round(trigger_price * (1 - _TARGET_DEVIATION), 2)


def _write_order_to_db(order: Order) -> None:
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Orders")
        item: dict = {
            "session_id": order.session_id,
            "order_id": order.order_id,
            "user_id": order.user_id,
            "symbol": order.symbol,
            "side": order.side.value,
            "order_type": order.order_type.value,
            "quantity": order.quantity,
            "trigger_price": Decimal(str(order.trigger_price)),
            "limit_price": Decimal(str(order.limit_price)),
            "status": order.status.value,
            "created_at": order.created_at,
        }
        if order.filled_at is not None:
            item["filled_at"] = order.filled_at
        if order.filled_price is not None:
            item["filled_price"] = Decimal(str(order.filled_price))
        table.put_item(Item=item)
    except Exception:
        logger.exception("DynamoDB write failed for order %s", order.order_id)


def place_order(
    session_id: str,
    symbol: str,
    side: TradeSide,
    order_type: OrderType,
    quantity: int,
    created_at: int,
    trading_date: str,
    trigger_price: float | None = None,
    limit_price: float | None = None,
) -> Order:
    _ensure_session(session_id)

    if order_type == OrderType.TARGET:
        if trigger_price is None:
            raise ValueError("trigger_price is required for TARGET orders")
        actual_trigger = trigger_price
        actual_limit = _target_limit_price(side, trigger_price)
    else:  # LIMIT
        if limit_price is None:
            raise ValueError("limit_price is required for LIMIT orders")
        actual_trigger = limit_price   # stored for schema consistency
        actual_limit = limit_price

    # Debit wallet for BUY orders; SELL orders don't require upfront funds
    reserved_amount = 0.0
    if side == TradeSide.BUY:
        reserved_amount = round(quantity * actual_limit, 2)
        from app.services.wallet_service import debit
        debit(FIXED_USER_ID, reserved_amount, trading_date)

    order = Order(
        session_id=session_id,
        user_id=FIXED_USER_ID,
        symbol=symbol,
        side=side,
        order_type=order_type,
        quantity=quantity,
        trigger_price=actual_trigger,
        limit_price=actual_limit,
        status=OrderStatus.PENDING,
        created_at=created_at,
        reserved_amount=reserved_amount,
    )
    _orders[session_id][order.order_id] = order
    _write_order_to_db(order)
    return order


def get_open_orders(session_id: str) -> list[Order]:
    return [
        o for o in _orders.get(session_id, {}).values()
        if o.status == OrderStatus.PENDING
    ]


def get_all_orders(session_id: str) -> list[Order]:
    return list(_orders.get(session_id, {}).values())


def cancel_order(session_id: str, order_id: str, trading_date: str) -> Order | None:
    order = _orders.get(session_id, {}).get(order_id)
    if order is None or order.status != OrderStatus.PENDING:
        return None
    order.status = OrderStatus.CANCELLED
    # Credit back the reserved funds for cancelled BUY orders
    if order.side == TradeSide.BUY and order.reserved_amount > 0:
        from app.services.wallet_service import credit
        credit(FIXED_USER_ID, order.reserved_amount, trading_date)
    _write_order_to_db(order)
    return order


def check_orders(session_id: str, current_price: float, current_time: int, trading_date: str = "") -> list[Order]:
    """
    Evaluate all PENDING orders against current_price and return newly FILLED ones.

    TARGET — BUY: price >= trigger_price  |  SELL: price <= trigger_price
    LIMIT  — BUY: price <= limit_price    |  SELL: price >= limit_price
    """
    filled: list[Order] = []
    for order in _orders.get(session_id, {}).values():
        if order.status != OrderStatus.PENDING:
            continue

        if order.order_type == OrderType.TARGET:
            triggered = (
                order.side == TradeSide.BUY and current_price >= order.trigger_price
            ) or (
                order.side == TradeSide.SELL and current_price <= order.trigger_price
            )
        else:  # LIMIT
            triggered = (
                order.side == TradeSide.BUY and current_price <= order.limit_price
            ) or (
                order.side == TradeSide.SELL and current_price >= order.limit_price
            )

        if triggered:
            order.status = OrderStatus.FILLED
            order.filled_at = current_time
            order.filled_price = current_price
            # Credit wallet when a SELL order fills (realises proceeds)
            if order.side == TradeSide.SELL and trading_date:
                from app.services.wallet_service import credit
                credit(FIXED_USER_ID, round(order.quantity * current_price, 2), trading_date)
            _write_order_to_db(order)
            filled.append(order)
    return filled


def clear_session(session_id: str) -> None:
    _orders.pop(session_id, None)
