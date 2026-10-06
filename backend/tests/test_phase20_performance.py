from copy import deepcopy
from types import SimpleNamespace
import pytest
from app.services.performance_service import build_cycles, report
from app.services.execution_analytics import snapshot

SESSION = dict(
    session_id="test",
    user_id="u",
    symbol="TEST",
    date="2026-10-06",
    session_capital=10000,
    session_type="sim",
)


def fill(identifier, side, quantity, price, time=None, fee=0, **kw):
    return dict(
        trade_id=str(identifier),
        side=side,
        quantity=quantity,
        price=price,
        timestamp=time or int(identifier),
        commission=fee,
        **kw
    )


def test_fifo_40_80_exit_60():
    cycles = build_cycles(
        SESSION,
        [
            fill(1, "BUY", 40, 100, fee=4),
            fill(2, "BUY", 80, 110, fee=8),
            fill(3, "SELL", 60, 120, fee=6),
        ],
    )
    c = cycles[0]
    assert [m["quantity"] for m in c["matches"]] == [40, 20]
    assert c["open_quantity"] == 60
    assert c["net_pnl"] == pytest.approx(988)
    assert c["open_entry_fees"] == pytest.approx(6)


def test_open_purchase_is_not_realized_loss():
    c = build_cycles(SESSION, [fill(1, "BUY", 40, 100, fee=4)])[0]
    assert c["net_pnl"] == 0 and c["open_entry_fees"] == 4


@pytest.mark.parametrize(
    "side,opposite,entry,exit", [("BUY", "SELL", 100, 110), ("SELL", "BUY", 110, 100)]
)
def test_reversal_splits_cycle_and_fees(side, opposite, entry, exit):
    cs = build_cycles(
        SESSION, [fill(1, side, 40, entry, fee=4), fill(2, opposite, 60, exit, fee=6)]
    )
    assert len(cs) == 2 and cs[0]["state"] == "closed" and cs[1]["state"] == "open"
    assert (
        cs[0]["net_pnl"] == 392
        and cs[1]["open_quantity"] == 20
        and cs[1]["open_entry_fees"] == 2
    )


def test_real_execution_interleaving_over_order_average():
    rows = [
        fill(1, "BUY", 40, 100, kotak_order_id="entry", execution_id="1"),
        fill(2, "SELL", 40, 120, execution_id="2"),
        fill(3, "BUY", 40, 110, kotak_order_id="entry", execution_id="3"),
    ]
    cs = build_cycles(SESSION, rows)
    assert cs[0]["net_pnl"] == 800 and cs[1]["entries"][0]["average_price"] == 110


def test_duplicate_and_conflicting_duplicate():
    row = fill(1, "BUY", 40, 100)
    assert build_cycles(SESSION, [row, row])[0]["open_quantity"] == 40
    with pytest.raises(ValueError, match="Conflicting"):
        build_cycles(SESSION, [row, {**row, "price": 101}])


def test_exact_contracts_are_separate():
    rows = [
        fill(1, "BUY", 40, 100, right="CE", strike=100, expiry="2026-10-08"),
        fill(2, "BUY", 40, 100, right="CE", strike=110, expiry="2026-10-08"),
        fill(3, "SELL", 40, 110, right="CE", strike=100, expiry="2026-10-08"),
    ]
    cs = build_cycles(SESSION, rows)
    assert len(cs) == 2 and cs[0]["state"] == "closed" and cs[1]["state"] == "open"


@pytest.mark.parametrize("mode", ["sim", "stepwise", "paper", "real"])
@pytest.mark.parametrize("client", ["website", "desktop"])
def test_modes_and_clients_keep_sizing(mode, client):
    session = SimpleNamespace(
        session_capital=10000,
        session_type=mode,
        strategy_interval_secs=300,
        desktop_origin="desktop_replay" if client == "desktop" else None,
    )
    meta = snapshot(
        session,
        quantity=40,
        price=100,
        side="BUY",
        risk_fraction=0.02,
        stop=95,
        entry_method="AUTOSTOP_LIMIT",
    )
    cs = build_cycles(
        {**SESSION, "session_type": mode},
        [
            fill(1, "BUY", 40, 100, analytics=meta),
            fill(2, "SELL", 40, 110, analytics={**meta, "exit_method": "TargetProfit"}),
        ],
    )
    e = cs[0]["entries"][0]
    assert (
        e["client"] == client
        and e["requested_pct"] == 2
        and e["sizing_method"] == "RISK"
    )
    assert e["r_multiple"] == 2
    assert report(cs)["summary"]["count"] == 1


def test_unlabeled_stats_and_overlap_context():
    cs = build_cycles(
        SESSION,
        [
            fill(1, "BUY", 40, 100, analytics={"entry_method": "MARKET"}),
            fill(2, "BUY", 40, 110, analytics={"entry_method": "AUTOSTOP"}),
            fill(3, "SELL", 80, 120),
        ],
    )
    r = report(cs)
    assert r["summary"]["count"] == 1 and r["coverage"]["labeled_cycles"] == 0
    assert (
        sum(g["net_pnl"] for g in r["comparisons"]["entries"])
        == r["summary"]["net_pnl"]
    )
    assert (
        sum(g["associated"]["net_pnl"] for g in r["comparisons"]["entries"])
        == 2 * r["summary"]["net_pnl"]
    )


def test_fees_conserve_across_partial_exits():
    cs = build_cycles(
        SESSION,
        [
            fill(1, "BUY", 80, 100, fee=8),
            fill(2, "SELL", 20, 110, fee=2),
            fill(3, "SELL", 60, 90, fee=6),
        ],
    )
    assert cs[0]["fees"] == 16 and cs[0]["net_pnl"] == -416


def test_snapshot_preserves_requested_vs_effective_allocation():
    s = SimpleNamespace(session_capital=10000)
    m = snapshot(
        s, quantity=100, price=100, side="BUY", capital_fraction=0.2, margin_rate=0.2
    )
    assert m["requested_pct"] == 20 and m["effective_allocation_pct"] == 20
    assert m["initial_risk"] is None


def test_unknown_legacy_sizing_is_not_inferred():
    e = build_cycles(SESSION, [fill(1, "BUY", 40, 100)])[0]["entries"][0]
    assert e["entry_method"] == "UNKNOWN" and e["sizing_method"] == "UNKNOWN"


def test_sampled_excursions_exclude_boundaries_and_filled_gaps():
    import pandas as pd
    from app.services.excursion_service import match_excursion

    frame = pd.DataFrame(
        {
            "high": [200, 115, 999, 500],
            "low": [1, 95, 1, 1],
            "observed": [True, True, False, True],
        },
        index=pd.to_datetime([0, 60, 120, 180], unit="s", utc=True),
    )
    m = dict(entry_time=0, exit_time=180, entry_price=100, quantity=2, gross_pnl=10)
    r = match_excursion(m, frame, "LONG", "kite", 60)
    assert r["mfe"] == 30 and r["mae"] == 10 and r["observations"] == 1
    assert (
        match_excursion(m, frame.drop(columns="observed"), "LONG", "kite", 60)["status"]
        == "unavailable"
    )


def test_dynamodb_metadata_is_normalized_before_fill_arithmetic():
    from decimal import Decimal
    from app.services.execution_analytics import filled

    result = filled(
        dict(
            capital=Decimal("10000"),
            margin_rate=Decimal(".2"),
            side="BUY",
            initial_stop=Decimal("90"),
            requested_budget=Decimal("100"),
            sizing_method="RISK",
        ),
        100.0,
        40,
    )
    assert (
        result["effective_allocation_pct"] == 8
        and result["initial_risk"] == 400
        and result["budget_exceeded"]
    )


def test_split_exit_orders_count_as_one_strategy_decision():
    rows = [
        fill(1, "BUY", 80, 100),
        fill(
            2,
            "SELL",
            40,
            110,
            analytics={"exit_action_id": "strategy", "exit_method": "TargetProfit"},
        ),
        fill(
            3,
            "SELL",
            40,
            110,
            analytics={"exit_action_id": "strategy", "exit_method": "TargetProfit"},
        ),
    ]
    cs = build_cycles(SESSION, rows)
    assert (
        cs[0]["exit_count"] == 1 and report(cs)["comparisons"]["exits"][0]["count"] == 1
    )


def test_legacy_order_does_not_invent_sizing_intent():
    from app.models.schemas import Order, OrderType, TradeSide
    from app.services.execution_analytics import order_snapshot

    order = Order(
        session_id="legacy",
        user_id="u",
        symbol="NIFTY",
        side=TradeSide.BUY,
        order_type=OrderType.LIMIT,
        quantity=65,
        trigger_price=100,
        limit_price=100,
        created_at=1,
    )
    meta = order_snapshot(order, SimpleNamespace(session_capital=10000))
    assert meta["entry_method"] == "UNKNOWN" and meta["sizing_method"] == "UNKNOWN"


def test_same_second_numeric_execution_order_is_preserved():
    rows = [
        fill("10", "SELL", 40, 110, time=1, execution_id="10"),
        fill("2", "BUY", 40, 100, time=1, execution_id="2"),
    ]
    cycles = build_cycles(SESSION, rows)
    assert (
        len(cycles) == 1
        and cycles[0]["direction"] == "LONG"
        and cycles[0]["net_pnl"] == 400
    )


def test_partial_entry_fills_aggregate_sizing_without_counting_extra_decisions():
    session = SimpleNamespace(
        session_capital=10000, session_type="paper", strategy_interval_secs=180
    )
    meta = snapshot(
        session,
        quantity=80,
        price=100,
        side="BUY",
        capital_fraction=0.5,
        stop=90,
        entry_method="MARKET",
        action_id="one",
    )
    from app.services.execution_analytics import filled

    cycles = build_cycles(
        SESSION,
        [
            fill(1, "BUY", 40, 100, analytics=filled(meta, 100, 40)),
            fill(2, "BUY", 40, 100, analytics=filled(meta, 100, 40)),
            fill(3, "SELL", 80, 110),
        ],
    )
    entry = cycles[0]["entries"][0]
    assert (
        cycles[0]["entry_count"] == 1
        and entry["analytics"]["effective_allocation_pct"] == 80
        and entry["analytics"]["budget_exceeded"]
    )
    assert entry["initial_risk"] == 800


def test_trade_restore_keeps_metadata_and_same_clock_fill_sequence(monkeypatch):
    from app.services import trading
    from unittest.mock import Mock

    rows = [
        dict(
            session_id="restore",
            trade_id="z",
            user_id="u",
            symbol="NIFTY",
            side="BUY",
            quantity=1,
            price=100,
            timestamp=1,
            commission=1,
            execution_sort_time=1000000,
            analytics={"sizing_method": "RISK", "requested_pct": 2},
        ),
        dict(
            session_id="restore",
            trade_id="a",
            user_id="u",
            symbol="NIFTY",
            side="SELL",
            quantity=1,
            price=110,
            timestamp=1,
            commission=1,
            execution_sort_time=1000001,
        ),
    ]
    monkeypatch.setattr(
        "app.services.analysis_service.get_trades_for_session",
        lambda sid: list(reversed(rows)),
    )
    trading.reload_trades_from_db("restore")
    result = trading.get_trades("restore")
    assert [t.trade_id for t in result] == ["z", "a"] and result[0].analytics[
        "requested_pct"
    ] == 2
    trading._trades.pop("restore", None)


def test_cycle_identity_is_stable_across_model_defaults_and_dynamodb_numbers():
    from decimal import Decimal

    row = fill(1, "BUY", 40, 100, right="CE", strike=25000, expiry="2026-10-08")
    persisted = {**row, "strike": Decimal(25000)}
    model = {**row, "broker_exchange": None, "broker_product": None}
    assert (
        build_cycles(SESSION, [persisted])[0]["cycle_id"]
        == build_cycles(SESSION, [model])[0]["cycle_id"]
    )
