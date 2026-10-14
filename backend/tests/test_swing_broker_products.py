"""Synthetic product boundary; defaults and intraday reports remain isolated."""

from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from app.services import (
    kite_execution,
    kotak_service,
    swing_execution_broker as routing,
)


def kite(monkeypatch, options=False):
    broker = kite_execution.KiteExecutionService()
    client = Mock()
    client.place_order.return_value = "confirmed"
    monkeypatch.setattr(broker, "_get_client", lambda: client)
    meta = {
        "exchange": "NFO" if options else "NSE",
        "tradingsymbol": "CANBK26NOV125.5CE" if options else "CANBK",
        "lot_size": 10 if options else 1,
        "tick_size": 0.05,
        "instrument_type": "CE" if options else "EQ",
        "name": "CANBK",
        "expiry": "2026-11-03" if options else None,
        "strike": 125.5 if options else 0,
    }
    monkeypatch.setattr(broker, "instrument", lambda *a: meta)
    monkeypatch.setattr(broker, "_metadata", lambda *a: meta)
    return broker, client


@pytest.mark.parametrize("options,expected", [(False, "CNC"), (True, "NRML")])
def test_kite_scope_never_changes_shared_mis_default(monkeypatch, options, expected):
    base, client = kite(monkeypatch, options)
    scoped = routing.bind(base, "options" if options else "equity")
    if options:
        args = dict(
            symbol="CANBK",
            right="CE",
            strike=125.5,
            expiry="2026-11-03",
            side="B",
            qty=10,
            price=10,
        )
        scoped.place_options_limit_order(**args)
        assert client.place_order.call_args.kwargs["product"] == expected
        base.place_options_limit_order(**args)
    else:
        scoped.place_limit_order("CANBK", "B", 10, 100)
        assert client.place_order.call_args.kwargs["product"] == expected
        base.place_limit_order("CANBK", "B", 10, 100)
    assert client.place_order.call_args.kwargs["product"] == "MIS"
    assert scoped.account_identity == base.account_identity


@pytest.mark.parametrize("options,expected", [(False, "CNC"), (True, "NRML")])
def test_kotak_product_is_bound_to_each_order(monkeypatch, options, expected):
    base = kotak_service.KotakNeoService()
    client = Mock()
    client.place_order.return_value = {"nOrdNo": "confirmed"}
    monkeypatch.setattr(base, "_get_client", lambda: client)
    monkeypatch.setattr(base, "_resolve_symbol", lambda symbol: ("CANBK-EQ", "nse_cm"))
    monkeypatch.setattr(
        base, "_resolve_options_symbol", lambda *a: ("CANBK26NOV125.5CE", "nse_fo")
    )
    scoped = routing.bind(base, "options" if options else "equity")
    args = dict(symbol="CANBK", side="B", qty=10, price=10)
    if options:
        args.update(right="CE", strike=125.5, expiry="2026-11-03")
    method = "place_options_limit_order" if options else "place_limit_order"
    getattr(scoped, method)(**args)
    assert client.place_order.call_args.kwargs["product"] == expected
    getattr(base, method)(**args)
    assert client.place_order.call_args.kwargs["product"] == "MIS"


def test_invalid_delivery_product_rejected_before_sdk_write(monkeypatch):
    base, client = kite(monkeypatch, True)
    with pytest.raises(kotak_service.KotakOrderRejected):
        base.place_options_limit_order(
            "CANBK", "B", 10, 10, "CE", 125.5, "2026-11-03", product="CNC"
        )
    client.place_order.assert_not_called()


def test_kotak_product_reports_do_not_merge_books():
    rows = [
        {"product": "MIS", "id": "day"},
        {"product": "CNC", "id": "equity"},
        {"prod": "NRML", "id": "option"},
    ]
    base = SimpleNamespace(
        execution_broker="kotak",
        get_order_history=lambda: rows,
        get_positions=lambda: rows,
        get_trade_history=lambda: rows,
    )
    equity = routing.bind(base, "equity")
    options = routing.bind(base, "options")
    assert [r["id"] for r in equity.get_order_history()] == ["equity"]
    assert [r["id"] for r in options.get_positions()] == ["option"]


@pytest.mark.asyncio
async def test_report_cache_scope_is_separate_but_invalidated_for_shared_account():
    from app.services import kotak_reports

    base = SimpleNamespace(
        execution_broker="kotak", account_identity=lambda: "account", _generation=1
    )
    equity = routing.bind(base, "equity")
    options = routing.bind(base, "options")
    first = kotak_reports.state(base)
    second = kotak_reports.state(equity)
    third = kotak_reports.state(options)
    assert first is not second and second is not third
    kotak_reports.invalidate(equity)
    assert first.revision == second.revision == third.revision == 1
