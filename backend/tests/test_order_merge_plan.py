"""Unit tests for order_service.plan_merge (pure consolidation planning logic)."""
from app.services.order_service import plan_merge, distribute_freed_quantity
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


# ── distribute_freed_quantity (Fix 1 Phase 2 recomputation) ───────────────────

def test_distribute_full_freed_matches_original_plan():
    orders = [_order("a", 1000, created_at=1), _order("b", 1000, created_at=2), _order("c", 1000, created_at=3)]
    plan = plan_merge(orders, max_qty=1800)
    # Simulate: all 1 redundant order cancelled cleanly, freeing its full remaining qty.
    freed_total = sum(o.quantity for o in plan.cancel)
    bumps = distribute_freed_quantity(plan.keep, freed_total, cap=1800)
    assert {order.order_id: new_qty for order, new_qty in bumps} == {order.order_id: new_qty for order, new_qty in plan.keep}


def test_distribute_partial_freed_only_bumps_earlier_keepers():
    keeper_a = _order("a", 100, created_at=1)
    keeper_b = _order("b", 100, created_at=2)
    # cap=100: a and b can each absorb up to 100 more, i.e. up to 200 total each is capped at 100 increase.
    bumps = distribute_freed_quantity([(keeper_a, 999), (keeper_b, 999)], freed=150, cap=200)
    result = {order.order_id: new_qty for order, new_qty in bumps}
    assert result["a"] == 200  # fully filled to cap first
    assert result["b"] == 150  # only partially filled with the remainder
    for order, new_qty in bumps:
        assert new_qty >= order.quantity  # additive-only, never a decrease


def test_distribute_omits_trailing_keeper_when_pool_exhausted():
    keeper_a = _order("a", 100, created_at=1)
    keeper_b = _order("b", 100, created_at=2)
    bumps = distribute_freed_quantity([(keeper_a, 999), (keeper_b, 999)], freed=50, cap=200)
    result = {order.order_id: new_qty for order, new_qty in bumps}
    assert result == {"a": 150}
    assert "b" not in result  # omitted, never bumped to a smaller or zero value


def test_distribute_zero_freed_returns_empty():
    keeper_a = _order("a", 100, created_at=1)
    assert distribute_freed_quantity([(keeper_a, 999)], freed=0, cap=200) == []


def test_distribute_excess_freed_logs_and_drops_remainder(caplog):
    keeper_a = _order("a", 100, created_at=1)
    bumps = distribute_freed_quantity([(keeper_a, 999)], freed=500, cap=200)
    assert bumps == [(keeper_a, 200)]  # capped at 200, the extra 400 can't be placed anywhere
