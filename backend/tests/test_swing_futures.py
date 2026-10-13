# ruff: noqa: F811 — imported pytest fixtures are injected by name
import pytest
from app.models.schemas import OrderType, TradeSide
from app.routers.swing import PortfolioOrder
from app.services import (
    futures_ledger as ledger,
)
from app.services import (
    futures_risk as risk,
)
from app.services import (
    swing_futures as engine,
)
from app.services import (
    swing_portfolio_service as service,
)
from app.services import (
    swing_portfolio_store as store,
)
from app.services import (
    trading,
)

from tests.test_swing_paper_runtime import db  # noqa: F401


@pytest.fixture
def future_book(db, monkeypatch):
    contract = {
        "symbol": "NIFTY",
        "instrument_type": "futures",
        "exchange": "NFO",
        "expiry": "2026-10-27",
        "lot_size": 5,
        "tick_size": 0.05,
        "instrument_token": "1",
        "trading_symbol": "NIFTY26OCTFUT",
        "entry_eligible": True,
        "category": "index",
    }
    monkeypatch.setattr(
        "app.services.futures_contracts.resolve_contract", lambda *a, **k: contract
    )
    monkeypatch.setattr(risk, "settings", lambda: risk.RiskSettings(paper_enabled=True))
    monkeypatch.setattr(
        risk,
        "live_margin",
        lambda c, s, q, p, b, **k: {
            "margin": q * 20,
            "quantity": q,
            "reference_price": p,
            "source": "fixture",
            "live": True,
            "quoted_at": 1,
        },
    )
    monkeypatch.setattr(risk, "cache_margin", lambda *a: None)
    now = 1791882900  # 2026-10-13 09:15 IST wall seconds
    from datetime import UTC, datetime

    now = int(datetime(2026, 10, 13, 9, 15, tzinfo=UTC).timestamp())
    monkeypatch.setattr("app.services.swing_market.now", lambda: now)
    monkeypatch.setattr("app.services.swing_market.today", lambda: "2026-10-13")
    attach = service.attach_context
    monkeypatch.setattr(
        service,
        "attach_context",
        lambda *a, **k: attach(*a, **{**k, "subscribe": False}),
    )
    parent = store.create("u", "paper", 1000)
    return parent, contract, now


def request(side="BUY", identity="entry", price=100, quantity=5, budget=200):
    return PortfolioOrder(
        symbol="NIFTY",
        instrument_type="futures",
        expiry="2026-10-27",
        side=side,
        quantity=quantity,
        price=price,
        request_id=identity,
        approved_budget=budget,
        capital_revision=0,
    )


@pytest.mark.asyncio
async def test_paper_future_reserves_margin_fills_exact_quote_and_closes_without_notional_cash(
    future_book,
):
    parent, contract, now = future_book
    result = await engine.place("u", parent["session_id"], request())
    assert 899 < result["wallet_balance"] < 900
    child = service.runtime("u", parent["session_id"]).contexts[
        "NIFTY:futures:2026-10-27"
    ]
    await engine.on_quote(
        service.runtime("u", parent["session_id"]),
        child,
        {"type": "tick", "time": now, "close": 100, "expiry": contract["expiry"]},
    )
    view = service.snapshot("u", parent["session_id"])
    assert view["positions"][0]["instrument_type"] == "futures"
    assert view["positions"][0]["held_margin"] == 100
    assert view["trades"][0]["expiry"] == contract["expiry"]
    fee = view["trades"][0]["commission"]
    assert view["wallet_balance"] == round(900 - fee, 2)
    assert view["pnl"] == -fee
    await engine.place(
        "u", parent["session_id"], request("SELL", "exit", 110, budget=1)
    )
    await engine.on_quote(
        service.runtime("u", parent["session_id"]),
        child,
        {"type": "tick", "time": now, "close": 110, "expiry": contract["expiry"]},
    )
    view = service.snapshot("u", parent["session_id"])
    assert view["positions"] == []
    assert view["wallet_balance"] == round(
        1050 - sum(t["commission"] for t in view["trades"]), 2
    )
    assert ledger.values(ledger.read(child)["ledger"])["quantity"] == 0
    # Atomic Orders/Trades/ledger survive reconstruction, without a second cash debit.
    before = view["wallet_balance"]
    engine.restore(child)
    assert service.snapshot("u", parent["session_id"])["wallet_balance"] == before


@pytest.mark.asyncio
async def test_short_entry_buy_cover_and_idempotent_retry(future_book):
    parent, _contract, now = future_book
    first = await engine.place("u", parent["session_id"], request("SELL"))
    retry = await engine.place("u", parent["session_id"], request("SELL"))
    assert (
        retry["order_id"] == first["order_id"]
        and retry["wallet_balance"] == first["wallet_balance"]
    )
    current = service.runtime("u", parent["session_id"])
    child = current.contexts["NIFTY:futures:2026-10-27"]
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 100})
    assert trading.get_position(child.session_id, expiry=child.expiry).side == "SHORT"
    await engine.place("u", parent["session_id"], request("BUY", "cover", 90, budget=1))
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 90})
    assert service.snapshot("u", parent["session_id"])["positions"] == []


@pytest.mark.asyncio
async def test_missing_or_over_budget_margin_does_not_create_a_fill(
    future_book, monkeypatch
):
    parent, _contract, now = future_book
    await engine.place("u", parent["session_id"], request(budget=101))
    current = service.runtime("u", parent["session_id"])
    child = current.contexts["NIFTY:futures:2026-10-27"]
    monkeypatch.setattr(
        risk,
        "live_margin",
        lambda *a, **k: (_ for _ in ()).throw(ValueError("missing")),
    )
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 100})
    assert service.snapshot("u", parent["session_id"])["trades"] == []
    monkeypatch.setattr(
        risk, "live_margin", lambda *a, **k: {"margin": 200, "live": True}
    )
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 100})
    assert service.snapshot("u", parent["session_id"])["trades"] == []
    assert service.snapshot("u", parent["session_id"])["reconciliation_pending"]


@pytest.mark.asyncio
async def test_old_order_api_cannot_bypass_margin_preview_or_edit_future_entry(
    future_book,
):
    from app.services import order_service

    parent, _, _ = future_book
    await engine.place("u", parent["session_id"], request())
    child = service.runtime("u", parent["session_id"]).contexts[
        "NIFTY:futures:2026-10-27"
    ]
    with pytest.raises(ValueError, match="margin preview"):
        order_service.place_order(
            child.session_id,
            child.symbol,
            TradeSide.BUY,
            OrderType.LIMIT,
            5,
            1,
            child.date,
            limit_price=100,
            expiry=child.expiry,
            user_id="u",
        )
    pending = order_service.get_open_orders(child.session_id)[0]
    with pytest.raises(ValueError, match="cancelled and replaced"):
        order_service.update_order(
            child.session_id, pending.order_id, child.date, limit_price=101
        )
    with pytest.raises(ValueError, match="cancelled and replaced"):
        order_service.convert_order(
            child.session_id, pending.order_id, OrderType.TARGET, child.date, price=101
        )


@pytest.mark.asyncio
async def test_future_exit_survives_disabled_entries_and_changed_fee_profile(
    future_book, monkeypatch
):
    parent, _, now = future_book
    await engine.place("u", parent["session_id"], request("SELL"))
    current = service.runtime("u", parent["session_id"])
    child = current.contexts["NIFTY:futures:2026-10-27"]
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 100})
    monkeypatch.setattr(
        risk, "settings", lambda: risk.RiskSettings(paper_enabled=False)
    )
    cover = request("BUY", "cover", 90, budget=1).model_copy(update={"fee_hash": "old"})
    await engine.place("u", parent["session_id"], cover)
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 90})
    assert service.snapshot("u", parent["session_id"])["positions"] == []


@pytest.mark.asyncio
async def test_wrong_expiry_or_stale_quote_never_fills_future(future_book):
    parent, _, now = future_book
    await engine.place("u", parent["session_id"], request())
    current = service.runtime("u", parent["session_id"])
    child = current.contexts["NIFTY:futures:2026-10-27"]
    await engine.on_quote(
        current,
        child,
        {"type": "tick", "time": now, "close": 100, "expiry": "2026-11-24"},
    )
    await engine.on_quote(
        current, child, {"type": "tick", "time": now - 121, "close": 100}
    )
    assert trading.get_trades(child.session_id) == []


@pytest.mark.asyncio
async def test_official_mtm_is_atomic_and_restart_idempotent(future_book, monkeypatch):
    from datetime import UTC, datetime

    parent, _, now = future_book
    await engine.place("u", parent["session_id"], request())
    current = service.runtime("u", parent["session_id"])
    child = current.contexts["NIFTY:futures:2026-10-27"]
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 100})
    before = service.snapshot("u", parent["session_id"])["wallet_balance"]
    tomorrow = int(datetime(2026, 10, 14, 9, 15, tzinfo=UTC).timestamp())
    monkeypatch.setattr("app.services.swing_market.now", lambda: tomorrow)
    monkeypatch.setattr("app.services.swing_market.today", lambda: "2026-10-14")
    monkeypatch.setattr(
        "app.services.futures_settlements.official",
        lambda c, d: {"date": d, "price": 110, "source": "official fixture"},
    )
    await engine.settle_pending(child)
    assert service.snapshot("u", parent["session_id"])["wallet_balance"] == before + 50
    engine.restore(child)
    await engine.settle_pending(child)
    assert service.snapshot("u", parent["session_id"])["wallet_balance"] == before + 50
    assert ledger.values(ledger.read(child)["ledger"], 110)["unsettled_pnl"] == 0


@pytest.mark.asyncio
async def test_emergency_short_cover_uses_future_ledger_without_notional_debit(
    future_book,
):
    from app.services import emergency_exit

    parent, _, now = future_book
    await engine.place("u", parent["session_id"], request("SELL"))
    current = service.runtime("u", parent["session_id"])
    child = current.contexts["NIFTY:futures:2026-10-27"]
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 100})
    before = service.snapshot("u", parent["session_id"])["wallet_balance"]
    order = await emergency_exit.create_exit(
        child,
        {"right": None, "strike": None, "expiry": child.expiry},
        TradeSide.BUY,
        5,
        100,
    )
    assert order.reserved_amount == 0
    assert service.snapshot("u", parent["session_id"])["wallet_balance"] == before
    await engine.on_quote(current, child, {"type": "tick", "time": now, "close": 100})
    view = service.snapshot("u", parent["session_id"])
    assert view["positions"] == []
    assert view["wallet_balance"] == round(
        1000 - sum(t["commission"] for t in view["trades"]), 2
    )
