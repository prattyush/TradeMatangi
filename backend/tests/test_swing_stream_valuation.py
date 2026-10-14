"""SSE ownership/lifecycle and Paper valuation across backend restarts."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from app.routers import swing
from app.models.schemas import TradeSide, OrderType
from app.services import swing_portfolio_service as service, swing_portfolio_store as store
from app.services import swing_charts as charts, swing_market as market, simulation, trading, order_service
from tests.test_swing_paper_runtime import db, entry, tick


@pytest.mark.asyncio
@pytest.mark.parametrize("option", [False, True])
async def test_last_known_paper_valuation_survives_restart_without_executing_orders(db, monkeypatch, option):
    parent = store.create("u", "paper", 100000)
    pid = parent["session_id"]
    fields = {"right": "CE", "strike": 125.5, "expiry": "2026-11-03"} if option else {}
    child = service.attach_context("u", pid, "CANBK" if option else "HDFCBANK", "options" if option else "equity", **fields, subscribe=False)
    if option:
        order_service.place_order(child.session_id, child.symbol, TradeSide.BUY, OrderType.LIMIT, 10, 1, child.date,
                                 limit_price=100, **fields, user_id="u", wallet_ledger_id=child.wallet_ledger_id, wallet_ledger_kind="paper")
    else:
        entry(child, 100)
    current = service.runtime("u", pid)
    await service.on_tick(current, child, {**tick("2026-11-02", 100), **fields})
    pending = order_service.place_order(child.session_id, child.symbol, TradeSide.BUY, OrderType.LIMIT, 10, 2, child.date,
                                 limit_price=90, **fields, user_id="u", wallet_ledger_id=child.wallet_ledger_id, wallet_ledger_kind="paper")
    await service.on_tick(current, child, {**tick("2026-11-02", 110), **fields})
    await service.persist_marks(child, force=True)
    expected = service.snapshot("u", pid)["pnl"]
    balance = service.snapshot("u", pid)["wallet_balance"]
    # Other session writes must not discard the checkpointed valuation.
    simulation._upsert_session_to_db(child, strict=True)
    service._runtimes.clear(); simulation._sessions.clear(); trading._trades.clear(); order_service._orders.clear()
    monkeypatch.setattr(market, "now", lambda: int(tick("2026-11-02", 110)["time"]) + 7200)
    await service.ensure("u", pid, subscribe=False)
    restored = service.snapshot("u", pid)
    assert restored["pnl"] == expected
    assert restored["valuation_status"] == "stale"
    assert restored["positions"][0]["mark_price"] == 110
    assert restored["wallet_balance"] == balance
    assert [o["order_id"] for o in restored["open_orders"]] == [pending.order_id]
    assert len(restored["trades"]) == 1


@pytest.mark.asyncio
async def test_loaded_chart_history_can_restore_legacy_valuation_but_not_trigger_orders(db):
    parent = store.create("u", "paper", 100000)
    pid = parent["session_id"]
    child = service.attach_context("u", pid, "HDFCBANK", subscribe=False)
    current = service.runtime("u", pid)
    entry(child, 100)
    await service.on_tick(current, child, tick("2026-11-02", 100))
    pending = entry(child, 90)
    child.swing_quote_seen = False
    child.swing_mark_time = 0
    assert service.snapshot("u", pid)["pnl"] is None
    await service.apply_history_valuation("u", pid, charts.instrument("HDFCBANK"), {"price": 80, "timestamp": int(child.current_time) + 1})
    view = service.snapshot("u", pid)
    assert view["pnl"] is not None
    assert view["valuation_status"] == "stale"
    assert view["positions"][0]["mark_price"] == 80
    assert pending.status.value == "PENDING"
    assert len(view["trades"]) == 1
    # History must never overwrite a newer live quote.
    service.update_current_mark(child, {"close": 120}, int(child.current_time) + 10)
    await service.apply_history_valuation("u", pid, charts.instrument("HDFCBANK"), {"price": 50, "timestamp": int(child.current_time) + 5})
    assert service.snapshot("u", pid)["positions"][0]["mark_price"] == 120


@pytest.mark.asyncio
async def test_position_without_any_price_remains_unavailable(db):
    parent = store.create("u", "paper", 100000)
    pid = parent["session_id"]
    child = service.attach_context("u", pid, "HDFCBANK", subscribe=False)
    entry(child, 100)
    await service.on_tick(service.runtime("u", pid), child, tick("2026-11-02", 100))
    child.swing_quote_seen = False
    assert service.snapshot("u", pid)["pnl"] is None
    service.update_current_mark(child, {"close": 0}, int(child.current_time))
    assert service.snapshot("u", pid)["pnl"] is None


@pytest.mark.asyncio
async def test_portfolio_stream_initial_snapshot_push_and_disconnect_cleanup(db, monkeypatch):
    parent = store.create("u", "paper", 100000)
    current = service.runtime("u", parent["session_id"])
    monkeypatch.setattr(service, "ensure", AsyncMock(return_value=current))
    response = await swing.events(parent["session_id"], "u")
    stream = response.body_iterator
    assert '"type": "portfolio_snapshot"' in await anext(stream)
    assert len(current.subscribers) == 1
    current.emit({"type": "portfolio_snapshot", "pnl": 123})
    assert '"pnl": 123' in await anext(stream)
    await stream.aclose()
    assert current.subscribers == []
    with pytest.raises(HTTPException) as error:
        await swing.events(parent["session_id"], "other")
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_chart_stream_pushes_quotes_without_http_poll_and_enforces_ownership(db, monkeypatch):
    parent = store.create("u", "paper", 100000)
    viewer = object.__new__(charts.Viewer)
    viewer.user, viewer.portfolio = "u", parent["session_id"]
    viewer.quotes, viewer.bars = {}, {}
    viewer.error, viewer.actual = None, "kite"
    viewer.changed = asyncio.Event()
    viewer.task = asyncio.create_task(asyncio.sleep(100))
    monkeypatch.setattr(charts, "_viewers", {"watch": viewer})
    try:
        response = await swing.chart_events(parent["session_id"], "watch", "u")
        stream = response.body_iterator
        first = await anext(stream)
        assert json.loads(first.split('data: ')[1])["quotes"] == []
        viewer.record(charts.instrument("HDFCBANK"), tick("2026-11-02", 110))
        received = json.loads((await anext(stream)).split('data: ')[1])
        assert received["quotes"][0]["close"] == 110
        await stream.aclose()
        with pytest.raises(HTTPException) as error:
            await swing.chart_events(parent["session_id"], "watch", "other")
        assert error.value.status_code == 404
        response = await swing.chart_events(parent["session_id"], "watch", "u")
        charts._viewers.clear()
        assert 'chart_watch_expired' in await anext(response.body_iterator)
        await response.body_iterator.aclose()
    finally:
        viewer.task.cancel()
        await asyncio.gather(viewer.task, return_exceptions=True)


@pytest.mark.asyncio
async def test_day_swing_and_chart_consumers_share_feed_but_release_independently():
    from app.services.market_data import MarketDataHub, FeedGroup
    from tests.test_phase19_market_data import FakeAdapter
    adapter = FakeAdapter()
    hub = MarketDataHub(adapter)
    instrument = charts.instrument("HDFCBANK")
    day, execution, viewer = asyncio.Queue(), asyncio.Queue(), asyncio.Queue()
    handles = await asyncio.gather(
        hub.subscribe(instrument, "day-session", FeedGroup("kite", real=True), day),
        hub.subscribe(instrument, "swing-session", FeedGroup("kite"), execution),
        hub.subscribe(instrument, "swing-viewer", FeedGroup("kite"), viewer))
    try:
        assert len(adapter.opened) == 1
        adapter.deliveries[handles[0].key].put_nowait(tick("2026-11-02", 100))
        assert [q.get_nowait()["close"] for q in (day, execution, viewer)] == [100, 100, 100]
        handles[2].close(); handles[1].close()
        assert adapter.closed == []
        adapter.deliveries[handles[0].key].put_nowait(tick("2026-11-02", 110))
        assert day.get_nowait()["close"] == 110
        assert execution.empty() and viewer.empty()
    finally:
        handles[0].close(); hub.shutdown()
    assert len(adapter.closed) == 1
