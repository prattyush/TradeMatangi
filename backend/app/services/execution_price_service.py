"""Broker-independent limits for real target, market and stoploss execution."""
import math
from decimal import Decimal, ROUND_HALF_UP

from app.models.schemas import OrderType, TradeSide


def limit_price(side, base: float, gap: float, tick_size: float = 0.05) -> float:
    if not math.isfinite(base) or base <= 0:
        raise ValueError("Execution base price must be finite and positive")
    if not math.isfinite(gap) or not 0 <= gap <= 0.10:
        raise ValueError("Execution gap must be between 0 and 10%")
    if not math.isfinite(tick_size) or tick_size <= 0:
        raise ValueError("Tick size must be finite and positive")
    multiplier = Decimal('1') + (Decimal(str(gap)) if side == TradeSide.BUY else -Decimal(str(gap)))
    tick = Decimal(str(tick_size))
    result = (Decimal(str(base)) * multiplier / tick).quantize(Decimal('1'), rounding=ROUND_HALF_UP) * tick
    if result <= 0:
        raise ValueError("Execution limit rounds to zero")
    return float(result)


def gap_for(user_id: str, stoploss: bool = False) -> float:
    from app.services.user_settings_service import get_settings
    key, default = ('stoploss_limit_gap_pct', 0.015) if stoploss else ('target_deviation_pct', 0.01)
    gap = float(get_settings(user_id).get(key, default))
    if not math.isfinite(gap) or not 0 <= gap <= 0.10:
        raise ValueError("Execution gap must be between 0 and 10%")
    return gap


def real_session(session_id: str, wallet_ledger_kind=None) -> bool:
    if wallet_ledger_kind == 'real':
        return True
    from app.services.simulation import get_session
    session = get_session(session_id)
    return bool(session and session.session_type == 'real')


def reprice_trigger(order) -> None:
    """Prepare a candidate before broker acknowledgement; never alter the cached order."""
    if order.order_type in (OrderType.TARGET, OrderType.STOPLOSS):
        order.execution_gap_pct = gap_for(order.user_id, order.order_type == OrderType.STOPLOSS)
        order.limit_price = limit_price(order.side, order.trigger_price, order.execution_gap_pct)
    else:
        order.execution_gap_pct = None
        order.market_order = False
