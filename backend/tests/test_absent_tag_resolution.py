"""A complete broker order report that never contained a locally-ambiguous
order's own tag is proof the broker never accepted it -- build_orders()
must resolve that to 'failed'/CANCELLED instead of leaving recovery_state
stuck forever. Reproduces the 2026-10-27 incident where order 43a36fe2
stayed 'unknown' for over 90 minutes, surviving a session restart, because
nothing ever acted on a complete-but-absent report. See
docs/kotak-protection-recovery.md."""
import time

import pytest

from app.models.schemas import Order, OrderStatus, OrderType, TradeSide
from app.services import order_service, real_broker_state as state, simulation
from tests.test_phase19_broker_snapshot import env


def _uncertain_order(session, *, age_ms=10_000, **kwargs):
    defaults = dict(session_id=session.session_id, user_id=session.user_id, symbol=session.symbol,
        side=TradeSide.BUY, order_type=OrderType.LIMIT, quantity=65, limit_price=50, trigger_price=50,
        created_at=1, right='CE', strike=71500, expiry=session.expiry, recovery_state='unknown',
        analytics={'broker_tag': 'tm-stale'}, broker_submission_at=int(time.time() * 1000) - age_ms)
    return Order(**{**defaults, **kwargs})


def test_build_orders_resolves_absent_tag_as_failed_once_old_enough(monkeypatch):
    session = simulation.SimulationSession('s', 'NIFTY', '2026-10-09', '09:15:00', 1,
        user_id='u', session_type='real', instrument_type='options', execution_broker='KotakNeo')
    stale = _uncertain_order(session)
    monkeypatch.setattr(order_service, '_orders', {'s': {stale.order_id: stale}})
    absent = []
    result = state.build_orders(session, [], absent=absent)
    resolved = result[stale.order_id]
    assert resolved.recovery_state == 'failed'
    assert resolved.status == OrderStatus.CANCELLED
    assert absent == [stale.order_id]


def test_build_orders_does_not_resolve_absent_tag_too_soon_after_submission(monkeypatch):
    session = simulation.SimulationSession('s', 'NIFTY', '2026-10-09', '09:15:00', 1,
        user_id='u', session_type='real', instrument_type='options', execution_broker='KotakNeo')
    fresh = _uncertain_order(session, age_ms=0)
    monkeypatch.setattr(order_service, '_orders', {'s': {fresh.order_id: fresh}})
    absent = []
    result = state.build_orders(session, [], absent=absent)
    resolved = result[fresh.order_id]
    assert resolved.recovery_state == 'unknown'
    assert resolved.status != OrderStatus.CANCELLED
    assert absent == []


@pytest.mark.asyncio
async def test_refresh_releases_wallet_reservation_for_resolved_absent_order(env, monkeypatch):
    """The status/recovery_state flip alone isn't enough -- a BUY entry that
    never reached the broker must also get its wallet reservation back,
    exactly like a local cancel would."""
    s, broker, _ = env
    stale = _uncertain_order(s, strike=71500, expiry=s.expiry, reserved_amount=3250.0,
        wallet_ledger_id=f"real:kotak:account-a:{s.date}", wallet_ledger_kind='real')
    order_service._orders[s.session_id][stale.order_id] = stale
    credited = []
    monkeypatch.setattr('app.services.wallet_service.credit_ledger', lambda *a, **k: credited.append((a, k)))
    await state.refresh(s, broker)
    resolved = order_service.get_order(s.session_id, stale.order_id)
    assert resolved.status == OrderStatus.CANCELLED
    assert resolved.recovery_state == 'failed'
    assert resolved.reserved_amount == 0
    assert credited, "wallet reservation was never released for the resolved-absent order"


def test_resolve_tag_does_not_declare_absent_when_tag_present_with_mismatched_attrs():
    """A broker row carrying our unique tag but a different quantity/side/
    contract is a genuinely ambiguous state, not proof of absence -- must
    never auto-cancel a guess. Only a tag that's in NO row at all, once old
    enough, is trustworthy proof the broker never accepted it."""
    session = simulation.SimulationSession('s', 'NIFTY', '2026-10-09', '09:15:00', 1,
        user_id='u', session_type='real', instrument_type='options', execution_broker='KotakNeo')
    stale = _uncertain_order(session)
    mismatched_row = dict(tag='tm-stale', quantity=130, side='SELL', right='PE', strike=12345, expiry='2099-01-01')
    outcome, match = state._resolve_tag(stale, [mismatched_row])
    assert outcome == 'too_soon'
    assert match is None


def test_build_orders_without_absent_collector_leaves_swing_style_order_untouched(monkeypatch):
    """swing_real.refresh() calls build_orders() without `absent=` -- its
    wallet handling (swing_cash, not the intraday reservation path) doesn't
    get the credit-back companion, so the absent-resolution must not run
    for that caller at all, leaving the order for swing's own handling."""
    session = simulation.SimulationSession('s', 'NIFTY', '2026-10-09', '09:15:00', 1,
        user_id='u', session_type='real', instrument_type='options', execution_broker='KotakNeo')
    stale = _uncertain_order(session)
    monkeypatch.setattr(order_service, '_orders', {'s': {stale.order_id: stale}})
    result = state.build_orders(session, [])  # no absent= passed, matching swing_real.refresh()
    resolved = result[stale.order_id]
    assert resolved.recovery_state == 'unknown'
    assert resolved.status != OrderStatus.CANCELLED
