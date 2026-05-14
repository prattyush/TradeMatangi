"""
Order service: in-memory LIMIT, TARGET (stop-limit), and STOPLOSS orders with DynamoDB persistence.

TARGET:   user supplies trigger_price; limit auto-set at 1% deviation.
          BUY fills when price >= trigger; SELL fills when price <= trigger.
LIMIT:    user supplies limit_price directly; no deviation.
          BUY fills when price <= limit; SELL fills when price >= limit.
STOPLOSS: same trigger logic as TARGET; limit = trigger (no deviation).
          No wallet debit on placement; no wallet credit on fill.
"""
from __future__ import annotations

import logging
import math
from decimal import Decimal

from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.config import FIXED_USER_ID, LOT_SIZES
from app.services.wallet_service import InsufficientFundsError

logger = logging.getLogger(__name__)

# {session_id: {order_id: Order}}
_orders: dict[str, dict[str, Order]] = {}

_TARGET_DEVIATION = 0.01  # 1% buffer for stop-limit orders


def _ensure_session(session_id: str) -> None:
    if session_id not in _orders:
        _orders[session_id] = {}


def _target_limit_price(side: TradeSide, trigger_price: float, deviation: float = _TARGET_DEVIATION) -> float:
    if side == TradeSide.BUY:
        return round(trigger_price * (1 + deviation), 2)
    return round(trigger_price * (1 - deviation), 2)


def compute_funds_ratio_quantity(
    symbol: str,
    price: float,
    session_capital: float,
    funds_ratio_pct: float,
    current_wallet: float,
    lot_size: int = 1,
) -> int:
    """
    Compute order quantity from a FundsRatio percentage of session capital.

    lot_size=1 for equity (default); pass actual lot size for options/futures.
    Raises InsufficientFundsError if wallet cannot afford even 1 unit/lot.
    """
    spend = session_capital * funds_ratio_pct

    if lot_size > 1:
        unit_cost = price * lot_size
        lots = int(spend / unit_cost)
        if lots < 1:
            if current_wallet >= unit_cost:
                lots = 1
            else:
                raise InsufficientFundsError(current_wallet, unit_cost)
        return lots * lot_size
    else:
        qty = int(spend / price) if price > 0 else 0
        if qty < 1:
            if current_wallet >= price:
                qty = 1
            else:
                raise InsufficientFundsError(current_wallet, price)
        return qty


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
            "is_stoploss": order.is_stoploss,
        }
        if order.filled_at is not None:
            item["filled_at"] = order.filled_at
        if order.filled_price is not None:
            item["filled_price"] = Decimal(str(order.filled_price))
        if order.right is not None:
            item["right"] = order.right
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
    is_stoploss: bool = False,
    right: str | None = None,
    target_deviation_pct: float = _TARGET_DEVIATION,
) -> Order:
    _ensure_session(session_id)

    if order_type == OrderType.TARGET:
        if trigger_price is None:
            raise ValueError("trigger_price is required for TARGET orders")
        actual_trigger = trigger_price
        actual_limit = _target_limit_price(side, trigger_price, target_deviation_pct)
    elif order_type == OrderType.STOPLOSS:
        if trigger_price is None:
            raise ValueError("trigger_price is required for STOPLOSS orders")
        actual_trigger = trigger_price
        actual_limit = trigger_price  # fill at market (no deviation for SL)
    else:  # LIMIT
        if limit_price is None:
            raise ValueError("limit_price is required for LIMIT orders")
        actual_trigger = limit_price   # stored for schema consistency
        actual_limit = limit_price

    # SL orders never debit wallet; regular BUY orders reserve funds upfront
    reserved_amount = 0.0
    if side == TradeSide.BUY and not is_stoploss and order_type != OrderType.STOPLOSS:
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
        is_stoploss=is_stoploss,
        right=right,
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
    # Credit back the reserved funds for cancelled regular BUY orders (not SL)
    if order.side == TradeSide.BUY and order.reserved_amount > 0 and not order.is_stoploss:
        from app.services.wallet_service import credit
        credit(FIXED_USER_ID, order.reserved_amount, trading_date)
    _write_order_to_db(order)
    return order


def update_order(
    session_id: str,
    order_id: str,
    trading_date: str,
    trigger_price: float | None = None,
    limit_price: float | None = None,
    target_deviation_pct: float = _TARGET_DEVIATION,
) -> Order | None:
    """Update trigger/limit price of a PENDING order. Handles wallet re-reservation for BUY orders."""
    order = _orders.get(session_id, {}).get(order_id)
    if order is None or order.status != OrderStatus.PENDING:
        return None

    if order.order_type == OrderType.TARGET and trigger_price is not None:
        new_trigger = trigger_price
        new_limit = _target_limit_price(order.side, trigger_price, target_deviation_pct)
        if order.side == TradeSide.BUY and not order.is_stoploss:
            new_reserved = round(order.quantity * new_limit, 2)
            diff = new_reserved - order.reserved_amount
            from app.services.wallet_service import credit, debit
            if diff > 0:
                debit(FIXED_USER_ID, diff, trading_date)
            elif diff < 0:
                credit(FIXED_USER_ID, -diff, trading_date)
            order.reserved_amount = new_reserved
        order.trigger_price = new_trigger
        order.limit_price = new_limit

    elif order.order_type == OrderType.LIMIT and limit_price is not None:
        new_limit = limit_price
        if order.side == TradeSide.BUY and not order.is_stoploss:
            new_reserved = round(order.quantity * new_limit, 2)
            diff = new_reserved - order.reserved_amount
            from app.services.wallet_service import credit, debit
            if diff > 0:
                debit(FIXED_USER_ID, diff, trading_date)
            elif diff < 0:
                credit(FIXED_USER_ID, -diff, trading_date)
            order.reserved_amount = new_reserved
        order.limit_price = new_limit
        order.trigger_price = new_limit

    elif order.order_type == OrderType.STOPLOSS and trigger_price is not None:
        order.trigger_price = trigger_price
        order.limit_price = trigger_price

    _write_order_to_db(order)
    return order


def check_orders(
    session_id: str,
    current_price: float,
    current_time: int,
    trading_date: str = "",
    tick_right: str | None = None,
) -> list[Order]:
    """
    Evaluate PENDING orders against current_price and return newly FILLED ones.

    tick_right: for options dual-stream, only evaluate orders whose right matches
                the tick's right. None means equity (match orders with right=None).

    TARGET   — BUY: price >= trigger_price  |  SELL: price <= trigger_price
    STOPLOSS — BUY: price >= trigger_price  |  SELL: price <= trigger_price  (same logic, no wallet)
    LIMIT    — BUY: price <= limit_price    |  SELL: price >= limit_price
    """
    filled: list[Order] = []
    for order in _orders.get(session_id, {}).values():
        if order.status != OrderStatus.PENDING:
            continue
        # For options ticks: only check orders for the same contract (right).
        # For equity ticks (tick_right=None): only check orders with right=None.
        if order.right != tick_right:
            continue

        if order.order_type in (OrderType.TARGET, OrderType.STOPLOSS):
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
            # Credit wallet on regular SELL fill; SL orders skip wallet entirely
            if order.side == TradeSide.SELL and trading_date and not order.is_stoploss:
                from app.services.wallet_service import credit
                credit(FIXED_USER_ID, round(order.quantity * current_price, 2), trading_date)
            _write_order_to_db(order)
            filled.append(order)
    return filled


def clear_session(session_id: str) -> None:
    _orders.pop(session_id, None)
