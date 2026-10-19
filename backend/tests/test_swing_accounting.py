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


def test_capital_reference_reset_after_loss_does_not_lose_cash_twice():
    state = funding.allocate(funding.create(100000), "swing", 0.8)
    state = funding.movement(state, "swing", -8000, -8000)
    before = funding.expected_balance(state)
    changed = funding.reset_reference(state, "swing", 72000, 72000)
    assert changed["modes"]["swing"]["capital"] == 72000
    assert changed["modes"]["swing"]["expected_balance"] == 72000
    assert funding.expected_balance(changed) == before
    assert changed["unallocated_balance"] == 20000


def test_opening_inventory_recognizes_mode_budget_without_debiting_broker_cash():
    state = funding.allocate(funding.create(100000), "swing", 0.8)
    before = funding.expected_balance(state)
    state = funding.adopt_opening_inventory(state, "swing", 20000)
    assert funding.expected_balance(state) == before
    assert state["modes"]["swing"]["expected_balance"] == 60000
    assert state["unallocated_balance"] == 40000
    assert state["allocation_reference"] == 120000
    state = funding.allocate(state, "intraday", 0.2)
    assert state["modes"]["intraday"]["capital"] == 24000
    assert funding.expected_balance(state) == 100000


def test_local_reservation_and_broker_reservation_are_not_double_charged():
    state = funding.allocate(funding.create(100000), "swing", 0.8)
    local = funding.reserve(state, "swing", "order", 20000)
    assert funding.mode_available(local, "swing") == 60000
    assert funding.expected_balance(local) == 100000
    broker = funding.reserve(local, "swing", "order", 20000, owner="broker")
    assert funding.mode_available(broker, "swing") == 60000
    assert funding.expected_balance(broker) == 80000
    filled = funding.release(
        funding.movement(broker, "swing", -20000), "swing", "order"
    )
    assert funding.expected_balance(filled) == 80000
    assert funding.mode_available(filled, "swing") == 60000


def test_profit_acknowledgement_preserves_mode_cash_and_trade_pnl():
    state = funding.allocate(funding.create(100000), "swing", 0.8)
    state = funding.movement(state, "swing", -20000)
    state = funding.movement(state, "swing", -0.5, -0.5)
    state = funding.movement(state, "swing", 25000, 5000)
    state = funding.movement(state, "swing", -0.5, -0.5)
    assert funding.mode_available(state, "swing") == 84999
    corrected = funding.correct(
        state, "swing", 84999, 5000, "Acknowledge usable gains", 84999
    )
    assert funding.mode_available(corrected, "swing") == 84999
    assert corrected["modes"]["swing"]["expected_balance"] == 84999
    assert corrected["modes"]["swing"]["realized_pnl"] == 4999
    assert corrected["unallocated_balance"] == 20000


def test_reassigning_shared_gains_does_not_create_funds_or_change_sibling_reference():
    state = funding.allocate(
        funding.allocate(funding.create(100000), "swing", 0.8), "intraday", 0.2
    )
    state = funding.movement(state, "swing", 5000, 5000)
    corrected = funding.correct(
        state, "intraday", 25000, 5000, "Assign shared surplus to intraday", 25000
    )
    assert corrected["modes"]["swing"]["capital"] == 80000
    assert corrected["modes"]["swing"]["realized_pnl"] == 5000
    assert (
        funding.mode_available(corrected, "swing")
        + funding.mode_available(corrected, "intraday")
        == 105000
    )
