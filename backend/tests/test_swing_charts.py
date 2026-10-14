import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pandas as pd
import pytest
from app.routers import swing
from app.services import (
    simulation,
    trading,
)
from app.services import (
    swing_charts as charts,
)
from app.services import (
    swing_market as market,
)
from app.services import (
    swing_portfolio_service as service,
)
from app.services import (
    swing_portfolio_store as store,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests import test_swing_paper_runtime as fixtures

db = fixtures.db


def stamp(date, clock="09:15:00"):
    return int(
        datetime.fromisoformat(date + "T" + clock).replace(tzinfo=UTC).timestamp()
    )


@pytest.mark.parametrize(
    "clock,open",
    [
        ("09:14:59", False),
        ("09:15:00", True),
        ("15:15:00", True),
        ("15:29:59", True),
        ("15:30:00", False),
    ],
)
def test_swing_window_uses_full_session(clock, open):
    assert bool(market.window(stamp("2026-10-12", clock))) == open


def test_swing_window_excludes_weekend_and_holiday():
    assert market.window(stamp("2026-10-11")) is None
    assert market.window(stamp("2026-10-02")) is None


def test_daily_history_uses_daily_data_and_paginates(monkeypatch):
    item = charts.instrument("HDFCBANK")
    frame = pd.DataFrame(
        {"open": 100, "high": 110, "low": 90, "close": 105, "volume": 20},
        index=pd.bdate_range("2025-01-01", "2026-10-12"),
    )
    calls = []
    monkeypatch.setattr(
        "app.services.historical_data_service.get_policy",
        lambda: SimpleNamespace(source="kite", allow_fallback=False),
    )

    def read(provider, item, start, end, daily):
        calls.append(daily)
        return frame.copy()

    monkeypatch.setattr(charts, "_cached", read)
    monkeypatch.setattr(market, "today", lambda: "2026-10-12")
    result = charts.history(item, "1D", "2026-10-12", limit=250)
    assert calls == [True]
    assert len(result["candles"]) == 250 and result["more"]
    assert all(c["time"] % 86400 == 0 for c in result["candles"])
    older = charts.history(item, "1D", "2026-10-12", before=result["before"], limit=250)
    assert all(c["time"] < result["before"] for c in older["candles"])


def test_intraday_history_includes_after_1515(monkeypatch):
    frame = pd.DataFrame(
        {"open": 100, "high": 110, "low": 90, "close": 105, "volume": 20},
        index=pd.date_range("2026-10-12 15:14", "2026-10-12 15:29", freq="1min"),
    )
    monkeypatch.setattr(
        "app.services.historical_data_service.get_policy",
        lambda: SimpleNamespace(source="breeze", allow_fallback=False),
    )
    monkeypatch.setattr(charts, "_cached", lambda *args: frame.copy())
    result = charts.history(charts.instrument("HDFCBANK"), "1m", "2026-10-12")
    assert result["candles"][-1]["time"] == stamp("2026-10-12", "15:29:00")
    assert charts.bucket(stamp("2026-10-12", "10:00:00"), "1h") == stamp("2026-10-12")


def test_normalize_offset_keeps_ist_and_invalid_rows_are_not_prices():
    rows = pd.DataFrame(
        [
            {
                "datetime": "2026-10-12T03:45:00Z",
                "open": 100,
                "high": 102,
                "low": 99,
                "close": 101,
                "volume": None,
            },
            {
                "datetime": "2026-10-12T10:00:00+05:30",
                "open": 0,
                "high": 0,
                "low": 0,
                "close": 0,
            },
        ]
    )
    result = charts.normalize(rows, False)
    assert len(result) == 1 and result.index[0] == pd.Timestamp("2026-10-12T09:15:00")
    assert result.volume.iloc[0] == 0


def test_cache_is_separate_coalesced_and_partial_bounds_do_not_poison_full_day(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(charts, "OHLCDATA_DIR", tmp_path)
    monkeypatch.setattr(market, "today", lambda: "2026-10-13")
    calls = []

    def fetch(*args):
        calls.append(args)
        return pd.DataFrame(
            [
                {
                    "datetime": "2026-10-12 09:15:00",
                    "open": 100,
                    "high": 101,
                    "low": 99,
                    "close": 100,
                    "volume": 0,
                }
            ]
        )

    monkeypatch.setattr(charts, "_fetch", fetch)
    item = charts.instrument("HDFCBANK")
    charts._cached(
        "kite",
        item,
        pd.Timestamp("2026-10-12"),
        pd.Timestamp("2026-10-12T12:00:00"),
        False,
    )
    charts._cached(
        "kite",
        item,
        pd.Timestamp("2026-10-12"),
        pd.Timestamp("2026-10-12T12:00:00"),
        False,
    )
    charts._cached(
        "kite",
        item,
        pd.Timestamp("2026-10-12"),
        pd.Timestamp("2026-10-12T15:30:00"),
        False,
    )
    assert len(calls) == 2
    assert all("swing" in str(path) for path in tmp_path.rglob("*.parquet"))


def test_owned_chart_history_does_not_create_execution_context(db, monkeypatch):
    parent = store.create("u", "paper", 100000)
    monkeypatch.setattr(charts, "history", lambda *a: {"candles": [], "more": False})
    app = FastAPI()
    app.include_router(swing.router)
    with TestClient(app) as client:
        body = {"symbol": "NIFTY", "as_of_date": "2026-10-12", "interval": "1D"}
        assert (
            client.post(
                f"/swing/portfolios/{parent['session_id']}/charts/history",
                headers={"X-User-Id": "other"},
                json=body,
            ).status_code
            == 404
        )
        assert (
            client.post(
                f"/swing/portfolios/{parent['session_id']}/charts/history",
                headers={"X-User-Id": "u"},
                json=body,
            ).status_code
            == 200
        )
    assert store.owned("u", parent["session_id"])["contexts"] == {}
    assert not simulation._sessions


@pytest.mark.asyncio
async def test_position_feed_starts_without_ui_and_releases_at_close(db, monkeypatch):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    trading.record_trade(
        child.session_id,
        "BUY",
        100,
        stamp("2026-10-12"),
        quantity=10,
        symbol="HDFCBANK",
        user_id="u",
        session_type="paper",
    )
    current = service.runtime("u", parent["session_id"])
    windows = iter([None, {"date": "2026-10-12"}, None])
    monkeypatch.setattr(market, "window", lambda *_: next(windows))
    monkeypatch.setattr("app.services.market_data.selected_provider", lambda: "kite")
    handle = SimpleNamespace(close=lambda: closed.append(True))
    closed = []
    subscribed = []

    async def subscribe(item, owner, group, queue):
        group.actual = "kite"
        subscribed.append(item)
        return handle

    monkeypatch.setattr(
        "app.services.market_data.get_hub", lambda: SimpleNamespace(subscribe=subscribe)
    )
    calls = 0

    async def wait(awaitable, timeout):
        nonlocal calls
        awaitable.close()
        calls += 1
        if calls == 3:
            child.state = simulation.SimulationState.ENDED
        raise TimeoutError

    monkeypatch.setattr(service.asyncio, "wait_for", wait)
    await service._consume(current, child)
    assert len(subscribed) == 1 and subscribed[0]["symbol"] == "HDFCBANK"
    assert closed


@pytest.mark.asyncio
async def test_retry_restores_paper_after_transient_failure_without_rescanning(
    db, monkeypatch
):
    parent = store.create("u", "paper", 100000)
    reads = []
    monkeypatch.setattr(
        service, "_active_paper_rows", lambda: reads.append(True) or [parent]
    )
    restored = AsyncMock(side_effect=[RuntimeError("Provider unavailable"), None])
    monkeypatch.setattr(service, "ensure", restored)
    monkeypatch.setattr(service.asyncio, "sleep", AsyncMock())
    await service.restore_active_portfolios()
    assert len(reads) == 1 and restored.await_count == 2


def test_future_history_is_rejected_without_fetch(monkeypatch):
    monkeypatch.setattr(market, "today", lambda: "2026-10-12")
    with pytest.raises(Exception) as error:
        charts.history(charts.instrument("HDFCBANK"), "1D", "2026-10-13")
    assert error.value.status_code == 422


def test_live_ranges_retain_extremes_between_polls_and_ignore_older_ticks():
    viewer = object.__new__(charts.Viewer)
    viewer.quotes, viewer.bars = {}, {}
    viewer.changed = asyncio.Event()
    item = charts.instrument("HDFCBANK")
    first = stamp("2026-10-12", "09:15:00")
    for offset, price in [(0, 100), (1, 110), (2, 90), (3, 101), (1, 200)]:
        viewer.record(
            item,
            {
                "time": first + offset,
                "open": price,
                "high": price,
                "low": price,
                "close": price,
            },
        )
    quote = next(iter(viewer.quotes.values()))
    assert quote["time"] == first + 3
    assert quote["candles"]["1m"] == {
        "time": first,
        "open": 100,
        "high": 110,
        "low": 90,
        "close": 101,
    }
    assert quote["candles"]["1D"]["time"] == stamp("2026-10-12", "00:00:00")


@pytest.mark.asyncio
async def test_viewer_close_releases_only_its_handles(db, monkeypatch):
    parent = store.create("u", "paper", 100000)
    monkeypatch.setattr(market, "window", lambda *_: {"date": "2026-10-12"})
    monkeypatch.setattr("app.services.market_data.selected_provider", lambda: "kite")
    closed, subscribed = [], []

    async def subscribe(item, owner, group, queue):
        subscribed.append(owner)
        return SimpleNamespace(close=lambda: closed.append(owner))

    monkeypatch.setattr(
        "app.services.market_data.get_hub", lambda: SimpleNamespace(subscribe=subscribe)
    )

    async def finish(_):
        row = store.owned("u", parent["session_id"])
        store.update("u", parent["session_id"], {"state": "ended"}, row["version"])
        viewer.next_owner_check = 0

    monkeypatch.setattr(charts.asyncio, "sleep", finish)
    viewer = charts.Viewer(
        "u", parent["session_id"], [charts.instrument("HDFCBANK")], False
    )
    await viewer.task
    assert len(subscribed) == 1 and closed == subscribed


def test_workspace_is_user_surface_and_broker_scoped(db, monkeypatch):
    from app.services import desktop_persistence_service as persistence

    records = {}

    class Table:
        def put_item(self, Item):
            records[(Item["user_id"], Item["record_id"])] = Item

        def get_item(self, Key, **kwargs):
            return {"Item": records.get((Key["user_id"], Key["record_id"]), {})}

    monkeypatch.setattr(persistence, "_table", lambda _: Table())
    parent = store.create("u", "paper", 100000)
    app = FastAPI()
    app.include_router(swing.router)
    prefix = f"/swing/portfolios/{parent['session_id']}/charts/workspace"
    body = {
        "surface": "desktop",
        "panes": [
            {
                "symbol": "HDFCBANK",
                "interval": "1D",
                "as_of_date": "2026-10-12",
                "follow_today": True,
            }
        ],
        "active": 0,
        "rail_open": False,
        "ticket_open": False,
        "tools_collapsed": True,
    }
    with TestClient(app) as client:
        assert (
            client.put(prefix, headers={"X-User-Id": "u"}, json=body).status_code == 200
        )
        saved = client.get(
            prefix + "?surface=desktop", headers={"X-User-Id": "u"}
        ).json()["workspace"]
        assert (
            saved["surface"] == "desktop"
            and saved["panes"][0]["symbol"] == "HDFCBANK"
            and saved["panes"][0]["follow_today"]
            and saved["rail_open"] is False
            and saved["ticket_open"] is False
            and saved["tools_collapsed"] is True
        )
        assert (
            client.get(prefix + "?surface=website", headers={"X-User-Id": "u"}).json()[
                "workspace"
            ]
            is None
        )
        assert (
            client.get(
                prefix + "?surface=desktop", headers={"X-User-Id": "other"}
            ).status_code
            == 404
        )
        assert (
            client.put(
                prefix, headers={"X-User-Id": "u"}, json={**body, "active": 1}
            ).status_code
            == 422
        )
    assert store.owned("u", parent["session_id"])["contexts"] == {}


def test_position_pnl_is_net_of_known_entry_fees_and_stale_after_close(db, monkeypatch):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u", parent["session_id"], "HDFCBANK", subscribe=False
    )
    trading.record_trade(
        child.session_id,
        "BUY",
        100,
        stamp("2026-10-12"),
        quantity=10,
        symbol="HDFCBANK",
        user_id="u",
        session_type="paper",
    )
    child.last_price = 110
    child.swing_quote_seen = True
    child.swing_mark_time = stamp("2026-10-12", "15:29:30")
    monkeypatch.setattr(market, "now", lambda: stamp("2026-10-12", "15:29:31"))
    position = service.snapshot("u", parent["session_id"])["positions"][0]
    assert position["unrealized_pnl"] == round(100 - position["entry_commission"], 2)
    assert position["invested_value"] == 1000
    assert position["unrealized_pnl_pct"] == round(
        (100 - position["entry_commission"]) / 1000 * 100, 4
    )
    assert position["quote_status"] == "live"
    monkeypatch.setattr(market, "now", lambda: stamp("2026-10-12", "15:30:00"))
    assert (
        service.snapshot("u", parent["session_id"])["positions"][0]["quote_status"]
        == "stale"
    )
    child.swing_quote_seen = False
    unavailable = service.snapshot("u", parent["session_id"])["positions"][0]
    assert unavailable["mark_price"] is None and unavailable["unrealized_pnl"] is None


def test_paper_expiry_entry_cutoff_matches_full_swing_clock(db):
    parent = store.create("u", "paper", 100000)
    child = service.attach_context(
        "u",
        parent["session_id"],
        "CANBK",
        "options",
        125.5,
        "2026-11-03",
        "CE",
        subscribe=False,
    )
    child.date = "2026-11-03"
    child.current_time = stamp(child.date, "15:00:00")
    service.require_entry_allowed(child, "BUY", 10, "CE", 125.5, child.date)
    child.current_time = stamp(child.date, "15:15:00")
    with pytest.raises(Exception) as error:
        service.require_entry_allowed(child, "BUY", 10, "CE", 125.5, child.date)
    assert error.value.status_code == 400
