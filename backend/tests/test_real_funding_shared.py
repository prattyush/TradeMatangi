import pytest
from app.models.schemas import Trade, TradeSide
from app.services import order_service, real_funding, simulation, trading
from app.services import swing_funding_store as store
from fastapi import HTTPException

from tests.test_swing_portfolio_store import db  # noqa: F401


@pytest.fixture
def books(db, monkeypatch):  # noqa: F811 - imported pytest fixture
    monkeypatch.setattr(simulation, "_sessions", {})
    monkeypatch.setattr(trading, "_trades", {})
    monkeypatch.setattr(order_service, "_orders", {})
    row = store.initialize("day-user", "kite", "account", 100000)
    store.start_participant(
        "day-user", "kite", "account", row["period_id"], "intraday", "day", 0.2
    )
    store.start_participant(
        "swing-user", "kite", "account", row["period_id"], "swing", "portfolio", 0.8
    )
    day = simulation.SimulationSession(
        "day",
        "HDFCBANK",
        "2026-10-11",
        "09:15:00",
        1,
        user_id="day-user",
        session_type="real",
        execution_broker="kite",
        broker_account_id="account",
        real_funding_period=row["period_id"],
    )
    swing = simulation.SimulationSession(
        "child",
        "HDFCBANK",
        "2026-10-11",
        "09:15:00",
        1,
        user_id="swing-user",
        session_type="real",
        execution_broker="kite",
        broker_account_id="account",
        trading_style="swing",
        portfolio_id="portfolio",
        real_funding_period=row["period_id"],
    )
    simulation._sessions.update({day.session_id: day, swing.session_id: swing})
    trading._trades.update({"day": [], "child": []})
    real_funding.reconcile(day, 100000)
    real_funding.reconcile(swing, 100000)
    return day, swing, row


def fill(session, side, price, quantity):
    trading._trades[session.session_id].append(
        Trade(
            session_id=session.session_id,
            user_id=session.user_id,
            symbol=session.symbol,
            side=side,
            quantity=quantity,
            price=price,
            timestamp=1,
            commission=0,
            session_type="real",
        )
    )


def test_swing_full_principal_and_day_margin_share_one_cash_expectation(books):
    day, swing, _ = books
    fill(swing, TradeSide.BUY, 100, 200)
    row = real_funding.reconcile(swing, 80000)
    assert row["funding"]["modes"]["swing"]["expected_balance"] == 60000
    assert row["funding_status"]["entries_allowed"]
    fill(day, TradeSide.BUY, 100, 100)
    row = real_funding.reconcile(day, 78000)
    assert row["funding"]["modes"]["intraday"]["expected_balance"] == 18000
    assert row["funding_status"]["expected_balance"] == 78000
    assert row["funding_status"]["entries_allowed"]


def test_shortfall_blocks_both_owners_and_incomplete_reports_are_pending(books):
    day, swing, _ = books
    row = real_funding.reconcile(day, 99000)
    assert row["funding_status"]["state"] == "shortfall"
    for session in (day, swing):
        with pytest.raises(HTTPException):
            real_funding.require_entry(session)
    row = real_funding.reconcile(day, 99000, coherent=False)
    assert row["funding_status"]["state"] == "pending"
    assert row["funding_status"]["shortfall"] is None


def test_reservation_cannot_exceed_selected_mode_or_edit_sibling(books):
    day, swing, _ = books
    real_funding.reserve(day, "one", 15000)
    from app.services.wallet_service import InsufficientFundsError
    with pytest.raises(InsufficientFundsError):
        real_funding.reserve(day, "two", 6000)
    shared = store.read(swing.user_id, "kite", "account")
    assert shared["funding"]["modes"]["swing"]["capital"] == 80000
    with pytest.raises(HTTPException):
        store.change_allocation(
            swing.user_id, "kite", "account", "intraday", "day", 0.1, "bad-edit"
        )
    with pytest.raises(HTTPException):
        store.change_allocation(
            day.user_id, "kite", "account", "intraday", "day", 0.1, "too-small"
        )
    real_funding.reserve(day, "one", 0)
    changed = store.change_allocation(
        day.user_id, "kite", "account", "intraday", "day", 0.1, "release"
    )
    assert changed["funding"]["modes"]["intraday"]["capital"] == 10000
    assert changed["funding"]["modes"]["swing"]["capital"] == 80000


def test_retry_fill_snapshot_does_not_debit_twice_and_profit_does_not_raise_capital(
    books,
):
    _, swing, _ = books
    fill(swing, TradeSide.BUY, 100, 200)
    first = real_funding.reconcile(swing, 80000)
    retry = real_funding.reconcile(swing, 80000)
    assert first["version"] == retry["version"]
    fill(swing, TradeSide.SELL, 110, 200)
    changed = real_funding.reconcile(swing, 102000)
    assert changed["funding"]["modes"]["swing"]["expected_balance"] == 80000
    assert changed["funding"]["modes"]["swing"]["capital"] == 80000
    assert changed["funding"]["modes"]["swing"]["ignored_profit"] == 2000


def test_new_day_owner_inherits_closed_day_losses_while_swing_runs(books):
    day, _, row = books
    fill(day, TradeSide.BUY, 100, 100)
    fill(day, TradeSide.SELL, 90, 100)
    real_funding.reconcile(day, 99000)
    store.close_participant(
        day.user_id, "kite", "account", row["period_id"], "intraday", "day"
    )
    changed = store.start_participant(
        "next-user", "kite", "account", row["period_id"], "intraday", "next-day", 0.2
    )
    assert changed["participants"]["intraday"]["baseline_balance"] == 19000
    assert changed["funding"]["modes"]["intraday"]["capital"] == 20000


def test_unknown_broker_effect_blocks_both_owners_until_verified(books):
    day, swing, _ = books
    real_funding.reconcile(day, 100000)
    real_funding.mark_pending(day)
    for session in (day, swing):
        with pytest.raises(HTTPException):
            real_funding.require_entry(session)
    row = real_funding.reconcile(day, 100000)
    assert row["funding_status"]["entries_allowed"]


def test_sibling_refresh_cannot_clear_an_unconfirmed_mode(books):
    day, swing, _ = books
    real_funding.mark_pending(day)
    changed = real_funding.reconcile(swing, 99999)
    assert changed["funding_status"]["state"] == "pending"
    assert not changed["funding_status"]["entries_allowed"]


def test_gap_margin_overrun_blocks_entries_until_explicit_reallocation(books):
    day, swing, _ = books
    fill(day, TradeSide.SELL, 100, 2000)
    changed = real_funding.reconcile(day, 60000)
    assert changed["funding_status"]["state"] == "allocation_shortfall"
    assert changed["funding_status"]["allocation_shortfall"] == 20000
    for session in (day, swing):
        with pytest.raises(HTTPException):
            real_funding.require_entry(session)
    store.change_allocation(
        swing.user_id, "kite", "account", "swing", "portfolio", 0.4, "free-share"
    )
    store.change_allocation(
        day.user_id, "kite", "account", "intraday", "day", 0.6, "increase-share"
    )
    assert real_funding.reconcile(day, 60000)["funding_status"]["entries_allowed"]
