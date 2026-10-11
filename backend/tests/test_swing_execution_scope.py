from unittest.mock import Mock
from app.services import simulation, trading, order_service
from app.routers import trading as routes, orders
from app.models.schemas import Order, TradeSide


def session():
    return simulation.SimulationSession(
        "child",
        "HDFCBANK",
        "2026-10-09",
        "09:15:00",
        1,
        user_id="u",
        session_type="paper",
        trading_style="swing",
        portfolio_id="parent",
        wallet_ledger_id="swing:parent",
        session_capital=100000,
    )


def test_swing_equity_has_no_intraday_leverage_and_no_daily_flatten(monkeypatch):
    child = session()
    assert not trading._uses_equity_intraday_margin(child)
    assert not routes._uses_equity_intraday_margin(child)
    assert not orders._uses_equity_intraday_margin(child)
    assert routes._margin_rate_for(child) == 1
    assert (
        simulation._auto_close_positions_if_eod(child, {"time": 0, "close": 100}, None)
        == []
    )
    child.trading_style = "intraday"
    assert routes._margin_rate_for(child) == 0.2


def test_orders_retain_portfolio_provenance_without_changing_legacy_defaults(
    monkeypatch,
):
    child = session()
    monkeypatch.setattr(simulation, "get_session", lambda *a: child)
    order = Order(
        session_id="child",
        user_id="u",
        symbol="HDFCBANK",
        side="BUY",
        quantity=1,
        created_at=1,
        trigger_price=100,
        limit_price=100,
        trading_style="swing",
        portfolio_id="parent",
    )
    item = order_service._order_db_item(order)
    assert item["trading_style"] == "swing" and item["portfolio_id"] == "parent"
    old = Order(
        session_id="old",
        user_id="u",
        symbol="HDFCBANK",
        side="BUY",
        quantity=1,
        created_at=1,
        trigger_price=100,
        limit_price=100,
    )
    assert old.trading_style == "intraday" and old.portfolio_id is None


def test_swing_paper_buy_settlement_consumes_full_value(monkeypatch):
    child = session()
    debit = Mock()
    monkeypatch.setattr(trading, "_wallet_debit", debit)
    trading.settle_wallet_for_trade(child, TradeSide.BUY, 100, 10)
    debit.assert_called_once_with(child, 1000, None, allow_negative=False, order=None)
