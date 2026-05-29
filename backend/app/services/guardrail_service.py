"""
GuardRail service: three in-session trading risk controls.

BLOCK    — manual, blocks trading for n bars from the trigger bar.
COOLDOWN — auto, watches for p consecutive loss trades then blocks n bars.
BAN      — auto, permanently stops trading when capital loss > x% or loss
            trade % > y%. No override — fires once and sticks for the session.

All runtime state lives on SimulationSession (in-memory). Settings are
snapshotted from UserSettings at create_session() time via initialize_guardrails().
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from app.models.schemas import TradeSide

if TYPE_CHECKING:
    from app.services.simulation import SimulationSession

logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _current_bar_slot(session: "SimulationSession") -> int:
    """Return the Unix timestamp of the bar boundary the session is currently in."""
    try:
        ts = int(session.current_time) if session.current_time else 0
    except (TypeError, ValueError):
        ts = 0
    interval = session.strategy_interval_secs or 180
    return (ts // interval) * interval


def _emit_guardrail_event(session: "SimulationSession", guardrail_type: str, reason: str, until_bar: int = 0) -> None:
    """Push a guardrail_activated SSE event onto the session queue."""
    event = {
        "type": "guardrail_activated",
        "guardrail_type": guardrail_type,
        "reason": reason,
        "until_bar": until_bar,
    }
    try:
        session.queue.put_nowait(json.dumps(event))
    except Exception:
        pass  # QueueFull or session already stopped — non-critical


# ── Initialisation ────────────────────────────────────────────────────────────

def initialize_guardrails(session: "SimulationSession", user_id: str) -> None:
    """Snapshot guardrail settings from UserSettings onto the session at creation time."""
    try:
        from app.services.user_settings_service import get_settings
        settings = get_settings(user_id)
    except Exception:
        logger.warning("Could not load user settings for guardrails; using defaults")
        settings = {}

    session.guardrail_block_bars = int(settings.get("guardrail_block_bars", 3))
    session.guardrail_cooldown_losses = int(settings.get("guardrail_cooldown_losses", 3))
    session.guardrail_ban_capital_pct = float(settings.get("guardrail_ban_capital_pct", 10.0))
    session.guardrail_ban_loss_trade_pct = float(settings.get("guardrail_ban_loss_trade_pct", 60.0))
    session.guardrail_ban_enabled = bool(settings.get("guardrail_ban_enabled", False))
    session.guardrail_cooldown_enabled = bool(settings.get("guardrail_cooldown_enabled", False))
    session.guardrail_block_until_bar = 0
    session.guardrail_ban_active = False
    session.guardrail_consecutive_losses = 0


# ── Check (called on every buy/sell attempt) ──────────────────────────────────

def check_guardrails(session: "SimulationSession") -> tuple[bool, str]:
    """
    Return (blocked, reason). Called from trading.py buy() and sell() before
    any order logic. Returns True if the user must not trade right now.
    """
    if session.guardrail_ban_active:
        return True, "BAN: trading suspended for this session due to risk limit breach"

    if session.guardrail_block_until_bar > 0:
        current_slot = _current_bar_slot(session)
        if current_slot <= session.guardrail_block_until_bar:
            n = session.guardrail_block_bars
            return True, f"BLOCK: trading paused for {n} bars — expires after bar at {session.guardrail_block_until_bar}"

    return False, ""


# ── Manual BLOCK trigger ──────────────────────────────────────────────────────

def trigger_block(session: "SimulationSession") -> tuple[str, int]:
    """
    Manually trigger the BLOCK guardrail. Blocks the current bar + n more bars.
    Returns (reason, until_bar).
    """
    interval = session.strategy_interval_secs or 180
    current_slot = _current_bar_slot(session)
    n = session.guardrail_block_bars
    # Block current bar + n more: until_bar is the last blocked bar's start timestamp
    until_bar = current_slot + n * interval
    session.guardrail_block_until_bar = until_bar
    reason = f"BLOCK: trading paused for {n} bars"
    _emit_guardrail_event(session, "BLOCK", reason, until_bar)
    logger.info("BLOCK guardrail triggered on session %s until bar %s", session.session_id, until_bar)
    return reason, until_bar


# ── Post-trade hook ──────────────────────────────────────────────────────────

def on_trade_record(session_id: str) -> None:
    """
    Called from trading.record_trade() after every fill.
    Updates consecutive loss count for COOLDOWN and checks BAN conditions.
    """
    try:
        from app.services.simulation import get_session
        session = get_session(session_id)
        if session is None:
            return

        if session.guardrail_cooldown_enabled and not session.guardrail_ban_active:
            _check_cooldown(session)

        if session.guardrail_ban_enabled and not session.guardrail_ban_active:
            _check_ban(session)
    except Exception:
        logger.exception("Error in on_trade_record for session %s", session_id)


def _check_cooldown(session: "SimulationSession") -> None:
    """Update consecutive loss count; trigger a bar-block if threshold is reached."""
    losses = _count_consecutive_losses(session.session_id)
    session.guardrail_consecutive_losses = losses
    p = session.guardrail_cooldown_losses
    if losses >= p:
        interval = session.strategy_interval_secs or 180
        current_slot = _current_bar_slot(session)
        n = session.guardrail_block_bars
        until_bar = current_slot + n * interval
        session.guardrail_block_until_bar = until_bar
        session.guardrail_consecutive_losses = 0  # reset after triggering
        reason = f"COOLDOWN: {p} consecutive losses — trading paused for {n} bars"
        _emit_guardrail_event(session, "COOLDOWN", reason, until_bar)
        logger.info("COOLDOWN triggered on session %s until bar %s", session.session_id, until_bar)


def _check_ban(session: "SimulationSession") -> None:
    """Evaluate BAN conditions; permanently suspend trading if triggered."""
    banned, reason = _compute_ban_check(session)
    if banned:
        session.guardrail_ban_active = True
        _emit_guardrail_event(session, "BAN", reason, 0)
        logger.info("BAN guardrail triggered on session %s: %s", session.session_id, reason)


# ── Internal calculations ──────────────────────────────────────────────────────

def _compute_ban_check(session: "SimulationSession") -> tuple[bool, str]:
    """Return (should_ban, reason) based on capital loss % and loss-trade %."""
    from app.services.trading import get_trades
    trades = get_trades(session.session_id)
    if not trades:
        return False, ""

    capital = session.session_capital
    if capital <= 0:
        return False, ""

    # Net P&L across all trades
    total_buy = sum(t.price * t.quantity for t in trades if t.side == TradeSide.BUY)
    total_sell = sum(t.price * t.quantity for t in trades if t.side == TradeSide.SELL)
    total_commission = sum(t.commission for t in trades)
    net_pnl = total_sell - total_buy - total_commission

    if net_pnl < 0:
        loss_pct = abs(net_pnl) / capital * 100
        if loss_pct > session.guardrail_ban_capital_pct:
            return True, (
                f"BAN: capital loss {loss_pct:.1f}% exceeds limit of "
                f"{session.guardrail_ban_capital_pct:.1f}%"
            )

    # Loss-trade % based on completed round-trips
    round_trips = _compute_round_trips(trades)
    if round_trips:
        loss_trades = sum(1 for pnl in round_trips if pnl < 0)
        loss_trade_pct = loss_trades / len(round_trips) * 100
        if loss_trade_pct > session.guardrail_ban_loss_trade_pct:
            return True, (
                f"BAN: {loss_trade_pct:.0f}% of trades in loss exceeds limit of "
                f"{session.guardrail_ban_loss_trade_pct:.0f}%"
            )

    return False, ""


def _count_consecutive_losses(session_id: str) -> int:
    """
    Count trailing consecutive loss round-trips across all rights (CE, PE, equity).
    A round-trip is a FIFO-matched BUY+SELL (or SELL+BUY for short) that fully closes.
    Partial open positions are ignored. Returns 0 if no completed round-trips.
    """
    from app.services.trading import get_trades
    trades = get_trades(session_id)
    if not trades:
        return 0

    round_trips = _compute_round_trips(trades)
    if not round_trips:
        return 0

    count = 0
    for pnl in reversed(round_trips):
        if pnl < 0:
            count += 1
        else:
            break
    return count


def _compute_round_trips(trades: list) -> list[float]:
    """
    Compute realized P&L for each completed round-trip across all rights,
    ordered by close timestamp.

    Uses FIFO matching per (right) group. When net qty returns to 0, a
    round-trip P&L is recorded. Multiple closes within one right are each
    individual entries in the result list.
    """
    from collections import defaultdict, deque

    # Group by right (None = equity, "CE", "PE")
    groups: dict = defaultdict(list)
    for t in sorted(trades, key=lambda x: x.timestamp):
        groups[t.right].append(t)

    # Each entry: (close_timestamp, pnl)
    completed: list[tuple[int, float]] = []

    for right, right_trades in groups.items():
        buy_queue: deque = deque()   # (price, qty)
        sell_queue: deque = deque()  # (price, qty) for short entries

        net_qty = 0
        for t in right_trades:
            qty = t.quantity
            price = t.price

            if t.side == TradeSide.BUY:
                net_qty += qty
                buy_queue.append([price, qty])
            else:
                net_qty -= qty
                sell_queue.append([price, qty])

            # When net_qty reaches 0, a full round-trip has closed — compute P&L
            if net_qty == 0 and (buy_queue or sell_queue):
                pnl = _fifo_pnl(buy_queue, sell_queue)
                completed.append((t.timestamp, pnl))
                buy_queue.clear()
                sell_queue.clear()

    # Sort by close timestamp for temporal order (matters for consecutive count)
    completed.sort(key=lambda x: x[0])
    return [pnl for _, pnl in completed]


def _fifo_pnl(buy_queue: "deque", sell_queue: "deque") -> float:
    """
    Given matched buy and sell queues for one round-trip, return realized P&L.
    Works for both LONG (BUY then SELL) and SHORT (SELL then BUY) round-trips.
    """
    total_buy = sum(p * q for p, q in buy_queue)
    total_sell = sum(p * q for p, q in sell_queue)
    # LONG: profit = sell proceeds - buy cost
    # SHORT: profit = sell proceeds - buy cost (same formula, buy_cost > sell_proceeds when loss)
    return total_sell - total_buy
