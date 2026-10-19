"""Target-profit sizing reuses Capital sizing's lot and funding behavior."""
import math
from decimal import Decimal
from app.services.order_service import compute_capital_units_quantity


def quantity(*, symbol, capital, target_pct, entry, target, side, reservation_price,
             wallet, lot_size, margin_rate):
    if not all(math.isfinite(v) and v > 0 for v in (capital, target_pct, entry, target, reservation_price)):
        raise ValueError('Target sizing requires positive finite capital, percentage and prices')
    distance = (target - entry) if side == 'BUY' else (entry - target)
    if distance <= 0:
        raise ValueError('BUY target must be above the market price; SELL target must be below it')
    # Decimal inputs avoid dropping a whole lot at an exact sizing boundary.
    distance = abs(Decimal(str(target)) - Decimal(str(entry)))
    units = Decimal(str(capital)) * Decimal(str(target_pct)) / 100 / distance / lot_size
    # Profit per unit is unleveraged. Margin is used only for funded minimums
    # here, and the existing reservation path checks total required funds.
    return compute_capital_units_quantity(units, reservation_price, wallet, lot_size, margin_rate)


def projected(meta, price, quantity):
    target = meta.get('sizing_target_price')
    if meta.get('sizing_method') != 'TARGET_PERCENT' or target is None:
        return
    direction = 1 if meta.get('side') == 'BUY' else -1
    profit = direction * (float(target) - price) * quantity
    meta['projected_target_profit'] = profit
    capital = meta.get('capital') or 0
    meta['effective_target_pct'] = profit * 100 / capital if capital else None
