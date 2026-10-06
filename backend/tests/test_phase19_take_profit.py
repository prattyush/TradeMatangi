import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.models.schemas import OrderType, Position, TradeSide
from app.services import order_service as orders, strategy_service as strategies


@pytest.fixture(autouse=True)
def isolate():
    orders.clear_session("half-test")
    orders._orders["half-test"] = {}
    strategies.clear_session("half-test")
    with patch.object(orders, "_write_order_to_db"), patch.object(strategies, "_write_strategy_to_db"), \
         patch("app.services.wallet_service.debit"), patch("app.services.wallet_service.credit"):
        yield
    orders.clear_session("half-test")
    strategies.clear_session("half-test")


def session():
    return SimpleNamespace(session_id="half-test", user_id="user", symbol="NIFTY", date="2026-09-30",
        session_type="paper", strike=25000, strike_ce=25000, expiry="2026-10-06", queue=asyncio.Queue(),
        strategy_interval_secs=180, session_capital=100000, last_price=25100, instrument_type="options")


@pytest.mark.parametrize("lots,expected", [(0, 0), (1, 1), (2, 1), (3, 1), (4, 2), (5, 2)])
def test_half_rounding(lots, expected):
    assert strategies.target_profit_quantity(lots * 25, 25, "half") == expected * 25


@pytest.mark.parametrize("underlying", [False, True])
@pytest.mark.parametrize("side", ["LONG", "SHORT"])
def test_half_splits_existing_stop_and_preserves_remainder(underlying, side):
    s = session()
    from app.config import LOT_SIZES
    lot = LOT_SIZES[s.symbol]
    exit_side = TradeSide.SELL if side == "LONG" else TradeSide.BUY
    stop = orders.place_order(s.session_id, s.symbol, exit_side, OrderType.STOPLOSS, 4 * lot, 1, s.date,
        trigger_price=90 if side == "LONG" else 110, right="CE", strike=s.strike, expiry=s.expiry,
        is_stoploss=True, user_id=s.user_id)
    strategy = strategies.start_strategy(s, "UnderlyingTargetProfit" if underlying else "TargetProfit", "CE",
        {"target_profit_size": "half", "target_profit_value": 120})
    position = Position(symbol=s.symbol, side=side, quantity=4 * lot, avg_entry_price=100)
    strategies._apply_half_exit(strategy, s, position, 120, "CE", 10, underlying=underlying)
    active = orders.get_open_orders(s.session_id)
    assert stop.quantity == 2 * lot
    assert stop.trigger_price == (90 if side == "LONG" else 110)
    action = next(o for o in active if o.order_id != stop.order_id)
    assert action.quantity == 2 * lot
    assert action.order_type == (OrderType.TARGET if underlying else OrderType.LIMIT)
    assert action.exit_position_side == side
    assert strategy.status == strategies.StrategyStatus.COMPLETED


def test_half_uses_reduced_position_at_trigger():
    s = session()
    from app.config import LOT_SIZES
    lot = LOT_SIZES[s.symbol]
    strategy = strategies.start_strategy(s, "TargetProfit", "CE", {"target_profit_size": "half", "target_profit_value": 120})
    with patch.object(strategies, "_strategy_position", return_value=Position(symbol=s.symbol, side="LONG", quantity=2 * lot, avg_entry_price=100)):
        strategies._on_tick_target_profit(strategy, s, 121, "CE", 10)
    assert orders.get_open_orders(s.session_id)[0].quantity == lot


def test_failed_split_restores_protection_and_can_retry():
    s = session()
    stop = orders.place_order(s.session_id, s.symbol, TradeSide.SELL, OrderType.STOPLOSS, 4, 1, s.date, trigger_price=90, is_stoploss=True)
    strategy = strategies.start_strategy(s, "TargetProfit", None, {"target_profit_size": "half"})
    position = Position(symbol=s.symbol, side="LONG", quantity=4, avg_entry_price=100)
    with patch.object(orders, "place_order", side_effect=RuntimeError("write failed")):
        strategies._apply_half_exit(strategy, s, position, 120, None, 10)
    assert stop.quantity == 4 and stop.trigger_price == 90
    assert strategy.status == strategies.StrategyStatus.RUNNING
    strategies._apply_half_exit(strategy, s, position, 120, None, 11)
    assert sum(o.quantity for o in orders.get_open_orders(s.session_id)) == 4


def test_completed_strategy_cannot_be_rearmed_by_size_edit():
    s = session()
    strategy = strategies.start_strategy(s, "TargetProfit", None, {})
    assert strategies.update_target_profit_size(s.session_id, strategy.strategy_id, "half")
    strategy.status = strategies.StrategyStatus.COMPLETED
    assert not strategies.update_target_profit_size(s.session_id, strategy.strategy_id, "full")


def test_manual_reduction_caps_split_exits_without_changing_stop_price():
    s = session()
    from app.config import LOT_SIZES
    lot = LOT_SIZES[s.symbol]
    stop = orders.place_order(s.session_id, s.symbol, TradeSide.SELL, OrderType.STOPLOSS, 4 * lot, 1, s.date,
        trigger_price=90, right="CE", strike=s.strike, expiry=s.expiry, is_stoploss=True)
    strategy = strategies.start_strategy(s, "TargetProfit", "CE", {"target_profit_size": "half"})
    strategies._apply_half_exit(strategy, s, Position(symbol=s.symbol, side="LONG", quantity=4 * lot, avg_entry_price=100), 120, "CE", 10)
    with patch("app.services.trading.get_position", return_value=Position(symbol=s.symbol, side="LONG", quantity=lot, avg_entry_price=100)), patch("app.services.simulation.get_session", return_value=s):
        orders.reconcile_allocated_exits(s.session_id, s.symbol, "CE", s.strike, s.expiry, s.date)
    assert sum(o.quantity for o in orders.get_open_orders(s.session_id)) == lot
    assert stop.quantity == lot and stop.trigger_price == 90


def test_half_trims_old_stop_to_manually_reduced_position_before_splitting():
    s = session()
    from app.config import LOT_SIZES
    lot = LOT_SIZES[s.symbol]
    stop = orders.place_order(s.session_id, s.symbol, TradeSide.SELL, OrderType.STOPLOSS, 4 * lot, 1, s.date,
        trigger_price=90, right="CE", strike=s.strike, expiry=s.expiry, is_stoploss=True)
    strategy = strategies.start_strategy(s, "TargetProfit", "CE", {"target_profit_size": "half"})
    strategies._apply_half_exit(strategy, s, Position(symbol=s.symbol, side="LONG", quantity=2 * lot, avg_entry_price=100), 120, "CE", 10)
    pending = orders.get_open_orders(s.session_id)
    assert len(pending) == 2 and all(o.quantity == lot for o in pending)
    assert stop.trigger_price == 90
    assert next(o for o in pending if o is not stop).limit_price == 120


def test_failed_strategy_persistence_retries_without_duplicate_exit():
    s = session()
    strategy = strategies.start_strategy(s, "TargetProfit", None, {"target_profit_size": "half"})
    position = Position(symbol=s.symbol, side="LONG", quantity=4, avg_entry_price=100)
    with patch.object(strategies, "_write_strategy_to_db", side_effect=RuntimeError("offline")):
        strategies._apply_half_exit(strategy, s, position, 120, None, 10)
    assert strategy.status == strategies.StrategyStatus.RUNNING
    assert len(orders.get_open_orders(s.session_id)) == 0  # prepare must persist before execution
    strategies._apply_half_exit(strategy, s, position, 120, None, 11)
    assert strategy.status == strategies.StrategyStatus.COMPLETED
    assert len(orders.get_open_orders(s.session_id)) == 1


def test_real_half_does_not_change_local_protection_without_broker_acknowledgement():
    from unittest.mock import MagicMock
    s = session()
    s.session_type = "real"
    stop = orders.place_order(s.session_id, s.symbol, TradeSide.SELL, OrderType.STOPLOSS, 4, 1, s.date,
        trigger_price=90, is_stoploss=True)
    stop.kotak_order_id = "broker-stop"
    strategy = strategies.start_strategy(s, "TargetProfit", None, {"target_profit_size": "half"})
    broker = MagicMock()
    broker.modify_sl_order.side_effect = RuntimeError("broker rejected resize")
    with patch("app.services.kotak_service.get_service", return_value=broker):
        strategies._apply_half_exit(strategy, s, Position(symbol=s.symbol, side="LONG", quantity=4, avg_entry_price=100), 120, None, 10)
    assert stop.quantity == 4 and stop.trigger_price == 90
    assert strategy.status == strategies.StrategyStatus.RUNNING
    assert orders.get_open_orders(s.session_id) == [stop]


@pytest.mark.parametrize("stage", ["remainder", "action"])
def test_split_persistence_failure_restores_protection_before_retry(stage):
    s = session()
    stop = orders.place_order(s.session_id, s.symbol, TradeSide.SELL, OrderType.STOPLOSS, 4, 1, s.date, trigger_price=90, is_stoploss=True)
    strategy = strategies.start_strategy(s, "TargetProfit", None, {"target_profit_size": "half"})
    position = Position(symbol=s.symbol, side="LONG", quantity=4, avg_entry_price=100)
    failed = False
    def write(order, **kwargs):
        nonlocal failed
        hit = (stage == "remainder" and order is stop and order.quantity == 2) or (stage == "action" and order is not stop and order.status.value == "PENDING")
        if hit and not failed:
            failed = True
            raise RuntimeError("injected write failure")
    with patch.object(orders, "_write_order_to_db", side_effect=write):
        strategies._apply_half_exit(strategy, s, position, 120, None, 10)
    assert failed
    assert stop.quantity == 4
    assert sum(order.quantity for order in orders.get_open_orders(s.session_id)) == 4
    # Simulate restoration of the persisted prepare record, without volatile IDs.
    strategy.metadata["half_action_order_ids"] = []
    strategies._apply_half_exit(strategy, s, position, 120, None, 11)
    assert strategy.status == strategies.StrategyStatus.COMPLETED
    assert sum(order.quantity for order in orders.get_open_orders(s.session_id)) == 4
    assert len(orders.get_open_orders(s.session_id)) == 2


def test_prepared_half_quantity_does_not_grow_on_retry():
    s = session()
    strategy = strategies.start_strategy(s, "TargetProfit", None, {"target_profit_size": "half"})
    with patch.object(orders, "place_order", side_effect=RuntimeError("offline")):
        strategies._apply_half_exit(strategy, s, Position(symbol=s.symbol, side="LONG", quantity=4, avg_entry_price=100), 120, None, 10)
    strategies._apply_half_exit(strategy, s, Position(symbol=s.symbol, side="LONG", quantity=8, avg_entry_price=100), 120, None, 11)
    assert orders.get_open_orders(s.session_id)[0].quantity == 2


@pytest.mark.asyncio
async def test_failed_reconciliation_retries_without_another_trade():
    orders._exit_retries.clear()
    clock = [100.0]
    calls = []
    def reconcile(*args):
        calls.append(clock[0])
        if len(calls) < 3:
            raise RuntimeError("broker unavailable")
    async def sleep(_):
        clock[0] += 1
        if len(calls) == 3:
            raise asyncio.CancelledError()
    async def in_thread(fn, *args):
        fn(*args)
    with patch.object(orders, "reconcile_allocated_exits", side_effect=reconcile), patch("time.monotonic", side_effect=lambda: clock[0]), patch("asyncio.sleep", side_effect=sleep), patch("asyncio.to_thread", side_effect=in_thread):
        orders.request_exit_reconciliation("half-test", "NIFTY", "CE", 25000, "2026-10-06", "2026-09-30")
        with pytest.raises(asyncio.CancelledError):
            await orders.exit_reconciliation_loop()
    assert calls == [100, 105, 115]
    assert not orders._exit_retries


def test_acknowledged_cancel_write_failure_is_repaired_on_retry():
    from unittest.mock import MagicMock
    s = session()
    order = orders.place_order(s.session_id, s.symbol, TradeSide.SELL, OrderType.STOPLOSS, 4, 1, s.date, trigger_price=90, is_stoploss=True)
    order.exit_allocation_id, order.exit_position_side = "allocation", "LONG"
    order.kotak_order_id = "broker-stop"
    broker = MagicMock()
    failed = False
    persisted = []
    def write(candidate, **kwargs):
        nonlocal failed
        if candidate.status.value == "CANCELLED" and not failed:
            failed = True
            raise RuntimeError("storage unavailable after acknowledgement")
        persisted.append(candidate.status.value)
    orders._exit_retries.clear()
    with patch.object(orders, "_write_order_to_db", side_effect=write), patch("app.services.trading.get_position", return_value=Position(symbol=s.symbol, side="FLAT", quantity=0, avg_entry_price=0)), patch("app.services.kotak_service.get_service", return_value=broker):
        orders.request_exit_reconciliation(s.session_id, s.symbol, None, None, None, s.date)
        assert orders._exit_retries and broker.cancel_order.call_count == 1
        orders.request_exit_reconciliation(s.session_id, s.symbol, None, None, None, s.date)
    assert persisted[-1] == "CANCELLED"
    assert broker.cancel_order.call_count == 1
    assert not orders._exit_retries


@pytest.mark.asyncio
async def test_retry_completion_cannot_clear_newer_failed_reconciliation():
    orders._exit_retries.clear()
    clock = [100.0]
    attempted = [False]
    key = ("half-test", "NIFTY", "CE", 25000, "2026-10-06", "2026-09-30")
    async def sleep(_):
        if attempted[0]:
            raise asyncio.CancelledError()
        clock[0] += 1
    async def in_thread(fn, *args):
        # A newer trade's failed reconciliation arrives before the worker's
        # successful result is observed by the event loop.
        orders.request_exit_reconciliation(*key)
        attempted[0] = True
    with patch.object(orders, "reconcile_allocated_exits", side_effect=RuntimeError("broker unavailable")), patch("time.monotonic", side_effect=lambda: clock[0]), patch("asyncio.sleep", side_effect=sleep), patch("asyncio.to_thread", side_effect=in_thread):
        orders.request_exit_reconciliation(*key)
        original = orders._exit_retries[key]
        with pytest.raises(asyncio.CancelledError):
            await orders.exit_reconciliation_loop()
    assert orders._exit_retries[key] is not original
    orders._exit_retries.clear()


@pytest.mark.parametrize('lots,selected',[(1,1),(2,1),(3,1),(4,2),(5,2)])
def test_phase20_underlying_stoploss_half_keeps_remainder(lots,selected):
    s=session();s.last_price=24900
    from app.config import LOT_SIZES
    lot=LOT_SIZES[s.symbol]
    orders.place_order(s.session_id,s.symbol,TradeSide.SELL,OrderType.STOPLOSS,lots*lot,1,s.date,
                       trigger_price=90,is_stoploss=True,right='CE',strike=s.strike,expiry=s.expiry)
    strategy=strategies.start_strategy(s,'UnderlyingStoploss','CE',dict(underlying_sl_price=25000,underlying_stoploss_size='half'))
    with patch.object(strategies,'_strategy_position',return_value=Position(symbol=s.symbol,side='LONG',quantity=lots*lot,avg_entry_price=100)):
        strategies._on_tick_underlying_stoploss(strategy,s,100,'CE',10)
    actions=[o for o in orders.get_open_orders(s.session_id) if o.exit_allocation_role=='action']
    remainder=[o for o in orders.get_open_orders(s.session_id) if o.exit_allocation_role=='remainder']
    assert sum(o.quantity for o in actions)==selected*lot
    assert sum(o.quantity for o in remainder)==(lots-selected)*lot
    assert all(o.trigger_price==90 for o in remainder)
    assert all(o.analytics['exit_method']=='UnderlyingStoploss' and o.analytics['requested_size']=='half' for o in actions)


def test_phase20_size_edit_cannot_change_a_prepared_underlying_half_allocation():
    s = session()
    strategy = strategies.start_strategy(s, 'UnderlyingStoploss', 'CE', dict(underlying_stoploss_size='half', underlying_sl_price=25000))
    assert strategies.update_target_profit_size(s.session_id, strategy.strategy_id, 'full')
    strategy.metadata.update(underlying_stoploss_size='half', half_action_started=True, half_selected_quantity=65)
    assert not strategies.update_target_profit_size(s.session_id, strategy.strategy_id, 'full')
    assert strategy.metadata['underlying_stoploss_size'] == 'half'
