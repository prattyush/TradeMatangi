"""
Simulation engine: replays second-level OHLC data asynchronously.
One asyncio Task per session; ticks flow through an asyncio.Queue.
Supports pause/resume via asyncio.Event and speed multiplier.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from app.models.schemas import SimulationState
from app.services.data_loader import iter_ticks
from app.config import FIXED_USER_ID

logger = logging.getLogger(__name__)


@dataclass
class SimulationSession:
    session_id: str
    symbol: str
    date: str
    start_time: str
    speed: float
    user_id: str = FIXED_USER_ID       # logged-in user who owns this session
    state: SimulationState = SimulationState.IDLE
    current_time: Optional[str] = None
    last_price: float = 0.0           # equity or single-right options price
    last_price_ce: float = 0.0        # CE price (dual-stream options only)
    last_price_pe: float = 0.0        # PE price (dual-stream options only)
    session_capital: float = 0.0      # wallet balance snapshotted at session start
    instrument_type: str = "equity"   # "equity" or "options"
    strike: Optional[int] = None       # options: ATM/reference strike
    expiry: Optional[str] = None       # options only (YYYY-MM-DD)
    right: Optional[str] = None        # options only: "CE", "PE", or None (dual-stream)
    strike_ce: Optional[int] = None    # CE streaming strike (equals strike when offset=0)
    strike_pe: Optional[int] = None    # PE streaming strike (equals strike when offset=0)
    brokerage_per_order: float = 1.0    # flat brokerage per trade (from session start config)
    strategy_interval_secs: int = 180   # candle interval for all strategies (180=3min, 300=5min)
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=3000))
    resume_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None


# Registry of active sessions
_sessions: dict[str, SimulationSession] = {}


def _upsert_session_to_db(session: SimulationSession) -> None:
    try:
        from app.services.db import get_dynamodb_resource
        table = get_dynamodb_resource().Table("Sessions")
        item: dict = {
            "session_id": session.session_id,
            "user_id": session.user_id,
            "symbol": session.symbol,
            "date": session.date,
            "start_time": session.start_time,
            "speed": Decimal(str(session.speed)),
            "state": session.state.value,
            "session_capital": Decimal(str(session.session_capital)),
            "instrument_type": session.instrument_type,
        }
        if session.instrument_type == "options":
            item["strike"] = session.strike
            item["expiry"] = session.expiry
            item["right"] = session.right
        table.put_item(Item=item)
    except Exception:
        logger.exception("DynamoDB write failed for session %s", session.session_id)


def get_session(session_id: str) -> Optional[SimulationSession]:
    return _sessions.get(session_id)


def create_session(
    symbol: str,
    date: str,
    start_time: str,
    speed: float,
    user_id: str = FIXED_USER_ID,
    instrument_type: str = "equity",
    strike: Optional[int] = None,
    expiry: Optional[str] = None,
    right: Optional[str] = None,
    strike_ce: Optional[int] = None,
    strike_pe: Optional[int] = None,
    brokerage_per_order: float = 1.0,
    strategy_interval_secs: int = 180,
) -> SimulationSession:
    from app.services import wallet_service
    session_id = str(uuid.uuid4())
    session_capital = wallet_service.get_balance(user_id, date)
    session = SimulationSession(
        session_id=session_id,
        symbol=symbol,
        date=date,
        start_time=start_time,
        speed=speed,
        user_id=user_id,
        session_capital=session_capital,
        instrument_type=instrument_type,
        strike=strike,
        expiry=expiry,
        right=right,
        strike_ce=strike_ce if strike_ce is not None else strike,
        strike_pe=strike_pe if strike_pe is not None else strike,
        brokerage_per_order=brokerage_per_order,
        strategy_interval_secs=strategy_interval_secs,
    )
    session.resume_event.set()  # not paused initially
    _sessions[session_id] = session
    _upsert_session_to_db(session)
    return session


def _emit_tick_and_check_orders(
    session: SimulationSession,
    tick: dict,
    tick_right: Optional[str],
) -> list[dict]:
    """Put one tick on the queue and return fill events for any triggered orders."""
    from app.services.order_service import check_orders
    from app.services.trading import record_trade

    try:
        session.queue.put_nowait(json.dumps(tick))
    except asyncio.QueueFull:
        logger.warning("Queue full, dropping tick for session %s at t=%s", session.session_id, tick.get("time"))

    current_time = tick["time"]
    current_price = tick["close"]
    filled = check_orders(
        session.session_id, current_price, current_time, session.date,
        tick_right=tick_right,
    )
    fill_events = []
    for order in filled:
        record_trade(
            session_id=session.session_id,
            side=order.side,
            price=order.filled_price,
            timestamp=order.filled_at,
            quantity=order.quantity,
            symbol=order.symbol,
            instrument_type=session.instrument_type,
            strike=session.strike,
            expiry=session.expiry,
            right=order.right,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
        )
        fill_events.append({
            "type": "order_filled",
            "order_id": order.order_id,
            "side": order.side.value,
            "quantity": order.quantity,
            "trigger_price": order.trigger_price,
            "filled_price": order.filled_price,
            "filled_at": order.filled_at,
        })

    # Strategy evaluation — fire-and-forget; never raises into the tick loop
    try:
        from app.services import strategy_service
        strategy_service.on_tick(session, tick, tick_right)
    except Exception as exc:
        logger.warning("strategy eval error for session %s: %s", session.session_id, exc)

    return fill_events


async def _run_session(session: SimulationSession) -> None:
    session.state = SimulationState.RUNNING

    start_event = {
        "type": "session_started",
        "session_id": session.session_id,
        "trading_date": session.date,
        "start_time": session.start_time,
    }
    await session.queue.put(json.dumps(start_event))

    try:
        # Dual-stream options (right=None): equity is the master clock; CE/PE strikes
        # can be updated mid-session when the user adds a new pane with a different OTM offset.
        if session.instrument_type == "options" and session.strike and session.expiry and session.right is None:
            from app.services.options_service import options_iter_ticks

            cur_ce_strike = session.strike_ce or session.strike
            cur_pe_strike = session.strike_pe or session.strike

            def _load_by_time(strike: int, right: str, start_str: str) -> dict:
                return {t["time"]: t for t in options_iter_ticks(
                    session.symbol, session.date, strike, session.expiry, right, start_str
                )}

            ce_by_time = _load_by_time(cur_ce_strike, "CE", session.start_time)
            pe_by_time = _load_by_time(cur_pe_strike, "PE", session.start_time)
            eq_ticks = list(iter_ticks(session.symbol, session.date, session.start_time))

            for eq_tick in eq_ticks:
                await session.resume_event.wait()
                if session.state == SimulationState.ENDED:
                    break

                ts = eq_tick["time"]
                ts_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S")

                new_ce = session.strike_ce or session.strike
                if new_ce != cur_ce_strike:
                    cur_ce_strike = new_ce
                    try:
                        ce_by_time = _load_by_time(cur_ce_strike, "CE", ts_str)
                    except Exception as exc:
                        logger.warning("Could not reload CE data for strike %s: %s", cur_ce_strike, exc)
                        ce_by_time = {}

                new_pe = session.strike_pe or session.strike
                if new_pe != cur_pe_strike:
                    cur_pe_strike = new_pe
                    try:
                        pe_by_time = _load_by_time(cur_pe_strike, "PE", ts_str)
                    except Exception as exc:
                        logger.warning("Could not reload PE data for strike %s: %s", cur_pe_strike, exc)
                        pe_by_time = {}

                session.current_time = str(ts)
                session.last_price = eq_tick["close"]

                fill_events = _emit_tick_and_check_orders(session, eq_tick, None)

                if ts in ce_by_time:
                    ce_tick = {**ce_by_time[ts], "right": "CE"}
                    session.last_price_ce = ce_tick["close"]
                    fill_events += _emit_tick_and_check_orders(session, ce_tick, "CE")

                if ts in pe_by_time:
                    pe_tick = {**pe_by_time[ts], "right": "PE"}
                    session.last_price_pe = pe_tick["close"]
                    fill_events += _emit_tick_and_check_orders(session, pe_tick, "PE")

                for fe in fill_events:
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        logger.warning("Queue full, dropping order_filled event for %s", fe.get("order_id"))

                await asyncio.sleep(session.speed)

        # Single-contract options (right provided — Sprint 3 compat)
        elif session.instrument_type == "options" and session.strike and session.expiry and session.right:
            from app.services.options_service import options_iter_ticks
            tick_iter = options_iter_ticks(
                session.symbol, session.date, session.strike,
                session.expiry, session.right, session.start_time,
            )
            for tick in tick_iter:
                await session.resume_event.wait()
                if session.state == SimulationState.ENDED:
                    break
                session.current_time = str(tick["time"])
                session.last_price = tick["close"]
                fill_events = _emit_tick_and_check_orders(session, tick, session.right)
                for fe in fill_events:
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        logger.warning("Queue full, dropping order_filled event for %s", fe["order_id"])
                await asyncio.sleep(session.speed)

        # Equity
        else:
            for tick in iter_ticks(session.symbol, session.date, session.start_time):
                await session.resume_event.wait()
                if session.state == SimulationState.ENDED:
                    break
                session.current_time = str(tick["time"])
                session.last_price = tick["close"]
                fill_events = _emit_tick_and_check_orders(session, tick, None)
                for fe in fill_events:
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        logger.warning("Queue full, dropping order_filled event for %s", fe["order_id"])
                await asyncio.sleep(session.speed)

    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("_run_session crashed for session %s", session.session_id)
    finally:
        session.state = SimulationState.ENDED
        end_event = {"type": "session_ended"}
        try:
            session.queue.put_nowait(json.dumps(end_event))
        except asyncio.QueueFull:
            pass


def start_session(session: SimulationSession) -> None:
    loop = asyncio.get_event_loop()
    session.task = loop.create_task(_run_session(session))


def pause_session(session: SimulationSession) -> None:
    if session.state == SimulationState.RUNNING:
        session.state = SimulationState.PAUSED
        session.resume_event.clear()


def resume_session(session: SimulationSession) -> None:
    if session.state == SimulationState.PAUSED:
        session.state = SimulationState.RUNNING
        session.resume_event.set()


def stop_session(session: SimulationSession) -> None:
    session.state = SimulationState.ENDED
    session.resume_event.set()  # unblock if paused
    if session.task and not session.task.done():
        session.task.cancel()
    _upsert_session_to_db(session)
    _sessions.pop(session.session_id, None)
    # Cancel and clean up any running strategies
    try:
        from app.services import strategy_service
        strategy_service.cancel_all(session.session_id)
        strategy_service.clear_session(session.session_id)
    except Exception as exc:
        logger.warning("Could not cancel strategies for session %s: %s", session.session_id, exc)
