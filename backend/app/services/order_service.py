"""
Order service: in-memory LIMIT, TARGET (stop-limit), and STOPLOSS orders with DynamoDB persistence.

TARGET:   user supplies trigger_price; limit uses target deviation (account gap in real trading).
          BUY fills when price >= trigger; SELL fills when price <= trigger.
LIMIT:    user supplies limit_price directly; no deviation.
          BUY fills when price <= limit; SELL fills when price >= limit.
STOPLOSS: same trigger logic as TARGET; real limit uses the account stoploss gap.
          Simulation/paper retain limit = trigger.
          No wallet debit on placement; no wallet credit on fill.
"""
from __future__ import annotations

import threading
import logging
import math
import uuid
from decimal import Decimal

from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.config import FIXED_USER_ID, LOT_SIZES, MAX_CONTRACTS_PER_ORDER
from app.services.wallet_service import InsufficientFundsError

logger = logging.getLogger(__name__)

# {session_id: {order_id: Order}}
_orders: dict[str, dict[str, Order]] = {}

_TARGET_DEVIATION = 0.01  # 1% buffer for stop-limit orders


def get_max_contracts(symbol: str) -> int:
    """Return max contracts per order for the given symbol; unlimited for others."""
    symbol = "SENSEX" if symbol.upper() == "BSESEN" else symbol
    for prefix, limit in MAX_CONTRACTS_PER_ORDER.items():
        if symbol.upper().startswith(prefix):
            return limit
    return 10_000_000  # effectively unlimited


def split_quantity(symbol: str, qty: int) -> list[int]:
    """Split qty into chunks each <= max contracts for the symbol."""
    max_lot = get_max_contracts(symbol)
    if qty <= max_lot:
        return [qty]
    chunks = []
    remaining = qty
    while remaining > 0:
        chunk = min(remaining, max_lot)
        chunks.append(chunk)
        remaining -= chunk
    return chunks


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
    margin_rate: float = 1.0,
) -> int:
    """
    Compute order quantity from a FundsRatio percentage of session capital.

    lot_size=1 for equity (default); pass actual lot size for options/futures.
    Raises InsufficientFundsError if wallet cannot afford even 1 unit/lot.
    """
    spend = session_capital * funds_ratio_pct
    effective_margin_rate = margin_rate if margin_rate > 0 else 1.0
    buying_power = spend / effective_margin_rate

    if lot_size > 1:
        unit_cost = price * lot_size
        lots = int(buying_power / unit_cost)
        if lots < 1:
            if current_wallet >= unit_cost * effective_margin_rate:
                lots = 1
            else:
                raise InsufficientFundsError(current_wallet, unit_cost * effective_margin_rate)
        return lots * lot_size
    else:
        qty = int(buying_power / price) if price > 0 else 0
        if qty < 1:
            if margin_rate < 1:
                raise ValueError("Capital allocation cannot fund one whole share")
            if current_wallet >= price * effective_margin_rate:
                qty = 1
            else:
                raise InsufficientFundsError(current_wallet, price * effective_margin_rate)
        return qty


def compute_risk_ratio_quantity(
    symbol: str,
    entry_price: float,
    stoploss_price: float,
    session_capital: float,
    risk_ratio_pct: float,
    current_wallet: float,
    lot_size: int = 1,
    margin_rate: float = 1.0,
    allow_minimum_share_over_risk: bool = False,
) -> int:
    """
    Target a loss of risk_ratio_pct of session_capital at the stoploss.
    When the budget is smaller than one tradable unit, use one funded lot;
    callers can also allow one funded share for margin-backed equity.

    Formula:
        risk_amount = session_capital * risk_ratio_pct
        sl_distance = abs(entry_price - stoploss_price)
        quantity = floor(risk_amount / sl_distance)
    """
    sl_distance = abs(entry_price - stoploss_price)
    if sl_distance <= 0:
        raise ValueError("stoploss_price must differ from entry_price")

    risk_amount = session_capital * risk_ratio_pct
    effective_margin_rate = margin_rate if margin_rate > 0 else 1.0

    if lot_size > 1:
        loss_per_lot = sl_distance * lot_size
        lots = int(risk_amount / loss_per_lot)
        if lots < 1:
            unit_cost = entry_price * lot_size
            if current_wallet >= unit_cost * effective_margin_rate:
                lots = 1
            else:
                raise InsufficientFundsError(current_wallet, unit_cost * effective_margin_rate)
        return lots * lot_size
    else:
        qty = int(risk_amount / sl_distance)
        if qty < 1:
            if margin_rate < 1 and not allow_minimum_share_over_risk:
                raise ValueError("Risk budget cannot fund one whole share")
            if current_wallet >= entry_price * effective_margin_rate:
                qty = 1
            else:
                raise InsufficientFundsError(current_wallet, entry_price * effective_margin_rate)
        return qty


def _opening_quantity(session_id: str, symbol: str, side: TradeSide, quantity: int,
                      exclude_order_id: str | None = None) -> int:
    from app.services.trading import get_position
    position = get_position(session_id, symbol)
    opposite = "SHORT" if side == TradeSide.BUY else "LONG"
    closing = position.quantity if position.side == opposite else 0
    # A position cannot provide unreserved closing capacity to multiple entries.
    pending = sum(o.quantity for o in get_open_orders(session_id)
                  if o.order_id != exclude_order_id and o.right is None and o.side == side
                  and not o.is_stoploss)
    return max(0, quantity - max(0, closing - pending))


def _real_opening_quantity(order) -> int:
    """Reserve entry capital only for the part that increases an exact real position."""
    from app.services.trading import get_position
    position = get_position(order.session_id, order.symbol, right=order.right,
                            strike=order.strike, expiry=order.expiry)
    opposite = "SHORT" if order.side == TradeSide.BUY else "LONG"
    closing = position.quantity if position.side == opposite else 0
    return max(0, order.quantity - closing)


def _write_order_to_db(order: Order, *, strict: bool = False) -> None:
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
            "reservation_revision": order.reservation_revision,
            "trigger_price": Decimal(str(order.trigger_price)),
            "limit_price": Decimal(str(order.limit_price)),
            "status": order.status.value,
            "created_at": order.created_at,
            "is_stoploss": order.is_stoploss,
            "is_autostop": order.is_autostop,
        }
        from app.services import simulation
        session = simulation.get_session(order.session_id)
        if session and session.session_type == "real":
            from app.services.real_broker_state import active_partition
            item["session_id"] = active_partition(order.session_id) or order.session_id
        for name in ("execution_role", "broker_product", "broker_exchange", "broker_filled_quantity", "broker_filled_value"):
            value = getattr(order, name)
            if value is not None:
                item[name] = Decimal(str(value)) if isinstance(value, float) else value
        if order.kotak_order_id:
            item["kotak_order_id"] = order.kotak_order_id
        if order.kotak_fill_confirmed:
            item["kotak_fill_confirmed"] = True
        if order.filled_at is not None:
            item["filled_at"] = order.filled_at
        if order.filled_price is not None:
            item["filled_price"] = Decimal(str(order.filled_price))
        if order.reserved_amount:
            item["reserved_amount"] = Decimal(str(order.reserved_amount))
        if order.reservation_margin_rate != 1.0:
            item["reservation_margin_rate"] = Decimal(str(order.reservation_margin_rate))
        if order.wallet_ledger_id is not None:
            item["wallet_ledger_id"] = order.wallet_ledger_id
        if order.wallet_ledger_kind is not None:
            item["wallet_ledger_kind"] = order.wallet_ledger_kind
        if order.right is not None:
            item["right"] = order.right
        if order.strike is not None:
            item["strike"] = order.strike
        if order.expiry is not None:
            item["expiry"] = order.expiry
        if order.exit_allocation_id is not None:
            item["exit_allocation_id"] = order.exit_allocation_id
            item["exit_position_side"] = order.exit_position_side
            item["exit_allocation_role"] = order.exit_allocation_role
        if order.source is not None:
            item["source"] = order.source
        if order.entry_sl_price is not None:
            item["entry_sl_price"] = Decimal(str(order.entry_sl_price))
        if order.group_id is not None:
            item["group_id"] = order.group_id
        if order.execution_gap_pct is not None:
            item["execution_gap_pct"] = Decimal(str(order.execution_gap_pct))
        item["market_order"] = order.market_order
        if order.quote_price is not None:
            item["quote_price"] = Decimal(str(order.quote_price))
        if order.quote_timestamp is not None:
            item["quote_timestamp"] = order.quote_timestamp
        if order.quote_source is not None:
            item["quote_source"] = order.quote_source
        if order.source == "desktop_paper" and (order.wallet_ledger_id or "").startswith("paper:"):
            from app.services import paper_wallet
            context = paper_wallet.desktop_write_context(order.session_id, order.user_id,
                order.wallet_ledger_id.removeprefix("paper:"), order.symbol)
            if context is not None:
                token, stopped = context
                paper_wallet.fenced_put("Orders", item, user_id=order.user_id,
                    date=order.wallet_ledger_id.removeprefix("paper:"), symbol=order.symbol,
                    session_id=order.session_id, token=token, stopped=stopped)
            else:
                table.put_item(Item=item)
        else:
            table.put_item(Item=item)
    except Exception:
        if strict or order.source == "desktop_paper":
            raise
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
    strike: int | None = None,
    expiry: str | None = None,
    target_deviation_pct: float = _TARGET_DEVIATION,
    user_id: str = FIXED_USER_ID,
    margin_rate: float = 1.0,
    entry_sl_price: float | None = None,
    group_id: str | None = None,
    source: str | None = None,
    is_autostop: bool = False,
    quote_price: float | None = None,
    quote_timestamp: int | None = None,
    quote_source: str | None = None,
    market_order: bool = False,
    wallet_ledger_id: str | None = None,
    wallet_ledger_kind: str | None = None,
    order_id: str | None = None,
    exit_allocation_id: str | None = None,
    exit_position_side: str | None = None,
    exit_allocation_role: str | None = None,
) -> Order:
    _ensure_session(session_id)
    order_id = order_id or str(uuid.uuid4())
    existing = _orders[session_id].get(order_id)
    if existing and existing.status != OrderStatus.CANCELLED:
        _write_order_to_db(existing, strict=True)
        return existing

    from app.services import execution_price_service as execution
    is_real = execution.real_session(session_id, wallet_ledger_kind)
    execution_gap = None
    if is_real and order_type in (OrderType.TARGET, OrderType.STOPLOSS):
        execution_gap = execution.gap_for(user_id, order_type == OrderType.STOPLOSS)

    if order_type == OrderType.TARGET:
        if trigger_price is None:
            raise ValueError("trigger_price is required for TARGET orders")
        actual_trigger = trigger_price
        actual_limit = execution.limit_price(side, trigger_price, execution_gap) if is_real else _target_limit_price(side, trigger_price, target_deviation_pct)
    elif order_type == OrderType.STOPLOSS:
        if trigger_price is None:
            raise ValueError("trigger_price is required for STOPLOSS orders")
        actual_trigger = trigger_price
        actual_limit = execution.limit_price(side, trigger_price, execution_gap) if is_real else trigger_price
        is_stoploss = True
    else:  # LIMIT
        if limit_price is None:
            raise ValueError("limit_price is required for LIMIT orders")
        actual_trigger = limit_price   # stored for schema consistency
        actual_limit = limit_price
        if is_real and market_order:
            if quote_price is None:
                raise ValueError("Market execution requires an authoritative quote")
            execution_gap = execution.gap_for(user_id)
            actual_trigger = quote_price
            actual_limit = execution.limit_price(side, quote_price, execution_gap)

    # SL orders never debit wallet; regular BUY orders reserve funds upfront.
    # margin_rate < 1.0 for equity MIS real sessions (20% margin).
    reserved_amount = 0.0
    equity_margin = margin_rate < 1 and right is None
    if (side == TradeSide.BUY or equity_margin) and not is_stoploss and order_type != OrderType.STOPLOSS:
        reserve_quantity = _opening_quantity(session_id, symbol, side, quantity) if equity_margin else quantity
        if wallet_ledger_kind == "real":
            from types import SimpleNamespace
            reserve_quantity = _real_opening_quantity(SimpleNamespace(session_id=session_id,
                symbol=symbol, side=side, quantity=quantity, right=right, strike=strike, expiry=expiry))
        reserved_amount = round(reserve_quantity * actual_limit * margin_rate, 2)
        from app.services import wallet_service
        if wallet_ledger_id and wallet_ledger_id.startswith("paper:"):
            pass  # committed together with the order below
        elif wallet_ledger_id:
            wallet_service.debit_ledger(user_id, reserved_amount, trading_date, wallet_ledger_id, wallet_ledger_kind or "sim", operation_id=f"order:{order_id}:reserve")
        else:
            wallet_service.debit(user_id, reserved_amount, trading_date)

    order = Order(
        order_id=order_id,
        session_id=session_id,
        user_id=user_id,
        symbol=symbol,
        side=side,
        order_type=order_type,
        quantity=quantity,
        trigger_price=actual_trigger,
        limit_price=actual_limit,
        status=OrderStatus.PENDING,
        created_at=created_at,
        reserved_amount=reserved_amount,
        reservation_margin_rate=margin_rate,
        wallet_ledger_id=wallet_ledger_id,
        wallet_ledger_kind=wallet_ledger_kind,
        is_stoploss=is_stoploss,
        is_autostop=is_autostop,
        right=right,
        strike=strike,
        expiry=expiry,
        source=source,
        entry_sl_price=entry_sl_price,
        group_id=group_id,
        quote_price=quote_price,
        quote_timestamp=quote_timestamp,
        quote_source=quote_source,
        execution_gap_pct=execution_gap,
        market_order=market_order,
        exit_allocation_id=exit_allocation_id,
        exit_position_side=exit_position_side,
        exit_allocation_role=exit_allocation_role,
    )
    if wallet_ledger_id and wallet_ledger_id.startswith("paper:"):
        from app.services import paper_wallet
        from app.services import simulation as sim_svc
        session = sim_svc.get_session(session_id)
        engine = (session_id, symbol, session.paper_engine_token) if session and getattr(session, "desktop_origin", None) == "desktop_paper" and getattr(session, "paper_engine_token", None) else None
        paper_wallet.move(user_id, trading_date, -reserved_amount, f"order:{order_id}:reserve", order=order, engine=engine)
    _orders[session_id][order.order_id] = order
    _write_order_to_db(order, strict=bool(exit_allocation_id))
    return order


def get_open_orders(session_id: str) -> list[Order]:
    return [
        o for o in _orders.get(session_id, {}).values()
        if o.status == OrderStatus.PENDING
    ]


def get_all_orders(session_id: str) -> list[Order]:
    return list(_orders.get(session_id, {}).values())


def get_order(session_id: str, order_id: str) -> Order | None:
    return _orders.get(session_id, {}).get(order_id)


def _credit_reservation(order: Order, amount: float, trading_date: str, persisted_order=None) -> None:
    from app.services import wallet_service
    from app.services import simulation as sim_svc
    session = sim_svc.get_session(order.session_id)
    engine = (order.session_id, order.symbol, session.paper_engine_token) if session and getattr(session, "desktop_origin", None) == "desktop_paper" and getattr(session, "paper_engine_token", None) else None
    cleanup = (order.session_id, order.symbol) if not session and order.source == "desktop_paper" and persisted_order is not None and persisted_order.status == OrderStatus.CANCELLED else None
    if order.wallet_ledger_id:
        wallet_service.credit_ledger(order.user_id, amount, trading_date, order.wallet_ledger_id, order.wallet_ledger_kind or "sim", operation_id=f"order:{order.order_id}:adjust:{order.reservation_revision}", order=persisted_order, engine=engine, cleanup=cleanup)
    else:
        wallet_service.credit(order.user_id, amount, trading_date)


def _debit_reservation(order: Order, amount: float, trading_date: str, persisted_order=None) -> None:
    from app.services import wallet_service
    from app.services import simulation as sim_svc
    session = sim_svc.get_session(order.session_id)
    engine = (order.session_id, order.symbol, session.paper_engine_token) if session and getattr(session, "desktop_origin", None) == "desktop_paper" and getattr(session, "paper_engine_token", None) else None
    if order.wallet_ledger_id:
        wallet_service.debit_ledger(order.user_id, amount, trading_date, order.wallet_ledger_id, order.wallet_ledger_kind or "sim", operation_id=f"order:{order.order_id}:adjust:{order.reservation_revision}", order=persisted_order, engine=engine)
    else:
        wallet_service.debit(order.user_id, amount, trading_date)


def _reservation_for(order: Order, price: float, quantity: int | None = None) -> float:
    qty = quantity if quantity is not None else order.quantity
    if order.wallet_ledger_kind == "real":
        qty = _real_opening_quantity(order.model_copy(update={"quantity": qty}))
    elif order.right is None and order.reservation_margin_rate < 1:
        qty = _opening_quantity(order.session_id, order.symbol, order.side, qty, order.order_id)
    return round(qty * price * order.reservation_margin_rate, 2)


def _adjust_buy_reservation(order: Order, new_reserved: float, trading_date: str, changes=None) -> None:
    diff = round(new_reserved - order.reserved_amount, 2)
    order.reservation_revision += 1
    saved = order.model_copy(update={"reserved_amount": new_reserved, **(changes or {})})
    try:
        if diff > 0:
            _debit_reservation(order, diff, trading_date, saved)
        elif diff < 0:
            _credit_reservation(order, -diff, trading_date, saved)
    except Exception:
        order.reservation_revision -= 1
        raise
    order.reserved_amount = new_reserved


def cancel_order(session_id: str, order_id: str, trading_date: str) -> Order | None:
    order = _orders.get(session_id, {}).get(order_id)
    if order is None or order.status != OrderStatus.PENDING:
        return None
    # Credit back the reserved funds for cancelled regular BUY orders (not SL)
    if order.reserved_amount > 0 and not order.is_stoploss:
        order.reservation_revision += 1
        try:
            _credit_reservation(order, order.reserved_amount, trading_date, order.model_copy(update={"status": OrderStatus.CANCELLED, "reserved_amount": 0.0}))
        except Exception:
            order.reservation_revision -= 1
            raise
        order.reserved_amount = 0.0
    order.status = OrderStatus.CANCELLED
    _write_order_to_db(order, strict=order.source == "desktop_paper")
    return order


def update_order(
    session_id: str,
    order_id: str,
    trading_date: str,
    trigger_price: float | None = None,
    limit_price: float | None = None,
    quantity: int | None = None,
    target_deviation_pct: float = _TARGET_DEVIATION,
    execution_gap_pct: float | None = None,
) -> Order | None:
    """Update price and/or quantity of a PENDING order; handle BUY wallet re-reservation."""
    order = _orders.get(session_id, {}).get(order_id)
    if order is None or order.status != OrderStatus.PENDING:
        return None

    from app.services import execution_price_service as execution
    is_real = execution.real_session(session_id, order.wallet_ledger_kind)
    gap = execution_gap_pct
    if is_real and trigger_price is not None and order.order_type in (OrderType.TARGET, OrderType.STOPLOSS):
        gap = gap if gap is not None else execution.gap_for(order.user_id, order.order_type == OrderType.STOPLOSS)

    if order.order_type == OrderType.TARGET and trigger_price is not None:
        new_trigger = trigger_price
        new_limit = execution.limit_price(order.side, trigger_price, gap) if is_real else _target_limit_price(order.side, trigger_price, target_deviation_pct)
        if (order.side == TradeSide.BUY or (order.right is None and order.reservation_margin_rate < 1)) and not order.is_stoploss:
            _adjust_buy_reservation(order, _reservation_for(order, new_limit), trading_date, {"trigger_price": new_trigger, "limit_price": new_limit})
        order.trigger_price = new_trigger
        order.limit_price = new_limit

    elif order.order_type == OrderType.LIMIT and limit_price is not None:
        new_limit = limit_price
        if (order.side == TradeSide.BUY or (order.right is None and order.reservation_margin_rate < 1)) and not order.is_stoploss:
            _adjust_buy_reservation(order, _reservation_for(order, new_limit), trading_date, {"trigger_price": new_limit, "limit_price": new_limit})
        order.limit_price = new_limit
        order.trigger_price = new_limit

    elif order.order_type == OrderType.STOPLOSS and trigger_price is not None:
        order.trigger_price = trigger_price
        order.limit_price = execution.limit_price(order.side, trigger_price, gap) if is_real else trigger_price

    if is_real and trigger_price is not None and order.order_type in (OrderType.TARGET, OrderType.STOPLOSS):
        order.execution_gap_pct = gap
    elif order.order_type == OrderType.LIMIT and limit_price is not None:
        order.execution_gap_pct = None
        order.market_order = False

    if quantity is not None:
        if (order.side == TradeSide.BUY or (order.right is None and order.reservation_margin_rate < 1)) and not order.is_stoploss and order.order_type != OrderType.STOPLOSS:
            _adjust_buy_reservation(order, _reservation_for(order, order.limit_price, quantity), trading_date, {"quantity": quantity})
        order.quantity = quantity

    _write_order_to_db(order)
    return order


def convert_order(
    session_id: str,
    order_id: str,
    new_order_type: "OrderType",
    trading_date: str,
    price: float | None = None,
) -> "Order | None":
    """
    Convert a PENDING order to a different type in-place.  Uses the provided
    price if given, otherwise falls back to the order's existing trigger/limit price.
    """
    order = _orders.get(session_id, {}).get(order_id)
    if order is None or order.status != OrderStatus.PENDING:
        return None
    if new_order_type == order.order_type:
        return order  # no-op

    old_type = order.order_type
    side = order.side
    qty = order.quantity

    # ── Resolve prices for the new type ──────────────────────────────────────
    if new_order_type == OrderType.LIMIT:
        # TARGET or STOPLOSS → LIMIT: use provided price or trigger_price as limit_price
        new_limit = price if price is not None else order.trigger_price
        new_trigger = new_limit  # schema consistency
        new_is_sl = False
    elif new_order_type == OrderType.TARGET:
        # LIMIT → TARGET: use provided price or limit_price as trigger
        new_trigger = price if price is not None else order.limit_price
        new_limit = _target_limit_price(side, new_trigger)
        new_is_sl = False
    elif new_order_type == OrderType.STOPLOSS:
        # LIMIT → STOPLOSS: use provided price or limit_price as trigger
        new_trigger = price if price is not None else order.limit_price
        new_limit = new_trigger
        new_is_sl = True
    else:
        return None

    from app.services import execution_price_service as execution
    gap = None
    if execution.real_session(session_id, order.wallet_ledger_kind) and new_order_type in (OrderType.TARGET, OrderType.STOPLOSS):
        gap = execution.gap_for(order.user_id, new_order_type == OrderType.STOPLOSS)
        new_limit = execution.limit_price(side, new_trigger, gap)

    # ── Wallet reservation ──────────────────────────────────────────────────
    # STOPLOSS orders have no reservation.  When converting to/from STOPLOSS,
    # we skip wallet changes because these are exit orders for existing positions.
    was_sl = (old_type == OrderType.STOPLOSS) or order.is_stoploss
    is_sl = (new_order_type == OrderType.STOPLOSS) or new_is_sl

    if side == TradeSide.BUY or (order.right is None and order.reservation_margin_rate < 1):
        if was_sl and not is_sl:
            # SL → non-SL BUY: no reservation (exit order for existing position)
            pass
        elif not was_sl and is_sl:
            # non-SL → SL BUY: release existing reservation
            if order.reserved_amount > 0:
                order.reservation_revision += 1
                try:
                    _credit_reservation(order, order.reserved_amount, trading_date, order.model_copy(update={"order_type": new_order_type, "limit_price": new_limit, "trigger_price": new_trigger, "is_stoploss": new_is_sl, "reserved_amount": 0.0}))
                except Exception:
                    order.reservation_revision -= 1
                    raise
            order.reserved_amount = 0.0
        elif not was_sl and not is_sl:
            # TARGET ↔ LIMIT: adjust reservation to new limit price
            _adjust_buy_reservation(order, _reservation_for(order, new_limit, qty), trading_date, {"order_type": new_order_type, "limit_price": new_limit, "trigger_price": new_trigger, "is_stoploss": new_is_sl})

    # ── Apply the conversion ────────────────────────────────────────────────
    order.execution_gap_pct = gap
    order.market_order = False
    order.order_type = new_order_type
    order.trigger_price = new_trigger
    order.limit_price = new_limit
    order.is_stoploss = new_is_sl

    _write_order_to_db(order)
    logger.info(
        "convert_order %s: %s → %s trigger=%.2f limit=%.2f",
        order_id, old_type.value, new_order_type.value,
        new_trigger, new_limit,
    )
    return order


def check_orders(
    session_id: str,
    current_price: float,
    current_time: int,
    trading_date: str = "",
    tick_right: str | None = None,
    tick_strike: int | None = None,
    tick_expiry: str | None = None,
    settle_wallet: bool = True,
    only_order_id: str | None = None,
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
        if only_order_id is not None and order.order_id != only_order_id:
            continue
        if order.status != OrderStatus.PENDING:
            continue
        # Skip orders placed directly on Kotak broker; fills arrive via order-feed WebSocket.
        if order.kotak_order_id:
            continue
        # For options ticks: only check orders for the same contract.
        # For equity ticks (tick_right=None): only check orders with right=None.
        if order.right != tick_right:
            continue
        if tick_right is not None:
            if tick_strike is not None and order.strike is not None and int(order.strike) != int(tick_strike):
                continue
            if tick_expiry is not None and order.expiry is not None and order.expiry != tick_expiry:
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

        retrying_paper_fill = (order.wallet_ledger_id or "").startswith("paper:") and order.filled_price is not None
        if triggered or retrying_paper_fill:
            if order.exit_allocation_id:
                from app.services.trading import get_position
                position = get_position(session_id, order.symbol, order.right, strike=order.strike, expiry=order.expiry)
                key = (order.symbol, order.right, order.strike, order.expiry)
                # Count every earlier fill in this batch, including manual exits.
                prior = sum(item.quantity if item.side == order.side else -item.quantity for item in filled
                            if (item.symbol, item.right, item.strike, item.expiry) == key)
                available = max(0, position.quantity - prior) if position.side == order.exit_position_side else 0
                if available <= 0:
                    cancel_order(session_id, order.order_id, trading_date)
                    continue
                if order.quantity > available:
                    update_order(session_id, order.order_id, trading_date, quantity=available)
            order.status = OrderStatus.FILLED
            if not retrying_paper_fill:
                order.filled_at = current_time
                order.filled_price = current_price
            # Credit wallet on every SELL fill (LIMIT, TARGET, or SL).
            # SL placement has no debit; the corresponding BUY already debited. Skipping
            # the credit here would permanently remove those funds from the wallet even
            # after the position is fully closed.
            if settle_wallet and order.side == TradeSide.SELL and trading_date:
                _credit_reservation(order, round(order.quantity * current_price, 2), trading_date)
            if settle_wallet or not (order.wallet_ledger_id or "").startswith("paper:"):
                _write_order_to_db(order)
            filled.append(order)
    return filled


def cancel_all_pending_orders(session_id: str, trading_date: str) -> int:
    """Cancel all PENDING orders for a session, crediting back reserved BUY amounts."""
    pending = [o for o in _orders.get(session_id, {}).values() if o.status == OrderStatus.PENDING]
    for order in pending:
        cancel_order(session_id, order.order_id, trading_date)
    return len(pending)


# Broker calls release the GIL; serialize competing trade/retry reconciliation.
_exit_reconciliation_locks: dict[tuple, threading.RLock] = {}


def reconcile_allocated_exits(session_id: str, symbol: str, right, strike, expiry, trading_date: str) -> None:
    key = (session_id, symbol, right, strike, expiry)
    lock = _exit_reconciliation_locks.setdefault(key, threading.RLock())
    with lock:
        _reconcile_allocated_exits(session_id, symbol, right, strike, expiry, trading_date)


def _reconcile_allocated_exits(session_id: str, symbol: str, right, strike, expiry, trading_date: str) -> None:
    """Cap a split exit's aggregate quantity after a committed position change."""
    from app.services.trading import get_position
    # Repair a local write failure even when an acknowledged cancellation has
    # already removed the order from the pending registry.
    for order in get_all_orders(session_id):
        if order.exit_allocation_id and (order.symbol, order.right, order.strike, order.expiry) == (symbol, right, strike, expiry):
            _write_order_to_db(order, strict=True)
    pending = [o for o in get_open_orders(session_id) if o.exit_allocation_id
               and (o.symbol, o.right, o.strike, o.expiry) == (symbol, right, strike, expiry)]
    if not pending:
        return
    position = get_position(session_id, symbol, right, strike=strike, expiry=expiry)
    available = position.quantity
    for order in sorted(pending, key=lambda o: (o.created_at, o.order_id)):
        quantity = min(order.quantity, available) if position.side == order.exit_position_side else 0
        available -= quantity
        if quantity == order.quantity:
            continue
        if order.kotak_order_id:
            from app.services.kotak_service import get_service
            broker = get_service()
            if not quantity:
                broker.cancel_order(order.kotak_order_id)
            elif order.order_type == OrderType.LIMIT:
                broker.modify_sl_to_limit_order(order.kotak_order_id, order.limit_price, quantity)
            else:
                broker.modify_sl_order(order.kotak_order_id, order.trigger_price, order.limit_price, quantity)
        if quantity:
            update_order(session_id, order.order_id, trading_date, quantity=quantity)
        else:
            cancel_order(session_id, order.order_id, trading_date)
        _write_order_to_db(order, strict=True)
        logger.info("take_profit_exit_reconciled session=%s order=%s quantity=%d", session_id, order.order_id, quantity)
        from app.services.simulation import get_session
        session = get_session(session_id)
        if session:
            import json
            payload = order.model_dump(mode="json")
            payload["type"] = "order_updated" if quantity else "order_cancelled"
            session.queue.put_nowait(json.dumps(payload))


def clear_session(session_id: str) -> None:
    _orders.pop(session_id, None)


def reload_paper_orders(session, *, repair_fills: bool = True) -> None:
    """Restore pending reservations and repair fills committed before trade persistence."""
    from app.services.db import get_dynamodb_resource
    from boto3.dynamodb.conditions import Key
    from app.services import paper_wallet, trading
    table = get_dynamodb_resource().Table("Orders")
    params = {"KeyConditionExpression": Key("session_id").eq(session.session_id), "ConsistentRead": True}
    records = []
    while True:
        page = table.query(**params)
        records.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        params["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    _orders[session.session_id] = {}
    for record in records:
        order = Order.model_validate(record)
        _orders[session.session_id][order.order_id] = order
        if repair_fills and order.status == OrderStatus.FILLED and paper_wallet.fill_recorded(session.user_id, session.date, order.order_id):
            trading.record_trade(session.session_id, order.side, order.filled_price, order.filled_at,
                quantity=order.quantity, symbol=order.symbol, right=order.right,
                strike=order.strike, expiry=order.expiry, instrument_type="options" if order.right else "equity",
                brokerage_per_order=session.brokerage_per_order, user_id=session.user_id,
                session_type="paper", source=order.source, trade_id=order.order_id)
    for symbol, right, strike, expiry in {(o.symbol, o.right, o.strike, o.expiry)
            for o in get_open_orders(session.session_id) if o.exit_allocation_id}:
        request_exit_reconciliation(session.session_id, symbol, right, strike, expiry, session.date)


# Contract-scoped retries also work during market closure: no tick is required.
_exit_retries: dict[tuple, dict] = {}


def request_exit_reconciliation(session_id, symbol, right, strike, expiry, trading_date):
    import time
    key = (session_id, symbol, right, strike, expiry, trading_date)
    try:
        reconcile_allocated_exits(*key)
        _exit_retries.pop(key, None)
    except Exception:
        previous = _exit_retries.get(key)
        state = dict(previous) if previous else {"attempt": 0, "next": time.monotonic() + 5, "logged": None}
        _exit_retries[key] = state
        if state["logged"] is None or time.monotonic() - state["logged"] >= 60:
            state["logged"] = time.monotonic()
            logger.exception("take_profit_exit_reconciliation_deferred session=%s symbol=%s right=%s strike=%s expiry=%s", *key[:5])


async def exit_reconciliation_loop():
    import asyncio
    import time
    while True:
        await asyncio.sleep(1)
        for key, state in list(_exit_retries.items()):
            if time.monotonic() < state["next"]:
                continue
            try:
                await asyncio.to_thread(reconcile_allocated_exits, *key)
            except Exception:
                state["attempt"] += 1
                state["next"] = time.monotonic() + min(30, 5 * 2 ** min(state["attempt"], 3))
                if state["logged"] is None or time.monotonic() - state["logged"] >= 60:
                    state["logged"] = time.monotonic()
                    logger.exception("take_profit_exit_reconciliation_retry session=%s symbol=%s right=%s strike=%s expiry=%s", *key[:5])
            else:
                # A concurrent position change may have installed a fresh retry.
                if _exit_retries.get(key) is state:
                    _exit_retries.pop(key, None)
