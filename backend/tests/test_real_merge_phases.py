"""Unit tests for the real-trading merge sequencing fix:
- broker_order_service.cancel_and_confirm (the WS-confirmed cancel primitive)
- orders._cancel_merge_redundant / _run_merge_cancel_phase / _run_merge_bump_phase
"""
import asyncio
import pytest
from unittest.mock import patch, MagicMock

from app.models.schemas import Order, OrderType, OrderStatus, TradeSide
from app.services import broker_order_service, order_service
from app.routers import orders as orders_router


def _order(order_id: str, quantity: int, *, broker_filled_quantity: int = 0,
           broker_order_id: str | None = "B1", status: OrderStatus = OrderStatus.PENDING) -> Order:
    return Order(
        order_id=order_id, session_id="s", user_id="u", symbol="NIFTY",
        side=TradeSide.SELL, order_type=OrderType.STOPLOSS,
        quantity=quantity, trigger_price=100.0, limit_price=100.0,
        created_at=1000, is_stoploss=True, status=status,
        broker_filled_quantity=broker_filled_quantity, broker_order_id=broker_order_id,
    )


def _real_session():
    session = MagicMock()
    session.session_id = "real-session"
    session.session_type = "real"
    session.symbol = "NIFTY"
    session.user_id = "u"
    session.date = "2026-10-29"
    return session


class FakeBroker:
    """Captures observer registration; call fire() to simulate a WS event."""
    def __init__(self):
        self.observers = {}
        self.cancel_calls = []
        self.single_slot_calls = []

    def register_order_observer(self, token, callback, loop):
        self.observers[token] = (callback, loop)

    def deregister_order_observer(self, token):
        self.observers.pop(token, None)

    def cancel_order(self, broker_order_id, **kwargs):
        self.cancel_calls.append((broker_order_id, kwargs))

    def register_cancel_callback(self, *a, **k): self.single_slot_calls.append(("cancel", a, k))
    def register_fill_callback(self, *a, **k): self.single_slot_calls.append(("fill", a, k))
    def register_reject_callback(self, *a, **k): self.single_slot_calls.append(("reject", a, k))

    def fire(self, raw):
        for callback, _loop in list(self.observers.values()):
            callback(raw)


def _raw_event(broker_order_id: str, status: str) -> dict:
    return {"nOrdNo": broker_order_id, "ordSt": status, "trnsTp": "S", "qty": 20, "fldQty": 0}


@pytest.mark.asyncio
class TestCancelAndConfirm:
    async def test_noop_for_non_real_session(self):
        session = MagicMock(session_type="sim")
        order = _order("a", 100)
        assert await broker_order_service.cancel_and_confirm(session, order) == "cancelled"

    async def test_noop_when_no_broker_order_id(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id=None)
        assert await broker_order_service.cancel_and_confirm(session, order) == "cancelled"

    async def test_cancelled_outcome(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        broker = FakeBroker()
        with patch("app.services.execution_broker.get_service", return_value=broker), \
             patch("app.routers.orders._session_edit_lock", return_value=_noop_lock()):
            task = asyncio.ensure_future(broker_order_service.cancel_and_confirm(session, order, timeout=2.0))
            await asyncio.sleep(0.01)
            broker.fire(_raw_event("B1", "cancelled"))
            outcome = await task
        assert outcome == "cancelled"
        assert broker.single_slot_calls == []  # never touches the production single-slot registries

    async def test_filled_outcome(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        broker = FakeBroker()
        with patch("app.services.execution_broker.get_service", return_value=broker), \
             patch("app.routers.orders._session_edit_lock", return_value=_noop_lock()):
            task = asyncio.ensure_future(broker_order_service.cancel_and_confirm(session, order, timeout=2.0))
            await asyncio.sleep(0.01)
            broker.fire(_raw_event("B1", "complete"))
            outcome = await task
        assert outcome == "filled"

    async def test_rejected_outcome(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        broker = FakeBroker()
        with patch("app.services.execution_broker.get_service", return_value=broker), \
             patch("app.routers.orders._session_edit_lock", return_value=_noop_lock()):
            task = asyncio.ensure_future(broker_order_service.cancel_and_confirm(session, order, timeout=2.0))
            await asyncio.sleep(0.01)
            broker.fire(_raw_event("B1", "rejected"))
            outcome = await task
        assert outcome == "rejected"

    async def test_timeout_returns_ambiguous(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        broker = FakeBroker()
        with patch("app.services.execution_broker.get_service", return_value=broker), \
             patch("app.routers.orders._session_edit_lock", return_value=_noop_lock()):
            outcome = await broker_order_service.cancel_and_confirm(session, order, timeout=0.05)
        assert outcome == "ambiguous"
        assert broker.observers == {}  # deregistered even on timeout

    async def test_ignores_events_for_other_orders(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        broker = FakeBroker()
        with patch("app.services.execution_broker.get_service", return_value=broker), \
             patch("app.routers.orders._session_edit_lock", return_value=_noop_lock()):
            task = asyncio.ensure_future(broker_order_service.cancel_and_confirm(session, order, timeout=0.3))
            await asyncio.sleep(0.01)
            broker.fire(_raw_event("OTHER", "cancelled"))  # unrelated order, must be ignored
            await asyncio.sleep(0.01)
            broker.fire(_raw_event("B1", "cancelled"))
            outcome = await task
        assert outcome == "cancelled"


def _noop_lock():
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _lock(_session=None):
        yield
    return _lock()


@pytest.mark.asyncio
class TestCancelMergeRedundant:
    async def test_cancelled_computes_freed_quantity(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        with patch("app.services.order_service.get_order", side_effect=[order, _order("a", 100, broker_order_id="B1", status=OrderStatus.CANCELLED)]), \
             patch("app.routers.orders._require_cancelable", return_value=None), \
             patch("app.services.kotak_protection.suppress", return_value={}), \
             patch("app.services.broker_order_service.cancel_and_confirm", return_value="cancelled"):
            snapshot, freed, result = await orders_router._cancel_merge_redundant(session, order)
        assert freed == 100
        assert result['state'] == 'cancelled'

    async def test_filled_excludes_quantity_with_distinct_state(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        filled = _order("a", 100, broker_order_id="B1", broker_filled_quantity=100, status=OrderStatus.FILLED)
        with patch("app.services.order_service.get_order", side_effect=[order, filled]), \
             patch("app.routers.orders._require_cancelable", return_value=None), \
             patch("app.services.kotak_protection.suppress", return_value={}), \
             patch("app.services.broker_order_service.cancel_and_confirm", return_value="filled"):
            snapshot, freed, result = await orders_router._cancel_merge_redundant(session, order)
        assert freed == 0
        assert result['state'] == 'cancel_raced_fill'

    async def test_rejected_rolls_back_suppression(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        with patch("app.services.order_service.get_order", side_effect=[order, order]), \
             patch("app.routers.orders._require_cancelable", return_value=None), \
             patch("app.services.kotak_protection.suppress", return_value={"token": "prev"}) as mock_suppress, \
             patch("app.services.kotak_protection.rollback_suppression") as mock_rollback, \
             patch("app.services.broker_order_service.cancel_and_confirm", return_value="rejected"):
            snapshot, freed, result = await orders_router._cancel_merge_redundant(session, order)
        assert freed == 0
        assert result['state'] == 'cancel_rejected'
        mock_rollback.assert_called_once()

    async def test_ambiguous_does_not_roll_back_suppression_and_emits_needs_attention(self):
        session = _real_session()
        order = _order("a", 100, broker_order_id="B1")
        with patch("app.services.order_service.get_order", side_effect=[order, order]), \
             patch("app.routers.orders._require_cancelable", return_value=None), \
             patch("app.services.kotak_protection.suppress", return_value={"token": "prev"}), \
             patch("app.services.kotak_protection.rollback_suppression") as mock_rollback, \
             patch("app.services.broker_order_service.cancel_and_confirm", return_value="ambiguous"), \
             patch("app.services.protection_recovery.emit") as mock_emit:
            snapshot, freed, result = await orders_router._cancel_merge_redundant(session, order)
        assert freed == 0
        assert result['state'] == 'cancel_ambiguous'
        mock_rollback.assert_not_called()
        mock_emit.assert_called_once()
        assert mock_emit.call_args.args[3] == 'needs_attention'


@pytest.mark.asyncio
class TestRunMergeBumpPhase:
    async def test_one_keeper_bump_failure_does_not_block_the_other(self):
        from fastapi import HTTPException
        session = _real_session()
        # cap=150 so neither keeper alone can absorb the full 100 freed --
        # both end up with a real (non-zero) bump target, both attempted.
        keeper_a = _order("a", 100, broker_order_id="B1")
        keeper_b = _order("b", 100, broker_order_id="B2")
        bumped_b = _order("b", 150, broker_order_id="B2")

        async def fake_bump(_session, order_id, _new_qty):
            if order_id == "a":
                raise HTTPException(status_code=409, detail="Recovery submission is unconfirmed")
            return bumped_b

        with patch("app.services.order_service.get_max_contracts", return_value=150), \
             patch("app.routers.orders._bump_quantity_locked", side_effect=fake_bump):
            snapshots, results = await orders_router._run_merge_bump_phase(
                session, [(keeper_a, 999), (keeper_b, 999)], total_freed=100, lot_size=1,
            )
        states = {r['order_id']: r['state'] for r in results if r.get('order_id')}
        assert states["a"] == "bump_failed"
        assert states["b"] == "bumped"
        assert any(s.order_id == "b" and s.quantity == 150 for s in snapshots)
