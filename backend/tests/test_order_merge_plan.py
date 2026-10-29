"""Unit tests for order_service.plan_merge (pure consolidation planning logic)."""
from app.services.order_service import plan_merge
from app.models.schemas import Order, OrderType, TradeSide


def _order(order_id: str, quantity: int, *, broker_filled_quantity: int = 0,
           broker_order_id: str | None = None, created_at: int = 1000) -> Order:
    return Order(
        order_id=order_id, session_id="s", user_id="u", symbol="NIFTY",
        side=TradeSide.SELL, order_type=OrderType.STOPLOSS,
        quantity=quantity, trigger_price=100.0, limit_price=100.0,
        created_at=created_at, is_stoploss=True,
        broker_filled_quantity=broker_filled_quantity, broker_order_id=broker_order_id,
    )


def test_merges_into_minimum_order_count():
    orders = [_order("a", 1000, created_at=1), _order("b", 1000, created_at=2), _order("c", 1000, created_at=3)]
    plan = plan_merge(orders, max_qty=1800)
    assert len(plan.keep) == 2
    assert len(plan.cancel) == 1
    assert sum(q for _, q in plan.keep) == 3000
    assert all(q <= 1800 for _, q in plan.keep)


def test_noop_when_already_minimal():
    orders = [_order("a", 1), _order("b", 1)]
    plan = plan_merge(orders, max_qty=1)
    assert plan.keep == []
    assert plan.cancel == []


def test_noop_when_single_order():
    orders = [_order("a", 500)]
    plan = plan_merge(orders, max_qty=1800)
    assert plan.keep == []
    assert plan.cancel == []


def test_conserves_total_quantity_with_partial_fills():
    orders = [
        _order("a", 1000, broker_filled_quantity=400, created_at=1),
        _order("b", 1000, created_at=2),
        _order("c", 1000, created_at=3),
    ]
    # remaining = 600 + 1000 + 1000 = 2600
    plan = plan_merge(orders, max_qty=1800)
    assert len(plan.keep) == 2
    assert sum(q for _, q in plan.keep) == 2600
    assert all(q <= 1800 for _, q in plan.keep)


def test_prefers_orders_with_broker_identity_as_keepers():
    orders = [
        _order("no-broker-1", 100, created_at=1),
        _order("no-broker-2", 100, created_at=2),
        _order("has-broker", 100, created_at=3, broker_order_id="B1"),
    ]
    # total=300, cap=150 -> target_count = ceil(300/150) = 2 < 3 orders -> merges
    plan = plan_merge(orders, max_qty=150)
    kept_ids = {o.order_id for o, _ in plan.keep}
    cancelled_ids = {o.order_id for o in plan.cancel}
    assert kept_ids == {"has-broker", "no-broker-1"}
    assert cancelled_ids == {"no-broker-2"}


def test_deterministic_tie_break_by_created_at_then_order_id():
    orders = [_order("c", 100, created_at=5), _order("a", 100, created_at=5), _order("b", 100, created_at=1)]
    plan = plan_merge(orders, max_qty=100)
    # max_qty==qty per order with 3 orders of 100 each => target_count = ceil(300/100) = 3 == len -> no-op
    assert plan.keep == []
    assert plan.cancel == []


def test_last_keeper_absorbs_remainder():
    orders = [_order("a", 1000, created_at=1), _order("b", 1000, created_at=2), _order("c", 500, created_at=3)]
    # total = 2500, cap = 1800 -> target_count = ceil(2500/1800) = 2
    plan = plan_merge(orders, max_qty=1800)
    assert len(plan.keep) == 2
    quantities = sorted(q for _, q in plan.keep)
    assert quantities == [700, 1800]


def test_empty_orders_returns_empty_plan():
    plan = plan_merge([], max_qty=1800)
    assert plan.keep == []
    assert plan.cancel == []


def test_zero_remaining_quantity_returns_empty_plan():
    orders = [_order("a", 100, broker_filled_quantity=100), _order("b", 100, broker_filled_quantity=100)]
    plan = plan_merge(orders, max_qty=1800)
    assert plan.keep == []
    assert plan.cancel == []


def test_lot_size_rounds_cap_down():
    # max_qty=1800, lot_size=65 -> cap = (1800 // 65) * 65 = 1755
    # total=1800, cap=1755 -> target_count = ceil(1800/1755) = 2 < 3 orders -> merges
    orders = [_order("a", 600, created_at=1), _order("b", 600, created_at=2), _order("c", 600, created_at=3)]
    plan = plan_merge(orders, max_qty=1800, lot_size=65)
    assert len(plan.keep) == 2
    assert len(plan.cancel) == 1
    assert sum(q for _, q in plan.keep) == 1800
    assert all(q <= 1755 for _, q in plan.keep)
