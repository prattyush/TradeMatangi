import pytest
from app.services.futures_ledger import apply_fill, apply_settlement, empty, values


def test_margin_mtm_partial_close_and_final_close_never_double_count_profit():
    state, cash = apply_fill(empty(), "entry", "BUY", 10, 10, 200, 2, 1)
    assert cash == -202
    available = 1000 + cash
    assert (
        available
        + values(state, 10)["held_margin"]
        + values(state, 10)["unsettled_pnl"]
        == 998
    )
    state, cash = apply_settlement(state, "2026-10-12", 12)
    assert cash == 20
    available += cash
    duplicate, cash = apply_settlement(state, "2026-10-12", 12)
    assert cash == 0 and duplicate == state
    state, cash = apply_fill(state, "partial", "SELL", 4, 11, 0, 1, 2)
    assert cash == 75
    available += cash
    result = values(state, 11)
    assert result["held_margin"] == 120 and result["unsettled_pnl"] == -6
    assert available + result["held_margin"] + result["unsettled_pnl"] == 1007
    assert result["economic_pnl"] == 7
    state, cash = apply_fill(state, "final", "SELL", 6, 9, 0, 1, 3)
    available += cash
    assert values(state)["quantity"] == 0
    assert available == 994
    assert values(state)["economic_pnl"] == -6


def test_short_futures_lock_margin_and_profit_when_price_falls():
    state, cash = apply_fill(empty(), "short", "SELL", 5, 100, 200, 2, 1)
    assert cash == -202
    state, cash = apply_settlement(state, "2026-10-12", 90)
    assert cash == 50
    state, cash = apply_fill(state, "cover", "BUY", 5, 80, 0, 1, 2)
    assert cash == 249
    assert values(state)["economic_pnl"] == 97


def test_conflicting_fill_settlement_and_cross_flat_reversal_are_rejected():
    state, _ = apply_fill(empty(), "entry", "BUY", 5, 100, 200, 2, 1)
    with pytest.raises(ValueError, match="reversing"):
        apply_fill(state, "bad", "SELL", 10, 110, 200, 1, 2)
    with pytest.raises(ValueError, match="conflicting"):
        apply_fill(state, "entry", "BUY", 5, 101, 200, 2, 1)
    state, _ = apply_settlement(state, "2026-10-12", 110)
    with pytest.raises(ValueError, match="changed"):
        apply_settlement(state, "2026-10-12", 111)
