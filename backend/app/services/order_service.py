"""
Order service: in-memory TARGET (stop-limit) orders with DynamoDB persistence.
Limit price is auto-set at 1% deviation from trigger.
"""
from __future__ import annotations

import logging
from decimal import Decimal

from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.config import PLACEHOLDER_USER_ID

logger = logging.getLogger(__name__)

# {session_id: {order_id: Order}}
_orders: dict[str, dict[str, Order]] = {}

_LIMIT_DEVIATION = 0.01  # 1%


def _ensure_session(session_id: str) -> None:
    if session_id not in _orders:
        _orders[session_id] = {}


def _limit_price_for(side: TradeSide, trigger_price: float) -> float:
    if side == TradeSide.BUY:
        return round(trigger_price * (1 + _LIMIT_DEVIATION), 2)
    return round(trigger_price * (1 - _LIMIT_DEVIATION), 2)


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
    trigger_price: float,
    quantity: int,
    created_at: int,
) -> Order:
    _ensure_session(session_id)
    order = Order(
        session_id=session_id,
        user_id=PLACEHOLDER_USER_ID,
        symbol=symbol,
        side=side,
        order_type=OrderType.TARGET,
        quantity=quantity,
        trigger_price=trigger_price,
        limit_price=_limit_price_for(side, trigger_price),
        status=OrderStatus.PENDING,
        created_at=created_at,
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


def cancel_order(session_id: str, order_id: str) -> Order | None:
    order = _orders.get(session_id, {}).get(order_id)
    if order is None or order.status != OrderStatus.PENDING:
        return None
    order.status = OrderStatus.CANCELLED
    _write_order_to_db(order)
    return order


def check_orders(session_id: str, current_price: float, current_time: int) -> list[Order]:
    """
    Evaluate all PENDING orders for the session against current_price.
    Returns the list of newly FILLED orders.
    Trigger condition: BUY triggers when price >= trigger, SELL when price <= trigger.
    """
    filled: list[Order] = []
    for order in _orders.get(session_id, {}).values():
        if order.status != OrderStatus.PENDING:
            continue
        triggered = (
            order.side == TradeSide.BUY and current_price >= order.trigger_price
        ) or (
            order.side == TradeSide.SELL and current_price <= order.trigger_price
        )
        if triggered:
            order.status = OrderStatus.FILLED
            order.filled_at = current_time
            order.filled_price = current_price
            _write_order_to_db(order)
            filled.append(order)
    return filled


def clear_session(session_id: str) -> None:
    _orders.pop(session_id, None)
