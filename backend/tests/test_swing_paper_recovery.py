"""Actual attempt windows, not backend-offline days, own simulated exit fills."""

from datetime import datetime, timezone
import pytest
from app.models.schemas import TradeSide, OrderType, OrderStatus
from app.services import swing_paper_recovery as recovery
from app.services import (
    swing_portfolio_service as service,
    swing_portfolio_store as store,
)
from app.services import order_service, trading
from tests.test_swing_paper_runtime import db, tick, entry  # noqa: F401


def stamp(value):
    return int(datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp())


async def held():
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    entry(child, 100)
    await service.on_tick(
        service.runtime("u", parent["session_id"]), child, tick("2026-11-02", 100)
    )
    return parent, child


def exit_order(child, kind=OrderType.LIMIT):
    return order_service.place_order(
        child.session_id,
        child.symbol,
        TradeSide.SELL,
        kind,
        10,
        stamp("2026-11-02T15:01:00"),
        child.date,
        **({"limit_price": 110} if kind == OrderType.LIMIT else {"trigger_price": 95}),
        user_id="u",
        wallet_ledger_id=child.wallet_ledger_id,
        wallet_ledger_kind="paper",
    )


@pytest.mark.asyncio
async def test_recovery_uses_only_valid_day_then_renews_at_current_quote(db):
    parent, child = await held()
    order = exit_order(child)
    windows = []

    def prices(order, date, start, end):
        windows.append((date, start, end))
        return []

    quote = {**tick("2026-11-04", 105)}
    recovery.before_quote(child, quote, loader=prices)
    assert windows == [
        ("2026-11-02", stamp("2026-11-02T15:01:00"), stamp("2026-11-02T15:29:59"))
    ]
    assert order.status == OrderStatus.PENDING
    assert [a["date"] for a in order.swing_attempts] == ["2026-11-02", "2026-11-04"]
    assert order.swing_attempts[0]["state"] == "expired"
    assert order.swing_attempts[-1]["start"] == quote["time"]
    assert "2026-11-03" not in [a["date"] for a in order.swing_attempts]


@pytest.mark.asyncio
async def test_confirmed_offline_exit_repairs_at_observed_price_without_old_entry_or_strategy(
    db, monkeypatch
):
    parent, child = await held()
    order = exit_order(child)
    pending = entry(child, 80, 1)
    strategy_calls = []
    monkeypatch.setattr(
        "app.services.strategy_service.on_tick", lambda *a: strategy_calls.append(a)
    )
    # Price 80 would trigger the local entry; 112 executes the resting sell.
    evidence = [
        {**tick("2026-11-02", 80), "time": stamp("2026-11-02T15:02:00")},
        {**tick("2026-11-02", 112), "time": stamp("2026-11-02T15:03:00")},
    ]
    assert recovery.recover_order(
        child, order, stamp("2026-11-04T10:00:00"), lambda *a: evidence
    )
    assert order.status == OrderStatus.FILLED
    assert trading.get_trades(child.session_id)[-1].price == 112
    assert trading.get_trades(child.session_id)[-1].timestamp == evidence[-1]["time"]
    assert pending.status == OrderStatus.PENDING
    assert not strategy_calls


@pytest.mark.asyncio
async def test_missing_history_blocks_renewal_and_entries_without_fake_fill(db):
    parent, child = await held()
    order = exit_order(child)

    def missing(*a):
        raise FileNotFoundError("No observed seconds")

    recovery.before_quote(child, tick("2026-11-04", 120), loader=missing)
    assert order.status == OrderStatus.PENDING and order.swing_reconcile_pending
    assert len(order.swing_attempts) == 1
    assert len(trading.get_trades(child.session_id)) == 1
    with pytest.raises(Exception):
        entry(child, 80, 1)
    snapshot = service.snapshot("u", parent["session_id"])
    assert snapshot["reconciliation_pending"] == [order.order_id]


@pytest.mark.asyncio
async def test_recovery_stop_limit_gap_needs_later_executable_evidence(db):
    parent, child = await held()
    order = exit_order(child, OrderType.STOPLOSS)
    evidence = [
        {**tick("2026-11-02", 90), "time": stamp("2026-11-02T15:02:00")},
        {**tick("2026-11-02", 94), "time": stamp("2026-11-02T15:03:00")},
    ]
    recovery.recover_order(
        child, order, stamp("2026-11-04T10:00:00"), lambda *a: evidence
    )
    assert order.status == OrderStatus.PENDING
    assert order.stop_triggered_at == evidence[0]["time"]
    assert len(trading.get_trades(child.session_id)) == 1


@pytest.mark.asyncio
async def test_invalid_evidence_cannot_commit_an_earlier_possible_fill(db):
    parent, child = await held()
    order = exit_order(child)
    evidence = [
        {**tick("2026-11-02", 112), "time": stamp("2026-11-02T15:02:00")},
        {**tick("2026-11-02", 100), "time": stamp("2026-11-02T15:01:00")},
    ]
    assert not recovery.recover_order(
        child, order, stamp("2026-11-04T10:00:00"), lambda *a: evidence
    )
    assert order.status == OrderStatus.PENDING
    assert len(trading.get_trades(child.session_id)) == 1


def test_market_window_rejects_closed_hours_and_weekend():
    assert recovery.day_window(stamp("2026-11-02T09:15:00"))
    assert recovery.day_window(stamp("2026-11-02T15:15:00"))
    assert not recovery.day_window(stamp("2026-11-02T15:30:00"))
    assert not recovery.day_window(stamp("2026-11-07T10:00:00"))


@pytest.mark.asyncio
async def test_amendment_keeps_old_day_window_instructions_for_recovery(db):
    parent, child = await held()
    order = exit_order(child)
    child.current_time = str(stamp("2026-11-02T15:03:00"))
    order_service.update_order(
        child.session_id, order.order_id, child.date, limit_price=120
    )
    assert order.swing_attempts[0]["limit_price"] == 110
    assert order.swing_attempts[1]["limit_price"] == 120
    assert order.swing_attempts[0]["end"] == order.swing_attempts[1]["start"]
    evidence = [{**tick("2026-11-02", 112), "time": stamp("2026-11-02T15:02:00")}]
    assert recovery.recover_order(
        child, order, stamp("2026-11-04T10:00:00"), lambda *a: evidence
    )
    assert order.status == OrderStatus.FILLED
    assert trading.get_trades(child.session_id)[-1].price == 112


@pytest.mark.asyncio
async def test_unreconciled_attempt_cannot_be_retroactively_edited(db):
    parent, child = await held()
    order = exit_order(child)
    order.swing_reconcile_pending = True
    with pytest.raises(Exception):
        order_service.update_order(
            child.session_id, order.order_id, child.date, limit_price=120
        )
    assert order.limit_price == 110


def test_observation_provenance_survives_gap_fill_and_parquet(tmp_path):
    import pandas as pd
    from app.services.data_loader import (
        attach_observation_provenance,
        validate_and_fill_gaps,
    )

    frame = pd.DataFrame(
        {
            "open": [100, 101, 102],
            "high": [100, 101, 102],
            "low": [100, 101, 102],
            "close": [100, 101, 102],
        },
        index=pd.to_datetime(
            ["2026-11-02 09:15:00", "2026-11-02 09:15:01", "2026-11-02 09:15:03"]
        ),
    )
    frame = attach_observation_provenance(frame)
    frame = validate_and_fill_gaps(frame, "2026-11-02", partial=True)
    assert not frame.loc["2026-11-02 09:15:02", "observed"]
    path = tmp_path / "seconds.parquet"
    frame.to_parquet(path)
    restored = pd.read_parquet(path)
    assert restored.attrs["native_interval_seconds"] == 1
    assert int(restored.observed.sum()) == 3


def test_minute_rows_do_not_become_native_seconds_after_gap_fill():
    import pandas as pd
    from app.services.data_loader import (
        attach_observation_provenance,
        validate_and_fill_gaps,
    )

    frame = pd.DataFrame(
        {
            "open": [100, 101],
            "high": [100, 101],
            "low": [100, 101],
            "close": [100, 101],
        },
        index=pd.to_datetime(["2026-11-02 09:15:00", "2026-11-02 09:16:00"]),
    )
    frame = validate_and_fill_gaps(
        attach_observation_provenance(frame), "2026-11-02", partial=True
    )
    assert len(frame) == 61
    assert frame.attrs["native_interval_seconds"] == 60
    assert int(frame.observed.sum()) == 2
