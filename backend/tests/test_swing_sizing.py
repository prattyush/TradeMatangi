import math

import pytest
from app.services.swing_sizing import capital_quantity


def test_fees_and_whole_lots_are_in_budget():
    result = capital_quantity(100000, 0.10, 100, 25)
    assert result["quantity"] == 75
    assert result["required_funds"] <= result["budget"]
    assert result["unused_budget"] + result["required_funds"] == result["budget"]
    assert result["fees"] > 0


def test_zero_lot_budget_reports_minimum_without_upsize():
    result = capital_quantity(100, 0.10, 100, 25)
    assert result["quantity"] == 0
    assert result["minimum_funds"] > result["budget"]
    assert result["fees"] == 0


@pytest.mark.parametrize(
    "capital,pct,price,lot,brokerage",
    [
        (math.nan, 0.1, 10, 1, 1),
        (100, math.inf, 10, 1, 1),
        (100, 0.1, 0, 1, 1),
        (100, 0.1, 10, 0, 1),
        (100, 0.1, 10, 1, -1),
        (100, 1.01, 10, 1, 1),
    ],
)
def test_invalid_sizing_is_rejected(capital, pct, price, lot, brokerage):
    with pytest.raises(ValueError):
        capital_quantity(capital, pct, price, lot, brokerage)
