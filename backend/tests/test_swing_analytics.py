from datetime import UTC, datetime

import pytest
from app.routers import swing
from app.services import performance_service as performance
from app.services import swing_analytics as analytics
from app.services import swing_market
from app.services import swing_portfolio_store as store
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests import test_swing_paper_runtime as fixtures

db = fixtures.db


def stamp(day, clock="09:30:00"):
    return int(
        datetime.fromisoformat(day + "T" + clock).replace(tzinfo=UTC).timestamp()
    )


def book():
    return {
        "session_id": "portfolio",
        "user_id": "u",
        "date": "2026-10-06",
        "starting_capital": 2000,
        "mode": "paper",
        "contexts": {},
    }


def trade(identifier, side, price, quantity, day):
    return {
        "trade_id": identifier,
        "side": side,
        "price": price,
        "quantity": quantity,
        "timestamp": stamp(day),
        "commission": 1,
        "symbol": "HDFCBANK",
        "analytics": {"capital": 2000},
        "product": "CNC",
    }


def sample_cycles():
    rows = [
        trade("entry", "BUY", 100, 10, "2026-10-06"),
        trade("half", "SELL", 105, 5, "2026-10-07"),
        trade("exit", "SELL", 110, 5, "2026-10-12"),
    ]
    session = {
        "session_id": "child",
        "user_id": "u",
        "symbol": "HDFCBANK",
        "session_type": "paper",
        "trading_style": "swing",
        "portfolio_id": "portfolio",
        "session_capital": 2000,
    }
    return [analytics.decorate(c) for c in performance.build_cycles(session, rows)]


def test_closed_cycle_dates_partial_exits_and_fee_net_outcomes():
    cycles = sample_cycles()
    cycle = cycles[0]
    assert cycle["date"] == "2026-10-12" and cycle["entry_date"] == "2026-10-06"
    assert (
        cycle["net_pnl"] == 72
        and cycle["holding_days"] == 6
        and cycle["holding_trading_days"] == 4
    )
    assert analytics.trade_stats(cycles, "2026-10-07", "2026-10-07")["count"] == 0
    metrics = analytics.trade_stats(cycles, "2026-10-12", "2026-10-12")
    assert (
        metrics["count"] == 1 and metrics["net_pnl"] == 72 and metrics["win_pct"] == 100
    )
    assert metrics["profit_factor"] is None and metrics["payoff_ratio"] is None
    assert (
        sum(
            m["net_pnl"]
            for m in cycle["matches"]
            if analytics.date_of(m["exit_time"]) == "2026-10-12"
        )
        == 48.5
    )


def test_daily_nav_includes_open_holdings_and_drawdown(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    prices = {
        "2026-10-06": 102,
        "2026-10-07": 105,
        "2026-10-08": 103,
        "2026-10-09": 108,
    }
    result = analytics.valuation_series(
        book(), sample_cycles(), "2026-10-06", "2026-10-12", loader=lambda *args: prices
    )
    assert [r["nav"] for r in result["series"]] == [2019, 2048, 2038, 2063, 2072]
    assert result["coverage_complete"] and result["return_pct"] == pytest.approx(3.6)
    assert result["max_drawdown_pct"] == pytest.approx((2048 - 2038) / 2048 * 100)
    assert result["drawdown_duration_trading_days"] == 1
    assert all(v is None for v in result["annual"].values())


def test_cash_injection_is_not_profit_and_reference_changes_are_not_flows(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    parent = book()
    parent["capital_reference_history"] = [
        {"before": 2000, "after": 10000, "cash_flow": 0}
    ]
    flow = {"timestamp": stamp("2026-10-08", "09:15:00"), "cash_flow": 1000}
    monkeypatch.setattr(analytics, "funding_flows", lambda p: ([flow], True))
    result = analytics.valuation_series(
        parent,
        sample_cycles(),
        "2026-10-06",
        "2026-10-12",
        loader=lambda *args: {
            "2026-10-06": 102,
            "2026-10-07": 105,
            "2026-10-08": 105,
            "2026-10-09": 105,
        },
    )
    assert result["series"][2]["nav"] == 3048 and result["series"][2]["return_pct"] == 0
    assert result["return_pct"] < 3.6


def test_missing_quote_is_a_gap_and_never_zero_price(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    result = analytics.valuation_series(
        book(),
        sample_cycles(),
        "2026-10-06",
        "2026-10-12",
        loader=lambda *args: {"2026-10-06": 102},
    )
    assert result["series"][1]["nav"] is None
    assert result["return_pct"] is None and result["max_drawdown_pct"] is None
    assert result["missing"]


def test_intraday_flow_uses_time_weight_in_daily_dietz(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    parent = book()
    monkeypatch.setattr(
        analytics,
        "funding_flows",
        lambda p: (
            [{"timestamp": stamp("2026-10-06", "12:22:30"), "cash_flow": 1000}],
            True,
        ),
    )
    result = analytics.valuation_series(parent, [], "2026-10-06", "2026-10-06")
    assert result["series"][0]["nav"] == 3000 and result["return_pct"] == 0


def test_opening_basis_does_not_insert_or_claim_a_historical_execution():
    parent = {
        "session_id": "child",
        "trading_style": "swing",
        "symbol": "HDFCBANK",
        "opening_inventory_captured_at": stamp("2026-10-06") * 1000 - 19800000,
        "opening_inventory_fingerprint": "capture",
        "opening_positions": [
            {"symbol": "HDFCBANK", "quantity": 10, "avg_entry_price": 100}
        ],
    }
    rows = analytics.cycle_inputs(parent, [])
    assert rows[0]["opening_basis"] and rows[0]["fee_source"] == "unknown"
    cycles = [analytics.decorate(c) for c in performance.build_cycles(parent, rows)]
    assert (
        cycles[0]["state"] == "open"
        and cycles[0]["holding_days"] is None
        and cycles[0]["acquisition_date"] is None
    )


def test_workspace_ids_cannot_overwrite_primary_or_other_companion(db, monkeypatch):
    from app.services import desktop_persistence_service as persistence

    data = {}

    class Table:
        def put_item(self, Item):
            data[Item["record_id"]] = Item

        def get_item(self, Key, **kwargs):
            return {"Item": data.get(Key["record_id"], {})}

    monkeypatch.setattr(persistence, "_table", lambda _: Table())
    parent = store.create("u", "paper", 10000)
    app = FastAPI()
    app.include_router(swing.router)
    path = f"/swing/portfolios/{parent['session_id']}/charts/workspace"
    body = {
        "surface": "desktop",
        "panes": [{"symbol": "HDFCBANK", "as_of_date": "2026-10-12", "interval": "1D"}],
    }
    with TestClient(app) as client:
        assert (
            client.put(
                path,
                headers={"X-User-Id": "u"},
                json={**body, "workspace_id": "child-one"},
            ).status_code
            == 200
        )
        assert (
            client.get(path + "?surface=desktop", headers={"X-User-Id": "u"}).json()[
                "workspace"
            ]
            is None
        )
        assert (
            client.get(
                path + "?surface=desktop&workspace_id=child-two",
                headers={"X-User-Id": "u"},
            ).json()["workspace"]
            is None
        )
        assert (
            client.get(
                path + "?surface=desktop&workspace_id=child-one",
                headers={"X-User-Id": "u"},
            ).json()["workspace"]["workspace_id"]
            == "child-one"
        )
        assert (
            client.put(path, headers={"X-User-Id": "other"}, json=body).status_code
            == 404
        )


def test_label_api_checks_exact_child_membership_and_cycle_identity(db, monkeypatch):
    parent = store.create("u", "paper", 10000)
    app = FastAPI()
    app.include_router(swing.router)
    body = {"session_id": "unrelated", "analytics_cycle_id": "cycle"}
    with TestClient(app) as client:
        response = client.post(
            f"/swing/portfolios/{parent['session_id']}/labels",
            headers={"X-User-Id": "u"},
            json=body,
        )
        assert response.status_code == 404


def test_real_cycle_identity_survives_official_execution_id_replacement():
    session = {
        "session_id": "child",
        "user_id": "u",
        "symbol": "HDFCBANK",
        "session_type": "real",
        "trading_style": "swing",
        "portfolio_id": "portfolio",
        "session_capital": 2000,
    }
    live = trade("live-report", "BUY", 100, 10, "2026-10-06")
    live.update(broker_order_id="broker-entry", execution_id="live-tick")
    official = {**live, "execution_id": "official-id", "trade_id": "official-row"}
    a = performance.build_cycles(session, [live])[0]
    b = performance.build_cycles(session, [official])[0]
    assert a["cycle_id"] == b["cycle_id"]


def test_label_survives_open_partial_exit_close_and_restart(db, monkeypatch):
    from app.services import (
        swing_portfolio_service as service,
    )
    from app.services import (
        trade_label_service as labels,
    )
    from app.services import (
        trading,
    )

    monkeypatch.setattr(labels, "_ENSURED", False)
    parent = store.create("u", "paper", 10000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    trading.record_trade(
        child.session_id,
        "BUY",
        100,
        stamp("2026-10-06"),
        quantity=10,
        symbol="HDFCBANK",
        user_id="u",
        session_type="paper",
    )
    cycle = analytics.cycles(store.owned("u", parent["session_id"]))[0]
    saved = labels.save_labels(
        child.session_id,
        [
            {
                "round_trip_index": cycle["index"],
                "analytics_cycle_id": cycle["cycle_id"],
                "actual_strategy": "Breakout",
            }
        ],
        "u",
    )[0]
    assert saved["round_trip_index"] == int(cycle["cycle_id"][:12], 16)
    trading.record_trade(
        child.session_id,
        "SELL",
        105,
        stamp("2026-10-07"),
        quantity=5,
        symbol="HDFCBANK",
        user_id="u",
        session_type="paper",
    )
    trading.record_trade(
        child.session_id,
        "SELL",
        110,
        stamp("2026-10-12"),
        quantity=5,
        symbol="HDFCBANK",
        user_id="u",
        session_type="paper",
    )
    closed = analytics.cycles(store.owned("u", parent["session_id"]))[0]
    assert closed["cycle_id"] == cycle["cycle_id"] and closed["state"] == "closed"
    assert closed["label"]["actual_strategy"] == "Breakout"
    service._runtimes.clear()
    restored = analytics.cycles(store.owned("u", parent["session_id"]))[0]
    assert restored["label"]["actual_strategy"] == "Breakout"
    with pytest.raises(ValueError):
        labels.save_labels(
            child.session_id,
            [
                {
                    "round_trip_index": cycle["index"],
                    "analytics_cycle_id": "different-cycle",
                }
            ],
            "u",
        )


def test_annualization_never_uses_short_period_even_with_many_intraday_fills(
    monkeypatch,
):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    result = analytics.valuation_series(book(), [], "2026-10-06", "2026-10-12")
    assert result["return_pct"] == 0 and all(
        value is None for value in result["annual"].values()
    )


def test_opening_inventory_has_no_claimed_return_on_import_day(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    session = {
        "session_id": "child",
        "symbol": "HDFCBANK",
        "trading_style": "swing",
        "opening_inventory_captured_at": stamp("2026-10-06") * 1000 - 19800000,
        "opening_inventory_fingerprint": "basis",
        "opening_positions": [
            {"symbol": "HDFCBANK", "quantity": 10, "avg_entry_price": 100}
        ],
    }
    cycles = [
        analytics.decorate(c)
        for c in performance.build_cycles(session, analytics.cycle_inputs(session, []))
    ]
    result = analytics.valuation_series(
        book(),
        cycles,
        "2026-10-06",
        "2026-10-07",
        loader=lambda *a: {"2026-10-06": 120, "2026-10-07": 121},
    )
    assert result["return_pct"] is None
    later = analytics.valuation_series(
        book(),
        cycles,
        "2026-10-07",
        "2026-10-07",
        loader=lambda *a: {"2026-10-06": 120, "2026-10-07": 121},
    )
    assert later["coverage_complete"] and later["return_pct"] == pytest.approx(
        10 / 2200 * 100
    )


def test_unclassified_cash_correction_suppresses_returns_not_recorded_nav(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    monkeypatch.setattr(
        analytics,
        "funding_flows",
        lambda parent: (
            [
                {
                    "timestamp": stamp("2026-10-06"),
                    "cash_flow": -100,
                    "classification": "unclassified",
                }
            ],
            True,
        ),
    )
    result = analytics.valuation_series(book(), [], "2026-10-06", "2026-10-07")
    assert result["series"][0]["nav"] == 1900 and result["return_pct"] is None
    assert any("not classified" in row["reason"] for row in result["missing"])


def test_period_total_and_unrealized_balances_use_remaining_fifo_fees(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    result = analytics.valuation_series(
        book(),
        sample_cycles(),
        "2026-10-07",
        "2026-10-07",
        loader=lambda *a: {"2026-10-06": 102, "2026-10-07": 105},
    )
    assert result["period_pnl"] == 29
    assert result["unrealized_pnl_at_end"] == 24.5
    assert result["known_period_fees"] == 1


def test_past_missing_prices_outside_report_do_not_poison_complete_later_period(
    monkeypatch,
):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    result = analytics.valuation_series(
        book(),
        sample_cycles(),
        "2026-10-12",
        "2026-10-12",
        loader=lambda *a: {"2026-10-09": 108},
    )
    assert result["coverage_complete"] and result["return_pct"] is not None


def test_missing_flow_evidence_never_invents_historical_cash_or_nav(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    monkeypatch.setattr(analytics, "funding_flows", lambda parent: ([], False))
    result = analytics.valuation_series(book(), [], "2026-10-06", "2026-10-12")
    assert all(row["nav"] is None and row["cash"] is None for row in result["series"])
    assert result["return_pct"] is None


def test_year_long_flat_cash_has_zero_cagr_and_undefined_zero_variance_ratios(
    monkeypatch,
):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    parent = book()
    parent["date"] = "2025-09-01"
    result = analytics.valuation_series(parent, [], "2025-09-01", "2026-10-12")
    assert len(result["series"]) >= 252
    assert result["annual"]["cagr_pct"] == 0 and result["annual"]["volatility_pct"] == 0
    assert result["annual"]["sharpe"] is None and result["annual"]["sortino"] is None


def test_rupee_drawdown_measures_actual_loss_after_capital_withdrawal(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-13")
    monkeypatch.setattr(
        analytics,
        "funding_flows",
        lambda parent: (
            [
                {
                    "timestamp": stamp("2026-10-06", "09:15:00"),
                    "cash_flow": -1000,
                    "classification": "capital_transfer",
                }
            ],
            True,
        ),
    )
    session = {"session_id": "child", "symbol": "HDFCBANK", "session_capital": 2000}
    row = trade("buy", "BUY", 100, 1, "2026-10-06")
    cycles = [analytics.decorate(c) for c in performance.build_cycles(session, [row])]
    result = analytics.valuation_series(
        book(),
        cycles,
        "2026-10-06",
        "2026-10-06",
        loader=lambda *a: {"2026-10-06": 100},
    )
    assert result["max_drawdown_rupees"] == 1
    assert result["max_drawdown_pct"] == pytest.approx(0.1)


def test_legacy_initial_capture_and_reference_only_receipts_do_not_fake_missing_flows(
    monkeypatch,
):
    from types import SimpleNamespace

    from app.services import swing_funding_store as funding

    monkeypatch.setattr(
        funding,
        "_table",
        lambda: SimpleNamespace(
            query=lambda **kwargs: {
                "Items": [{"kind": "participant_start"}, {"kind": "capital_reset"}]
            }
        ),
    )
    flows, complete = analytics.funding_flows(
        {
            "session_id": "portfolio",
            "mode": "real",
            "execution_broker": "kite",
            "broker_account_id": "account",
            "real_funding_period": "period",
        }
    )
    assert complete and flows == []


def test_valuation_preserves_same_second_execution_chronology(monkeypatch):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-08")
    rows = [
        trade("z", "BUY", 100, 1, "2026-10-06"),
        trade("a", "SELL", 110, 1, "2026-10-06"),
    ]
    for index, row in enumerate(rows):
        row["execution_sort_time"] = row["timestamp"] * 1_000_000 + index
    session = {"session_id": "child", "symbol": "HDFCBANK", "trading_style": "swing"}
    cycles = [analytics.decorate(c) for c in performance.build_cycles(session, rows)]
    result = analytics.valuation_series(
        book(), cycles, "2026-10-06", "2026-10-07", loader=lambda *args: {}
    )
    assert result["unrealized_pnl_at_end"] == 0
    assert result["series"][-1]["nav"] == 2008


@pytest.mark.parametrize(
    "captured", ["2026-10-06T08:00:00", "2026-10-06T17:00:00", "2026-10-10T12:00:00"]
)
def test_import_invalidates_first_consuming_valuation_even_outside_market(
    monkeypatch, captured
):
    monkeypatch.setattr(swing_market, "today", lambda: "2026-10-14")
    row = trade("opening", "BUY", 100, 1, captured[:10])
    row.update(
        timestamp=int(datetime.fromisoformat(captured).replace(tzinfo=UTC).timestamp()),
        opening_basis=True,
        commission=0,
    )
    cycle = analytics.decorate(
        performance.build_cycles(
            {"session_id": "child", "symbol": "HDFCBANK", "trading_style": "swing"},
            [row],
        )[0]
    )
    consumed = (
        "2026-10-06"
        if captured[11:] < "15:30:00" and captured[:10] == "2026-10-06"
        else "2026-10-07"
        if captured[:10] == "2026-10-06"
        else "2026-10-12"
    )
    prices = {
        day: 150
        for day in (
            "2026-10-06",
            "2026-10-07",
            "2026-10-08",
            "2026-10-09",
            "2026-10-12",
            "2026-10-13",
        )
    }
    result = analytics.valuation_series(
        book(), [cycle], "2026-10-06", "2026-10-13", loader=lambda *args: prices
    )
    assert not result["coverage_complete"] and result["return_pct"] is None
    assert (
        next(r for r in result["series"] if r["date"] == consumed)["return_pct"] is None
    )
    assert any(
        m["date"] == consumed and m["symbol"] == "Imported inventory"
        for m in result["missing"]
    )
    later = "2026-10-08" if consumed < "2026-10-08" else "2026-10-13"
    recovered = analytics.valuation_series(
        book(), [cycle], later, "2026-10-13", loader=lambda *args: prices
    )
    assert recovered["coverage_complete"] and recovered["return_pct"] == 0


def test_future_short_nav_uses_economic_pnl_not_notional_asset(monkeypatch):
    monkeypatch.setattr(swing_market,"today",lambda:"2026-10-13")
    rows=[trade("short","SELL",100,10,"2026-10-06"),trade("half","BUY",90,5,"2026-10-07"),trade("cover","BUY",80,5,"2026-10-12")]
    for row in rows:
        row.update(instrument_type="futures",expiry="2026-10-27",product="NRML")
        row["analytics"]["futures"]={"entry_margin":200 if row["side"]=="SELL" else 0,"contract":{"category":"index"}}
    session={"session_id":"child","user_id":"u","symbol":"HDFCBANK","instrument_type":"futures",
             "session_type":"paper","trading_style":"swing","portfolio_id":"portfolio"}
    cycles=[analytics.decorate(c) for c in performance.build_cycles(session,rows)]
    cycle=cycles[0]
    assert cycle["net_pnl"]==147 and cycle["return_on_cost_pct"] is None
    assert cycle["return_on_margin_pct"]==73.5
    prices={"2026-10-06":95,"2026-10-07":90,"2026-10-08":85,"2026-10-09":80}
    result=analytics.valuation_series(book(),cycles,"2026-10-06","2026-10-12",loader=lambda *a:prices)
    assert [r["nav"] for r in result["series"]]==[2049,2098,2123,2148,2147]
    assert result["coverage_complete"]
