"""
Strategy service: automated trading strategies that run alongside the simulation.

Three strategy types:
  AutoStop           - Entry: places TARGET order at bar high/low (or % from close) on each bar close.
  BreakEven          - Exit: exits 100% of position on every tick as soon as price >= avg entry (LONG)
                       or price <= avg entry (SHORT).
  AggressiveStoploss - TradeManagement: shifts the SL to 1% from bar close on each bar close.

Lifecycle:
  - start_strategy()  adds an instance to the in-memory registry and writes to DynamoDB.
  - on_tick()         is called from _emit_tick_and_check_orders for every tick; evaluates
                      bar-close and per-tick strategy logic.
  - cancel_all()      marks all running instances CANCELLED (in-memory + DynamoDB) and clears them.
  - clear_session()   called on session stop to purge registry state.

Cross-process cancellation:
  cancel_all() writes CANCELLED status to DynamoDB.  Strategies in a different process
  detect cancellation on their next trigger by re-reading DB status.  Same-process
  cancellation is immediate via the in-memory `status` flag.
"""
from __future__ import annotations

import logging
import math
import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum

logger = logging.getLogger(__name__)

# ── Tick-size helpers ─────────────────────────────────────────────────────────

_TICK_SIZE = 0.05  # NSE/BSE minimum price increment


def _session_strike(session, tick_right: str | None) -> int | None:
    """Return the correct strike for the given tick right, using per-right strike when available."""
    if tick_right == "CE":
        return getattr(session, "strike_ce", None) or getattr(session, "strike", None)
    if tick_right == "PE":
        return getattr(session, "strike_pe", None) or getattr(session, "strike", None)
    return getattr(session, "strike", None)


def _ceil_tick(price: float) -> float:
    """Round price UP to the nearest ₹0.05 tick."""
    return round(math.ceil(round(price / _TICK_SIZE, 10)) * _TICK_SIZE, 2)


def _main_buffer(price: float) -> float:
    """max(3 ticks, 0.25% of price), ceiled to tick."""
    return _ceil_tick(max(3 * _TICK_SIZE, 0.0025 * price))


def _trigger_buffer(price: float) -> float:
    """0.3% of price, ceiled to tick — ensures LTP is on the correct side of a new SL."""
    return _ceil_tick(0.003 * price)


class StrategyStatus(str, Enum):
    RUNNING = "RUNNING"
    CANCELLED = "CANCELLED"
    COMPLETED = "COMPLETED"


@dataclass
class StrategyInstance:
    strategy_id: str
    session_id: str
    user_id: str
    strategy_type: str   # "AutoStop" | "BreakEven" | "AggressiveStoploss"
    symbol: str
    right: str | None    # "CE" | "PE" | None (equity)
    status: StrategyStatus
    metadata: dict       # strategy-specific config (direction, qty, ratio, trigger settings…)
    # Bar OHLC tracking — reconstructed from ticks, not persisted
    _last_bar_slot: int | None = field(default=None, repr=False)
    _bar_open: float = field(default=0.0, repr=False)
    _bar_high: float = field(default=0.0, repr=False)
    _bar_low: float = field(default=0.0, repr=False)
    _bar_close: float = field(default=0.0, repr=False)


# session_id → list[StrategyInstance]
_registry: dict[str, list[StrategyInstance]] = {}


# ── Persistence ──────────────────────────────────────────────────────────────

def _write_strategy_to_db(strategy: StrategyInstance) -> None:
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Strategies")
        item: dict = {
            "strategy_id": strategy.strategy_id,
            "session_id": strategy.session_id,
            "user_id": strategy.user_id,
            "strategy_type": strategy.strategy_type,
            "symbol": strategy.symbol,
            "status": strategy.status.value,
        }
        if strategy.right is not None:
            item["right"] = strategy.right
        # Store metadata (convert floats to Decimal for DynamoDB)
        db_meta: dict = {}
        for k, v in strategy.metadata.items():
            if isinstance(v, float):
                db_meta[k] = Decimal(str(v))
            else:
                db_meta[k] = v
        item["metadata"] = db_meta
        table.put_item(Item=item)
    except Exception:
        logger.exception("DynamoDB write failed for strategy %s", strategy.strategy_id)


# ── Registry management ───────────────────────────────────────────────────────

def start_strategy(session, strategy_type: str, right: str | None, metadata: dict) -> StrategyInstance:
    """
    Register and persist a new strategy instance for a session.
    `session` is a SimulationSession instance.
    """
    strategy = StrategyInstance(
        strategy_id=str(uuid.uuid4()),
        session_id=session.session_id,
        user_id=session.user_id,
        strategy_type=strategy_type,
        symbol=session.symbol,
        right=right,
        status=StrategyStatus.RUNNING,
        metadata=metadata,
    )
    _registry.setdefault(session.session_id, []).append(strategy)
    _write_strategy_to_db(strategy)
    return strategy


def cancel_all(session_id: str) -> int:
    """Cancel all running strategies for a session. Returns number cancelled."""
    count = 0
    for s in _registry.get(session_id, []):
        if s.status == StrategyStatus.RUNNING:
            s.status = StrategyStatus.CANCELLED
            _write_strategy_to_db(s)
            count += 1
    _registry[session_id] = []
    return count


def list_running(session_id: str) -> list[StrategyInstance]:
    return [s for s in _registry.get(session_id, []) if s.status == StrategyStatus.RUNNING]


def clear_session(session_id: str) -> None:
    """Remove registry state on session end (no DB update — cancel_all handles that)."""
    _registry.pop(session_id, None)


# ── Tick hook (called from simulation._emit_tick_and_check_orders) ────────────

def on_tick(session, tick: dict, tick_right: str | None, loop=None) -> None:
    """
    Evaluate all strategies for the given session on a single tick.
    tick_right matches the right of the tick (None=equity, "CE", "PE").
    Strategies are only evaluated when their right matches the tick's right.
    loop: asyncio event loop, provided by real sessions to enable broker-side order routing.
    """
    strategies = _registry.get(session.session_id)
    if not strategies:
        return

    ts: int = tick["time"]
    current_price: float = tick["close"]
    interval_secs: int = getattr(session, "strategy_interval_secs", 180)
    current_slot: int = (ts // interval_secs) * interval_secs

    for strategy in list(strategies):
        if strategy.status != StrategyStatus.RUNNING:
            continue

        # Only evaluate this strategy when the tick's right matches the strategy's right
        if strategy.right != tick_right:
            continue

        # ── Bar OHLC tracking ──────────────────────────────────────────────
        if strategy._last_bar_slot is None:
            # First tick: initialise bar state
            strategy._last_bar_slot = current_slot
            strategy._bar_open = tick["open"]
            strategy._bar_high = tick["high"]
            strategy._bar_low = tick["low"]
            strategy._bar_close = tick["close"]
        elif current_slot != strategy._last_bar_slot:
            # Slot changed → previous bar just closed
            closed_ohlc = {
                "open": strategy._bar_open,
                "high": strategy._bar_high,
                "low": strategy._bar_low,
                "close": strategy._bar_close,
            }
            # Reset for new bar
            strategy._last_bar_slot = current_slot
            strategy._bar_open = tick["open"]
            strategy._bar_high = tick["high"]
            strategy._bar_low = tick["low"]
            strategy._bar_close = tick["close"]

            if strategy.status == StrategyStatus.RUNNING:
                _on_bar_close(strategy, session, closed_ohlc, tick_right, ts, loop)
        else:
            strategy._bar_high = max(strategy._bar_high, tick["high"])
            strategy._bar_low = min(strategy._bar_low, tick["low"])
            strategy._bar_close = tick["close"]

        # ── Per-tick evaluation (BreakEven + TargetProfit) ───────────────
        if strategy.strategy_type == "BreakEven" and strategy.status == StrategyStatus.RUNNING:
            _on_tick_breakeven(strategy, session, current_price, tick_right, ts, loop)
        elif strategy.strategy_type == "TargetProfit" and strategy.status == StrategyStatus.RUNNING:
            _on_tick_target_profit(strategy, session, current_price, tick_right, ts, loop)

    # Prune completed/cancelled entries
    _registry[session.session_id] = [
        s for s in strategies if s.status == StrategyStatus.RUNNING
    ]


# ── Bar-close evaluators ──────────────────────────────────────────────────────

def _on_bar_close(
    strategy: StrategyInstance,
    session,
    closed_ohlc: dict,
    tick_right: str | None,
    current_ts: int,
    loop=None,
) -> None:
    if strategy.strategy_type == "AutoStop":
        _on_bar_close_autostop(strategy, session, closed_ohlc, tick_right, current_ts)
    elif strategy.strategy_type == "AggressiveStoploss":
        _on_bar_close_aggressive_sl(strategy, session, closed_ohlc, tick_right, current_ts, loop)


def _on_bar_close_autostop(
    strategy: StrategyInstance,
    session,
    closed_ohlc: dict,
    tick_right: str | None,
    current_ts: int,
) -> None:
    meta = strategy.metadata
    trigger_type = meta.get("autostop_trigger_type", "bar")
    direction = meta.get("direction", "BUY")

    # Compute trigger price from closed bar
    if trigger_type == "bar":
        trigger_price = closed_ohlc["high"] if direction == "BUY" else closed_ohlc["low"]
    else:
        dev_pct = float(meta.get("autostop_deviation_pct", 1.0))
        if direction == "BUY":
            trigger_price = closed_ohlc["close"] * (1 + dev_pct / 100)
        else:
            trigger_price = closed_ohlc["close"] * (1 - dev_pct / 100)
    trigger_price = round(trigger_price, 2)

    # Resolve quantity
    quantity = meta.get("quantity")
    if quantity is None:
        funds_ratio_pct = meta.get("funds_ratio_pct")
        if funds_ratio_pct is None:
            logger.warning("AutoStop %s: no quantity or funds_ratio_pct in metadata", strategy.strategy_id)
            return
        try:
            from app.services.order_service import compute_funds_ratio_quantity
            from app.services.wallet_service import get_balance
            from app.config import LOT_SIZES
            lot_size = LOT_SIZES.get(session.symbol, 1) if tick_right else 1
            current_wallet = get_balance(session.user_id, session.date)
            quantity = compute_funds_ratio_quantity(
                session.symbol, trigger_price, session.session_capital,
                funds_ratio_pct, current_wallet, lot_size=lot_size,
            )
        except Exception as exc:
            logger.warning("AutoStop %s: quantity calc failed: %s", strategy.strategy_id, exc)
            return

    # Resolve per-right strike so trade markers appear on the correct options pane
    if tick_right == "CE":
        order_strike = getattr(session, "strike_ce", None) or getattr(session, "strike", None)
    elif tick_right == "PE":
        order_strike = getattr(session, "strike_pe", None) or getattr(session, "strike", None)
    else:
        order_strike = None

    from app.services.guardrail_service import check_guardrails
    blocked, reason = check_guardrails(session)
    if blocked:
        logger.info("AutoStop %s skipped — guardrail active: %s", strategy.strategy_id, reason)
        return

    from app.services.order_service import place_order
    from app.models.schemas import TradeSide, OrderType
    side = TradeSide.BUY if direction == "BUY" else TradeSide.SELL
    try:
        place_order(
            session_id=session.session_id,
            symbol=session.symbol,
            side=side,
            order_type=OrderType.TARGET,
            quantity=quantity,
            created_at=current_ts,
            trading_date=session.date,
            trigger_price=trigger_price,
            right=tick_right,
            strike=order_strike,
            user_id=session.user_id,
        )
        logger.info(
            "AutoStop %s placed %s TARGET at %.2f for %s right=%s",
            strategy.strategy_id, direction, trigger_price, session.symbol, tick_right,
        )
    except Exception as exc:
        logger.warning("AutoStop %s: place_order failed: %s", strategy.strategy_id, exc)
        return

    # One-shot: mark COMPLETED so AutoStop doesn't fire again on the next bar
    strategy.status = StrategyStatus.COMPLETED
    _write_strategy_to_db(strategy)


def _find_open_exit_orders(session_id: str, exit_side, tick_right: str | None, quantity: int) -> list:
    """Return pending orders that would close a position: matching side, right, and quantity."""
    from app.services.order_service import get_open_orders
    return [
        o for o in get_open_orders(session_id)
        if o.side == exit_side and o.right == tick_right and o.quantity == quantity
    ]


def _update_exit_order_price(session, order, new_price: float) -> None:
    """
    Move trigger/limit price of a pending exit order to new_price.
    For real sessions: also modifies the order on Kotak if it was placed there.
    """
    from app.services.order_service import update_order
    from app.models.schemas import OrderType

    # For real sessions with a Kotak-placed SL: update the broker-side order too.
    if getattr(session, "session_type", "sim") == "real" and getattr(order, "kotak_order_id", None):
        try:
            from app.services.kotak_service import get_service as get_kotak, KotakError
            from app.config import KOTAK_SLIPPAGE_PCT
            if order.side.value == "BUY":
                kotak_limit = round(new_price * (1 + KOTAK_SLIPPAGE_PCT), 2)
            else:
                kotak_limit = round(new_price * (1 - KOTAK_SLIPPAGE_PCT), 2)
            get_kotak().modify_sl_order(order.kotak_order_id, new_price, kotak_limit, order.quantity)
            logger.info(
                "Modified Kotak SL %s to trigger=%.2f limit=%.2f",
                order.kotak_order_id, new_price, kotak_limit,
            )
        except Exception as exc:
            logger.warning("Failed to modify Kotak SL %s: %s", order.kotak_order_id, exc)

    if order.order_type in (OrderType.TARGET, OrderType.STOPLOSS):
        update_order(session_id=session.session_id, order_id=order.order_id,
                     trading_date=session.date, trigger_price=new_price)
    else:  # LIMIT
        update_order(session_id=session.session_id, order_id=order.order_id,
                     trading_date=session.date, limit_price=new_price)


def _on_bar_close_aggressive_sl(
    strategy: StrategyInstance,
    session,
    closed_ohlc: dict,
    tick_right: str | None,
    current_ts: int,
    loop=None,
) -> None:
    from app.services.trading import get_position
    from app.models.schemas import TradeSide, OrderType
    from app.services.order_service import place_order

    position = get_position(session.session_id, session.symbol, tick_right)
    if position.side == "FLAT":
        return

    close_price = closed_ohlc["close"]

    meta = strategy.metadata
    if meta.get("only_in_profit", False):
        if position.side == "LONG" and close_price <= position.avg_entry_price:
            return  # bar closed at a loss — skip SL update
        if position.side == "SHORT" and close_price >= position.avg_entry_price:
            return

    if position.side == "LONG":
        sl_price = round(close_price * 0.99, 2)
        sl_side = TradeSide.SELL
    else:  # SHORT
        sl_price = round(close_price * 1.01, 2)
        sl_side = TradeSide.BUY

    # Find open exit orders matching side, right, and position quantity
    exit_orders = _find_open_exit_orders(session.session_id, sl_side, tick_right, position.quantity)

    if exit_orders:
        for order in exit_orders:
            _update_exit_order_price(session, order, sl_price)
        logger.info(
            "AggressiveStoploss %s updated %d exit order(s) to SL=%.2f for %s right=%s",
            strategy.strategy_id, len(exit_orders), sl_price, session.symbol, tick_right,
        )
    else:
        # Real sessions: place SL directly on Kotak so it's broker-managed immediately.
        # Sim/paper: place a local TARGET order that the tick engine monitors.
        is_real = getattr(session, "session_type", "sim") == "real" and loop is not None
        order_type = OrderType.STOPLOSS if is_real else OrderType.TARGET
        try:
            new_order = place_order(
                session_id=session.session_id,
                symbol=session.symbol,
                side=sl_side,
                order_type=order_type,
                quantity=position.quantity,
                created_at=current_ts,
                trading_date=session.date,
                trigger_price=sl_price,
                right=tick_right,
                user_id=session.user_id,
            )
            if is_real:
                try:
                    from app.services.simulation import _register_kotak_sl_for_order
                    _register_kotak_sl_for_order(session, new_order, loop)
                except Exception as k_exc:
                    logger.warning(
                        "AggressiveStoploss %s: Kotak SL registration failed: %s",
                        strategy.strategy_id, k_exc,
                    )
            logger.info(
                "AggressiveStoploss %s created %s SL at %.2f for %s right=%s",
                strategy.strategy_id, order_type.value, sl_price, session.symbol, tick_right,
            )
        except Exception as exc:
            logger.warning("AggressiveStoploss %s: place_order failed: %s", strategy.strategy_id, exc)


# ── Per-tick evaluators ───────────────────────────────────────────────────────

def _cancel_exit_and_place_limit(
    strategy: StrategyInstance,
    session,
    exit_orders: list,
    exit_side,
    limit_price: float,
    quantity: int,
    tick_right: str | None,
    current_ts: int,
    loop=None,
) -> None:
    """
    Cancel existing exit orders and place a new LIMIT order at limit_price.

    For real sessions with a Kotak SL order:
      1. Try to atomically modify SL → LIMIT via modify_sl_to_limit_order().
         On success the local order type + price are updated in-place; no new order placed.
      2. If that fails (API error), fall back to cancel the Kotak SL + re-place as Kotak LIMIT.
    For sim/paper: cancel local orders + place a local LIMIT order.
    """
    from app.services.order_service import cancel_order, place_order, update_order
    from app.models.schemas import OrderType

    is_real = getattr(session, "session_type", "sim") == "real" and loop is not None
    need_new_order = True  # set to False when atomic modify succeeds for all orders

    if exit_orders:
        need_new_order = False  # assume orders will be converted; flip back if fallback needed
        for order in exit_orders:
            kotak_id = getattr(order, "kotak_order_id", None)
            if is_real and kotak_id:
                # Preferred: atomic SL → LIMIT (no window without broker-side protection)
                try:
                    from app.services.kotak_service import get_service as get_kotak
                    get_kotak().modify_sl_to_limit_order(kotak_id, limit_price, order.quantity)
                    # Update local order to reflect the new type/price
                    update_order(
                        session_id=session.session_id,
                        order_id=order.order_id,
                        trading_date=session.date,
                        limit_price=limit_price,
                    )
                    order.order_type = OrderType.LIMIT
                    order.limit_price = limit_price
                    logger.info(
                        "Strategy %s: atomically converted Kotak SL %s → LIMIT at %.2f",
                        strategy.strategy_id, kotak_id, limit_price,
                    )
                    continue  # this order is handled; move to next
                except Exception as exc:
                    logger.warning(
                        "Strategy %s: modify_sl_to_limit failed (%s) — cancel+re-place fallback",
                        strategy.strategy_id, exc,
                    )
                    # Cancel broker-side SL
                    try:
                        get_kotak().cancel_order(kotak_id)
                    except Exception as k_exc:
                        logger.warning(
                            "Strategy %s: Kotak cancel_order %s failed: %s",
                            strategy.strategy_id, kotak_id, k_exc,
                        )

            # Cancel local order (reached for sim/paper or after real-trading fallback)
            try:
                cancel_order(session.session_id, order.order_id, session.date)
            except Exception as exc:
                logger.warning(
                    "Strategy %s: cancel_order %s failed: %s",
                    strategy.strategy_id, order.order_id, exc,
                )
            need_new_order = True  # at least one order was cancelled → place replacement

    if need_new_order:
        # Place a local LIMIT order.  For sim/paper the tick engine fills it directly.
        # For real sessions, _emit_tick_and_check_orders_real forwards it to Kotak on
        # the next tick when the LIMIT triggers (price has already passed the target).
        try:
            place_order(
                session_id=session.session_id,
                symbol=session.symbol,
                side=exit_side,
                order_type=OrderType.LIMIT,
                quantity=quantity,
                created_at=current_ts,
                trading_date=session.date,
                limit_price=limit_price,
                right=tick_right,
                strike=_session_strike(session, tick_right),
                user_id=session.user_id,
            )
            logger.info(
                "Strategy %s: placed new LIMIT %s at %.2f for %s right=%s",
                strategy.strategy_id, exit_side.value, limit_price, session.symbol, tick_right,
            )
        except Exception as exc:
            logger.warning("Strategy %s: place LIMIT order failed: %s", strategy.strategy_id, exc)


def _on_tick_breakeven(
    strategy: StrategyInstance,
    session,
    current_price: float,
    tick_right: str | None,
    current_ts: int,
    loop=None,
) -> None:
    from app.services.trading import get_position
    from app.models.schemas import TradeSide, OrderType
    from app.services.order_service import place_order

    position = get_position(session.session_id, session.symbol, tick_right)

    if position.side == "FLAT":
        strategy.status = StrategyStatus.COMPLETED
        _write_strategy_to_db(strategy)
        return

    avg_entry = position.avg_entry_price
    brokerage = getattr(session, "brokerage_per_order", 0.0)
    commission_per_share = (2.0 * brokerage) / position.quantity if position.quantity > 0 else 0.0

    # True breakeven includes round-trip commissions
    if position.side == "LONG":
        true_breakeven = avg_entry + commission_per_share
    else:
        true_breakeven = avg_entry - commission_per_share

    # New SL price: true_breakeven + execution buffer (ceiled to tick)
    new_sl_price = _ceil_tick(true_breakeven + _main_buffer(true_breakeven))

    breakeven_mode = strategy.metadata.get("breakeven_mode", "shift_sl")

    if breakeven_mode == "limit_order":
        # Trigger when price reaches new_sl_price (LONG) or true_breakeven (SHORT)
        if position.side == "LONG":
            should_protect = current_price >= new_sl_price
        else:
            should_protect = current_price <= true_breakeven
    else:  # shift_sl
        # Extra trigger_buffer ensures LTP is safely past new_sl_price for real trading
        t_buf = _trigger_buffer(true_breakeven)
        if position.side == "LONG":
            should_protect = current_price >= new_sl_price + t_buf
        else:
            should_protect = current_price <= new_sl_price - t_buf

    if not should_protect:
        return

    exit_side = TradeSide.SELL if position.side == "LONG" else TradeSide.BUY
    exit_orders = _find_open_exit_orders(session.session_id, exit_side, tick_right, position.quantity)

    if breakeven_mode == "limit_order":
        # Cancel existing SL orders and place an immediate LIMIT order at new_sl_price
        _cancel_exit_and_place_limit(
            strategy, session, exit_orders, exit_side,
            new_sl_price, position.quantity, tick_right, current_ts, loop,
        )
        strategy.status = StrategyStatus.COMPLETED
        _write_strategy_to_db(strategy)
        logger.info(
            "BreakEven %s (limit_order mode) placed LIMIT at %.2f for %s right=%s",
            strategy.strategy_id, new_sl_price, session.symbol, tick_right,
        )
    else:
        # shift_sl mode: move existing exit orders to new_sl_price
        if exit_orders:
            for order in exit_orders:
                _update_exit_order_price(session, order, new_sl_price)
            strategy.status = StrategyStatus.COMPLETED
            _write_strategy_to_db(strategy)
            logger.info(
                "BreakEven %s (shift_sl mode) moved %d exit order(s) to %.2f for %s right=%s",
                strategy.strategy_id, len(exit_orders), new_sl_price, session.symbol, tick_right,
            )
        else:
            # No existing exit order — place a new SL/TARGET at new_sl_price
            is_real = getattr(session, "session_type", "sim") == "real" and loop is not None
            order_type = OrderType.STOPLOSS if is_real else OrderType.TARGET
            try:
                new_order = place_order(
                    session_id=session.session_id,
                    symbol=session.symbol,
                    side=exit_side,
                    order_type=order_type,
                    quantity=position.quantity,
                    created_at=current_ts,
                    trading_date=session.date,
                    trigger_price=new_sl_price,
                    right=tick_right,
                    strike=_session_strike(session, tick_right),
                    user_id=session.user_id,
                )
                if is_real:
                    try:
                        from app.services.simulation import _register_kotak_sl_for_order
                        _register_kotak_sl_for_order(session, new_order, loop)
                    except Exception as k_exc:
                        logger.warning(
                            "BreakEven %s: Kotak SL registration failed: %s",
                            strategy.strategy_id, k_exc,
                        )
                strategy.status = StrategyStatus.COMPLETED
                _write_strategy_to_db(strategy)
                logger.info(
                    "BreakEven %s (shift_sl mode) placed new %s at %.2f for %s right=%s",
                    strategy.strategy_id, order_type.value, new_sl_price, session.symbol, tick_right,
                )
            except Exception as exc:
                logger.warning("BreakEven %s: place_order failed: %s", strategy.strategy_id, exc)


def _on_tick_target_profit(
    strategy: StrategyInstance,
    session,
    current_price: float,
    tick_right: str | None,
    current_ts: int,
    loop=None,
) -> None:
    from app.services.trading import get_position
    from app.models.schemas import TradeSide, OrderType
    from app.services.order_service import place_order

    position = get_position(session.session_id, session.symbol, tick_right)

    if position.side == "FLAT":
        strategy.status = StrategyStatus.COMPLETED
        _write_strategy_to_db(strategy)
        return

    meta = strategy.metadata
    raw_value = float(meta.get("target_profit_value", 0))
    is_pct = bool(meta.get("target_profit_is_pct", False))
    buffer_ticks = int(meta.get("target_profit_buffer_ticks", 3))

    avg_entry = position.avg_entry_price

    if is_pct:
        session_capital = float(getattr(session, "session_capital", 0))
        target_pnl = (raw_value / 100.0) * session_capital
        if position.quantity <= 0:
            return
        if position.side == "LONG":
            target_price = _ceil_tick(avg_entry + target_pnl / position.quantity)
        else:
            target_price = _ceil_tick(avg_entry - target_pnl / position.quantity)
    else:
        target_price = _ceil_tick(raw_value)

    tick_buffer = buffer_ticks * _TICK_SIZE
    if position.side == "LONG":
        triggered = current_price >= target_price + tick_buffer
    else:
        triggered = current_price <= target_price - tick_buffer

    if not triggered:
        return

    exit_side = TradeSide.SELL if position.side == "LONG" else TradeSide.BUY
    exit_orders = _find_open_exit_orders(session.session_id, exit_side, tick_right, position.quantity)

    if exit_orders:
        _cancel_exit_and_place_limit(
            strategy, session, exit_orders, exit_side,
            target_price, position.quantity, tick_right, current_ts, loop,
        )
    else:
        # No existing exit order — place new LIMIT order directly.
        # Real sessions: forwarded to Kotak on next tick via _emit_tick_and_check_orders_real.
        try:
            place_order(
                session_id=session.session_id,
                symbol=session.symbol,
                side=exit_side,
                order_type=OrderType.LIMIT,
                quantity=position.quantity,
                created_at=current_ts,
                trading_date=session.date,
                limit_price=target_price,
                right=tick_right,
                strike=_session_strike(session, tick_right),
                user_id=session.user_id,
            )
            logger.info(
                "TargetProfit %s: placed new LIMIT %s at %.2f for %s right=%s",
                strategy.strategy_id, exit_side.value, target_price, session.symbol, tick_right,
            )
        except Exception as exc:
            logger.warning("TargetProfit %s: place LIMIT failed: %s", strategy.strategy_id, exc)
            return

    strategy.status = StrategyStatus.COMPLETED
    _write_strategy_to_db(strategy)
    logger.info(
        "TargetProfit %s completed: target=%.2f trigger=%.2f for %s right=%s",
        strategy.strategy_id, target_price, current_price, session.symbol, tick_right,
    )
