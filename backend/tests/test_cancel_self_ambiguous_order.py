"""Cancelling an order whose own broker submission is ambiguous must make
bounded progress instead of 409-ing forever -- unlike edit/convert/split,
cancel carries no risk of inventing a duplicate submission. Reproduces the
2026-10-27 incident where a stuck exit order could not be cancelled for
5+ minutes. See docs/kotak-protection-recovery.md."""
import time
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from app.models.schemas import OrderType, TradeSide
from app.services import order_service, kotak_reports
from app.routers import orders
from tests.test_phase19_real_exit_orders import env, local


class _Bundle:
    def __init__(self, orders):
        self.orders = orders
        self.executions = []
        self.positions = []
        self.revision = 1


def _make_uncertain(s, *, tag="tm-ambiguous", age_ms=10_000):
    order = local(s, OrderType.STOPLOSS, TradeSide.SELL)
    order.broker_order_id = None
    order.recovery_state = "unknown"
    order.analytics = {**(order.analytics or {}), "broker_tag": tag}
    order.broker_submission_at = int(time.time() * 1000) - age_ms
    return order


@pytest.mark.asyncio
async def test_cancel_with_known_broker_id_skips_recovery_check(env, monkeypatch):
    """Cancelling a broker-known order must go through regardless of some
    OTHER operation's ambiguous recovery_state -- identity is well-defined."""
    s, broker, position = env
    order = local(s, OrderType.STOPLOSS, TradeSide.SELL)
    order.broker_order_id = "broker-sl"
    order.recovery_state = "unknown"
    fetch = AsyncMock()
    monkeypatch.setattr(kotak_reports, "fetch", fetch)
    cancelled = await orders.cancel_order(order.order_id, s.session_id)
    assert cancelled.status.value == "CANCELLED"
    broker.cancel_order.assert_called_once()
    fetch.assert_not_called()


@pytest.mark.asyncio
async def test_cancel_resolves_absent_tag_and_succeeds_without_broker_call(env, monkeypatch):
    """A complete report that never contained this tag proves the order was
    never accepted -- cancel succeeds locally, no broker round trip needed."""
    s, broker, position = env
    order = _make_uncertain(s)
    monkeypatch.setattr(kotak_reports, "fetch", AsyncMock(return_value=_Bundle([])))
    cancelled = await orders.cancel_order(order.order_id, s.session_id)
    assert cancelled.status.value == "CANCELLED"
    assert order.recovery_state == "failed"
    broker.cancel_order.assert_not_called()


@pytest.mark.asyncio
async def test_cancel_resolves_matched_tag_then_cancels_via_broker(env, monkeypatch):
    """A complete report that DOES contain the tag resolves the identity,
    then cancels that now-known broker order normally."""
    s, broker, position = env
    order = _make_uncertain(s)
    row = dict(tag="tm-ambiguous", broker_order_id="broker-sl", quantity=order.quantity,
               side=order.side.value, right=order.right, strike=order.strike, expiry=order.expiry,
               status="trigger pending", filled_quantity=0, symbol=s.symbol, product="MIS")
    monkeypatch.setattr(kotak_reports, "fetch", AsyncMock(return_value=_Bundle([row])))
    cancelled = await orders.cancel_order(order.order_id, s.session_id)
    assert cancelled.status.value == "CANCELLED"
    assert cancelled.broker_order_id == "broker-sl"
    broker.cancel_order.assert_called_once_with("broker-sl", initiator="user", purpose="user_cancel",
        context={"session_id": s.session_id, "order_id": order.order_id, "user_id": s.user_id})


@pytest.mark.asyncio
async def test_cancel_still_blocked_without_force_when_fetch_fails(env, monkeypatch):
    """A failed/timed-out reconciliation attempt leaves cancel genuinely
    unresolved -- still 409s, but with an actionable message, not silence."""
    s, broker, position = env
    order = _make_uncertain(s)
    monkeypatch.setattr(kotak_reports, "fetch", AsyncMock(side_effect=TimeoutError))
    with pytest.raises(HTTPException) as err:
        await orders.cancel_order(order.order_id, s.session_id)
    assert err.value.status_code == 409
    assert err.value.detail["code"] == "cancel_confirmation_ambiguous"
    assert "force" in err.value.detail["message"]
    assert order_service.get_order(s.session_id, order.order_id).status.value == "PENDING"


@pytest.mark.asyncio
async def test_cancel_with_force_proceeds_and_flags_needs_attention(env, monkeypatch):
    """force=true lets the user act even when reconciliation can't resolve
    it in time, per the override principle -- but the uncertainty must be
    surfaced, not silently dropped."""
    s, broker, position = env
    order = _make_uncertain(s)
    monkeypatch.setattr(kotak_reports, "fetch", AsyncMock(side_effect=TimeoutError))
    emitted = []
    monkeypatch.setattr("app.services.protection_recovery.emit", lambda *a, **k: emitted.append(a))
    cancelled = await orders.cancel_order(order.order_id, s.session_id, force=True)
    assert cancelled.status.value == "CANCELLED"
    assert cancelled.analytics.get("cancel_forced_unconfirmed") is True
    assert emitted and emitted[0][3] == "needs_attention"


@pytest.mark.asyncio
async def test_convert_on_same_ambiguous_order_still_blocked(env, monkeypatch):
    """Regression guard: edit/convert/split keep hard-blocking on an
    order's own ambiguous recovery_state -- only cancel's behavior changed."""
    from app.models.schemas import ConvertOrderRequest
    s, broker, position = env
    order = _make_uncertain(s)
    monkeypatch.setattr(kotak_reports, "fetch", AsyncMock(return_value=_Bundle([])))
    with pytest.raises(HTTPException) as err:
        await orders.convert_order(order.order_id, ConvertOrderRequest(session_id=s.session_id, new_order_type=OrderType.LIMIT))
    assert err.value.status_code == 409
