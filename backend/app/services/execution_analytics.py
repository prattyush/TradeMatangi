"""Small immutable decision snapshots; no database reads or analytics on the tick path."""

from copy import deepcopy
from decimal import Decimal
import uuid
from app.config import LOT_SIZES


def normalize_metadata(value):
    """DynamoDB Decimals must not leak into float arithmetic or JSON output."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {key: normalize_metadata(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize_metadata(item) for item in value]
    return deepcopy(value)


def snapshot(
    session,
    *,
    quantity,
    price,
    side,
    capital_fraction=None,
    risk_fraction=None,
    stop=None,
    margin_rate=1.0,
    entry_method="UNKNOWN",
    exit_method="UNKNOWN",
    action_id=None,
    strategy_id=None,
    size=None
):
    capital = float(getattr(session, "session_capital", 0) or 0)
    method = (
        "CAPITAL"
        if capital_fraction is not None
        else "RISK" if risk_fraction is not None else "QUANTITY"
    )
    fraction = capital_fraction if capital_fraction is not None else risk_fraction
    valid_stop = (
        stop is not None
        and float(stop) > 0
        and (
            (side == "BUY" and float(stop) < price)
            or (side == "SELL" and float(stop) > price)
        )
    )
    risk = abs(price - float(stop)) * quantity if valid_stop else None
    allocation = price * quantity * margin_rate
    budget = capital * fraction if fraction is not None else None
    actual = risk if method == "RISK" else allocation
    return dict(
        version=1,
        side=side,
        lot_size=(
            LOT_SIZES.get(getattr(session, "symbol", None), 1)
            if getattr(session, "instrument_type", None) == "options"
            else 1
        ),
        action_id=action_id or str(uuid.uuid4()),
        entry_method=entry_method,
        exit_method=exit_method,
        client="desktop" if getattr(session, "desktop_origin", None) else "website",
        mode=getattr(session, "session_type", "sim"),
        capital=capital,
        strategy_interval_seconds=int(getattr(session, "strategy_interval_secs", 180)),
        sizing_method=method,
        requested_pct=fraction * 100 if fraction is not None else None,
        requested_budget=budget,
        calculated_quantity=quantity,
        reference_price=price,
        initial_stop=float(stop) if valid_stop else None,
        margin_rate=margin_rate,
        effective_allocation_pct=100 * allocation / capital if capital > 0 else None,
        initial_risk=risk,
        effective_risk_pct=(
            100 * risk / capital if risk is not None and capital > 0 else None
        ),
        budget_exceeded=bool(
            budget is not None and actual is not None and actual > budget + 0.0001
        ),
        strategy_id=strategy_id,
        requested_size=size,
    )


def from_request(session, request, quantity, price, margin_rate=1.0, sizing_stop=None):
    side = getattr(request.side, "value", request.side)
    kind = getattr(request.order_type, "value", request.order_type)
    risk = (
        request.risk_pct / 100
        if getattr(request, "risk_pct", None) is not None
        else getattr(request, "risk_ratio_pct", None)
    )
    if request.funds_ratio_pct is not None:
        risk = None  # Mirror the existing order router's capital-first precedence.
    stop = sizing_stop if sizing_stop is not None else request.entry_sl_price
    name = "MARKET" if request.market_order else kind
    result = snapshot(
        session,
        quantity=quantity,
        price=price,
        side=side,
        capital_fraction=request.funds_ratio_pct,
        risk_fraction=risk,
        stop=stop,
        margin_rate=margin_rate,
        entry_method=name,
        exit_method=name,
    )
    result["stop_source"] = (
        "explicit"
        if request.entry_sl_price is not None
        else "sizing_default" if risk is not None else None
    )
    return result


def order_snapshot(order, session=None, *, new_order=False):
    meta = normalize_metadata(order.analytics or {})
    if not meta:
        kind = getattr(order.order_type, "value", order.order_type)
        name = (
            "AUTOSTOP_LIMIT"
            if order.is_autostop and kind == "LIMIT"
            else (
                "AUTOSTOP"
                if order.is_autostop
                else "MARKET" if order.market_order else kind
            )
        )
        if new_order:
            meta = snapshot(
                session,
                quantity=order.quantity,
                price=order.limit_price,
                side=order.side.value,
                stop=order.entry_sl_price,
                margin_rate=order.reservation_margin_rate,
                entry_method=name,
                exit_method=kind,
                action_id=order.order_id,
            )
        else:
            meta = dict(
                version=1,
                action_id=order.order_id,
                entry_method=(
                    name if order.is_autostop or order.market_order else "UNKNOWN"
                ),
                exit_method="UNKNOWN",
                sizing_method="UNKNOWN",
            )
    meta.update(
        order_id=order.order_id,
        placement_time=order.created_at,
        execution_type=order.order_type.value,
        quote_price=order.quote_price,
        quote_timestamp=order.quote_timestamp,
        quote_source=order.quote_source,
        execution_gap_pct=order.execution_gap_pct,
        requested_entry_stop=order.entry_sl_price,
    )
    return meta


def controller(
    order, name, timestamp, *, strategy_id=None, size=None, position_quantity=None
):
    meta = order_snapshot(order)
    event = dict(
        exit_action_id=strategy_id or meta.get("action_id") or order.order_id,
        exit_method=name,
        timestamp=int(timestamp or 0),
        strategy_id=strategy_id,
        requested_size=size,
        position_quantity=position_quantity,
        selected_quantity=order.quantity,
    )
    history = meta.setdefault("controller_history", [])
    if not history or history[-1] != event:
        history.append(event)
    meta.update(event)
    order.analytics = meta


def filled(meta, price, quantity):
    meta = normalize_metadata(meta or {})
    if not meta:
        return None
    meta.update(filled_quantity=quantity, filled_value=price * quantity)
    capital = meta.get("capital") or 0
    allocation = price * quantity * (meta.get("margin_rate") or 1)
    stop = meta.get("initial_stop")
    valid_stop = stop is not None and (
        (meta.get("side") == "BUY" and stop < price)
        or (meta.get("side") == "SELL" and stop > price)
    )
    risk = abs(price - stop) * quantity if valid_stop else None
    budget = meta.get("requested_budget")
    actual = risk if meta.get("sizing_method") == "RISK" else allocation
    meta["budget_exceeded"] = bool(
        budget is not None and actual is not None and actual > budget + 0.0001
    )
    meta["initial_risk"] = risk
    meta["effective_allocation_pct"] = (
        100 * allocation / capital if capital > 0 else None
    )
    meta["effective_risk_pct"] = (
        100 * risk / capital if risk is not None and capital > 0 else None
    )
    return meta


# Strategy callbacks run synchronously on the owning engine. Context keeps all
# generated/split orders attributed without changing public order request APIs.
from contextvars import ContextVar
from functools import wraps

_active_strategy = ContextVar("analytics_strategy", default=None)


def strategy_context(fn):
    @wraps(fn)
    def wrapped(strategy, session, *args, **kwargs):
        token = _active_strategy.set((strategy, session))
        try:
            return fn(strategy, session, *args, **kwargs)
        finally:
            _active_strategy.reset(token)

    return wrapped


def applied_controller(order):
    active = _active_strategy.get()
    from app.services.simulation import get_session

    session = active[1] if active else get_session(order.session_id)
    if active:
        strategy, _ = active
        name = strategy.strategy_type
        size = (
            strategy.metadata.get("underlying_stoploss_size", "full")
            if name == "UnderlyingStoploss"
            else (
                strategy.metadata.get("target_profit_size", "full")
                if name in ("TargetProfit", "UnderlyingTargetProfit")
                else None
            )
        )
        controller(
            order,
            name,
            getattr(session, "current_time", None) or order.created_at,
            strategy_id=strategy.strategy_id,
            size=size,
            position_quantity=strategy.metadata.get(
                "half_position_quantity",
                strategy.metadata.get("_analytics_position_quantity"),
            ),
        )
    else:
        controller(
            order,
            order.order_type.value,
            getattr(session, "current_time", None) or order.created_at,
        )


def created(order, session):
    active = _active_strategy.get()
    session = active[1] if active else session
    order.analytics = order_snapshot(order, session, new_order=True)
    if active and active[0].strategy_type != "AutoStop":
        applied_controller(order)
