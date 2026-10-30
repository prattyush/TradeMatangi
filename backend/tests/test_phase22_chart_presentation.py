"""Chart response additions must not introduce new execution paths."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.services.strategy_presentation import strategy_line_price


@pytest.mark.parametrize("kind,metadata,price", [
    ("TargetProfit", {"target_profit_value": 125}, 125),
    ("TargetProfit", {"target_profit_value": 5, "target_profit_is_pct": True}, None),
    ("UnderlyingTargetProfit", {"target_profit_value": 24000}, 24000),
    ("LockProfit", {"lock_profit_price": 120}, 120),
    ("LockProfit", {"lock_profit_value": 121}, 121),
    ("LockProfit", {"lock_profit_value": 5, "lock_profit_is_pct": True}, None),
    ("UnderlyingStoploss", {"underlying_sl_price": 23000}, 23000),
    ("BreakEven", {}, None),
])
def test_strategy_price_uses_existing_metadata_without_executing(kind, metadata, price):
    before = dict(metadata)
    assert strategy_line_price(SimpleNamespace(strategy_type=kind, metadata=metadata)) == price
    assert metadata == before


def test_website_list_preserves_values_and_adds_exact_price_identity(monkeypatch):
    from app.routers import strategies
    metadata = {"target_profit_value": 24000, "desktop_strike": 23000, "desktop_expiry": "2026-10-20", "desktop_contract_key": "exact-contract"}
    instance = SimpleNamespace(strategy_id="strategy", strategy_type="UnderlyingTargetProfit", symbol="NIFTY", right="CE", status=SimpleNamespace(value="RUNNING"), metadata=metadata)
    monkeypatch.setattr(strategies, "_session_or_404", lambda *args: object())
    monkeypatch.setattr(strategies.strategy_service, "list_running", lambda sid: [instance])
    response = strategies.list_strategies("session", "owner")[0]
    assert response.price == response.target_profit_value == 24000
    assert (response.strike, response.expiry, response.contract_key) == (23000, "2026-10-20", "exact-contract")


@pytest.mark.asyncio
@pytest.mark.parametrize("broker_name", ["kotak", "kite"])
async def test_desktop_refresh_exposes_existing_evidence_with_one_existing_broker_call(monkeypatch, broker_name):
    from app.routers import desktop_trading
    from app.services import execution_broker, real_broker_state
    session = SimpleNamespace(session_type="real", execution_broker=broker_name)
    broker = object()
    evidence = {"orders": [{"broker_order_id": "broker-order", "limit_price": 120}], "snapshot_revision": "revision", "state_version": 12, "state_generation": "generation"}
    refresh = AsyncMock(return_value=evidence)
    snapshot = SimpleNamespace(version=17, current_time=1000)
    monkeypatch.setattr(desktop_trading, "_require_session", lambda *args: session)
    monkeypatch.setattr(desktop_trading, "_snapshot", lambda *args: snapshot)
    monkeypatch.setattr(execution_broker, "get_service", Mock(return_value=broker))
    monkeypatch.setattr(real_broker_state, "refresh", refresh)
    result = await desktop_trading.refresh_real("session", "owner")
    refresh.assert_awaited_once_with(session, broker)
    assert result is snapshot
    assert (result.version, result.current_time) == (17, 1000)
    assert result.broker_orders == evidence["orders"]
    assert (result.broker_state_version, result.broker_state_generation) == (12, "generation")
