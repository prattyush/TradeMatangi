"""Refresh History must reflect the broker: orders acknowledged after a report
began are kept (not dropped / re-imported as `external_` twins), and cached
reports older than the last place/modify/cancel are not trusted."""
import time

from app.models.schemas import Order, OrderType, OrderStatus, TradeSide
from app.services import kotak_reports
from app.services.real_broker_state import carry_newer_local


def _order(order_id, broker_order_id, quantity=65, status=OrderStatus.PENDING):
    return Order(
        order_id=order_id, session_id="s", user_id="u", symbol="NIFTY",
        side=TradeSide.SELL, order_type=OrderType.STOPLOSS, quantity=quantity,
        trigger_price=30.0, limit_price=29.5, created_at=1, is_stoploss=True,
        status=status, broker_order_id=broker_order_id,
    )


def setup_function(_):
    kotak_reports._touched.clear()


def test_touch_is_visible_only_to_reports_started_before_it():
    started = time.monotonic()
    kotak_reports.touch("111")
    assert kotak_reports.touched_since(started) == {"111"}
    assert kotak_reports.touched_since(time.monotonic() + 1) == set()


def test_order_placed_during_refresh_is_kept_and_not_duplicated():
    started = time.monotonic()
    kotak_reports.touch("422395")  # placement acknowledged after the report began
    local = _order("local-1", "422395", quantity=130)
    external_twin = _order("external_422395", "422395", quantity=130)
    rebuilt = {"external_422395": external_twin}  # a later report imported it
    carry_newer_local(rebuilt, {"local-1": local}, started)
    assert rebuilt == {"local-1": local}


def test_order_missing_from_old_report_is_carried_over():
    started = time.monotonic()
    kotak_reports.touch("422395")
    local = _order("local-1", "422395")
    rebuilt = {}
    carry_newer_local(rebuilt, {"local-1": local}, started)
    assert rebuilt["local-1"] is local


def test_local_edit_after_report_start_wins_over_old_quantity():
    started = time.monotonic()
    kotak_reports.touch("285008")  # merge bump acknowledged mid-fetch
    local = _order("local-1", "285008", quantity=195)
    rebuilt = {"local-1": _order("local-1", "285008", quantity=65)}  # stale report row
    carry_newer_local(rebuilt, {"local-1": local}, started)
    assert rebuilt["local-1"].quantity == 195


def test_local_cancel_after_report_start_is_not_resurrected():
    started = time.monotonic()
    kotak_reports.touch("9")
    local = _order("local-1", "9", status=OrderStatus.CANCELLED)
    rebuilt = {"local-1": _order("local-1", "9")}  # stale report still shows it open
    carry_newer_local(rebuilt, {"local-1": local}, started)
    assert rebuilt["local-1"].status == OrderStatus.CANCELLED


def test_untouched_orders_follow_the_report():
    started = time.monotonic()
    local = _order("local-1", "7", quantity=65)
    rebuilt = {"local-1": _order("local-1", "7", quantity=130)}
    carry_newer_local(rebuilt, {"local-1": local}, started)
    assert rebuilt["local-1"].quantity == 130


def test_cached_bundle_older_than_a_touch_is_not_served(monkeypatch):
    class Broker:
        execution_broker = "kotak"
        calls = 0
        def account_identity(self): return "acct"
        def get_order_history(self): Broker.calls += 1; return []
        def get_trade_history(self): return []
        def get_positions(self): return []

    import asyncio

    async def scenario():
        broker = Broker()
        first = await kotak_reports.fetch(broker)
        kotak_reports.touch("1")
        second = await kotak_reports.fetch(broker)
        assert second is not first
        assert Broker.calls == 2

    asyncio.run(scenario())
