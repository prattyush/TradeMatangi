import pytest
from app.services import swing_accounting as funding


def test_later_intraday_allocation_uses_original_reference_after_swing_loss_and_purchase():
    state = funding.allocate(funding.create(1_000_000), "swing", 0.8)
    state = funding.movement(state, "swing", -200_000)
    state = funding.movement(state, "swing", -3000, -3000)
    state = funding.allocate(state, "intraday", 0.2)
    assert state["modes"]["swing"]["capital"] == 800_000
    assert state["modes"]["swing"]["expected_balance"] == 597_000
    assert state["modes"]["intraday"]["capital"] == 200_000
    assert funding.status(state, 797_000)["entries_allowed"]
    assert funding.status(state, 747_000)["shortfall"] == 50_000


def test_profit_is_recorded_but_does_not_inflate_expected_funds():
    state = funding.allocate(funding.create(100_000), "swing", 0.8)
    state = funding.movement(state, "swing", -20_000)
    state = funding.movement(state, "swing", 25_000, 5000)
    assert funding.expected_balance(state) == 100_000
    assert state["modes"]["swing"]["realized_pnl"] == 5000
    assert funding.status(state, 100_000)["entries_allowed"]
    assert funding.status(state, 105_000)["entries_allowed"]


def test_partial_then_full_selected_correction_keeps_sibling_unchanged():
    state = funding.allocate(
        funding.allocate(funding.create(1_000_000), "swing", 0.8), "intraday", 0.2
    )
    state = funding.correct(
        state, "swing", 775_000, -25_000, "Withdrawal acknowledged", 800_000
    )
    assert funding.status(state, 950_000)["shortfall"] == 25_000
    state = funding.correct(
        state, "swing", 750_000, -25_000, "Remaining withdrawal", 800_000
    )
    assert funding.status(state, 950_000)["entries_allowed"]
    assert state["modes"]["intraday"]["capital"] == 200_000
    assert state["modes"]["intraday"]["guardrail_epoch"] == 0


def test_reference_edit_does_not_silently_clear_funding_shortfall():
    state = funding.allocate(funding.create(100_000), "swing", 0.8)
    changed = funding.correct(
        state, "swing", 70_000, 0, "Sizing reference only", 80_000
    )
    assert funding.status(changed, 90_000)["shortfall"] == 10_000
    assert state["modes"]["swing"]["capital"] == 80_000


def test_guardrails_are_session_period_based_and_explicit_reset_preserves_pnl():
    state = funding.allocate(funding.create(100_000), "swing", 0.8)
    state = funding.movement(state, "swing", -8000, -8000)
    assert funding.loss_limit_reached(state, "swing", 72_000, 0.1)
    state = funding.correct(state, "swing", 80_000, 0, "Reset guardrail period", 72_000)
    assert not funding.loss_limit_reached(state, "swing", 72_000, 0.1)
    assert state["modes"]["swing"]["realized_pnl"] == -8000


def test_incoherent_broker_reports_are_not_a_confirmed_withdrawal():
    state = funding.allocate(funding.create(100_000), "swing", 0.8)
    result = funding.status(state, 50_000, coherent=False)
    assert result["state"] == "pending" and result["shortfall"] is None
    assert not result["entries_allowed"]


def test_allocations_cannot_overlap_or_accept_nonfinite_money():
    state = funding.allocate(funding.create(100_000), "swing", 0.8)
    with pytest.raises(ValueError):
        funding.allocate(state, "intraday", 0.3)
    with pytest.raises(ValueError):
        funding.create(float("nan"))
    with pytest.raises(ValueError):
        funding.allocate(state, "intraday", float("inf"))


def test_reference_edit_redistributes_attribution_without_creating_or_destroying_cash():
    state = funding.allocate(funding.create(100_000), "swing", 0.8)
    state = funding.correct(state, "swing", 70_000, 0, "Lower sizing reference", 80_000)
    assert state["modes"]["swing"]["expected_balance"] == 70_000
    assert state["unallocated_balance"] == 30_000
    state = funding.allocate(state, "intraday", 0.3)
    assert state["unallocated_balance"] == 0
    assert funding.expected_balance(state) == 100_000
