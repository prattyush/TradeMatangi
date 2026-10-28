"""A slow/stuck Kotak SDK call while forwarding a triggered order must not
freeze the whole backend -- reproduces the 2026-10-27 incident where a
single order's 30-second broker timeout froze chart ticks and every HTTP
endpoint for everyone (confirmed in production logs: zero log lines of any
kind for the full 30 seconds). The broker call must run off the event loop
via asyncio.to_thread, not directly on it. See
docs/kotak-protection-recovery.md."""
import asyncio
import time

import pytest

from app.models.schemas import OrderType, TradeSide
from app.services import order_service, simulation
from tests.test_phase19_real_exit_orders import env, local


@pytest.mark.asyncio
async def test_event_loop_stays_responsive_during_slow_broker_forward(env, monkeypatch):
    s, broker, position = env
    order = local(s, OrderType.TARGET, TradeSide.BUY)
    monkeypatch.setattr("app.services.real_trading_day.require_entry_allowed", lambda *a, **k: None)
    monkeypatch.setattr(order_service, "check_orders", lambda *a, **k: [order])

    def slow_place(**kwargs):
        time.sleep(0.2)  # simulates a stuck/slow Kotak SDK call
        return "broker-limit"
    broker.place_limit_order.side_effect = slow_place

    ticks = []
    async def ticker():
        while True:
            ticks.append(1)
            await asyncio.sleep(0.01)

    forward = asyncio.create_task(simulation._emit_tick_and_check_orders_real(
        s, {"time": int(s.current_time), "close": 100}, None, asyncio.get_running_loop()))
    counter = asyncio.create_task(ticker())
    await forward
    counter.cancel()
    # Pre-fix, the synchronous SDK call ran directly on the event loop with
    # no await point, so the ticker never got scheduled until the 0.2s
    # blocking call finished -- it would have advanced ~0 times. Post-fix,
    # the loop stays free to run the ticker throughout.
    assert len(ticks) >= 10, "event loop appears to have been blocked during the broker call"
