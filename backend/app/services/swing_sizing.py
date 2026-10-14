"""Whole-lot capital sizing using the existing fully funded Swing cost model."""

import math

from app.models.schemas import TradeSide
from app.services.trading import compute_commission


def capital_quantity(capital, percentage, price, lot_size=1, brokerage=1.0):
    values = (capital, percentage, price, brokerage)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("Sizing requires finite capital, percentage, price and fees")
    if capital <= 0 or not 0 < percentage <= 1 or price <= 0 or brokerage < 0:
        raise ValueError(
            "Enter positive capital/price and a percentage above 0 through 100"
        )
    if not isinstance(lot_size, int) or lot_size < 1:
        raise ValueError("A valid listed lot size is required")
    budget = capital * percentage

    def cost(lots):
        quantity = lots * lot_size
        fees = compute_commission(TradeSide.BUY, price, quantity, brokerage)
        return quantity * price + fees

    lower, upper = 0, math.floor(budget / price / lot_size)
    while lower < upper:
        middle = (lower + upper + 1) // 2
        if cost(middle) <= budget:
            lower = middle
        else:
            upper = middle - 1
    quantity = lower * lot_size
    fees = (
        compute_commission(TradeSide.BUY, price, quantity, brokerage) if quantity else 0
    )
    return {
        "quantity": quantity,
        "lot_size": lot_size,
        "budget": round(budget, 4),
        "fees": fees,
        "required_funds": round(quantity * price + fees, 4),
        "unused_budget": round(budget - quantity * price - fees, 4),
        "minimum_funds": round(cost(1), 4),
    }
