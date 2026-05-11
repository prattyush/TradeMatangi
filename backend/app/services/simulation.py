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
    state: SimulationState = SimulationState.IDLE
    current_time: Optional[str] = None
    last_price: float = 0.0
    session_capital: float = 0.0  # wallet balance snapshotted at session start
    instrument_type: str = "equity"   # "equity" or "options"
    strike: Optional[int] = None       # options only
    expiry: Optional[str] = None       # options only (YYYY-MM-DD)
    right: Optional[str] = None        # options only ("CE" or "PE")
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=500))
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
            "user_id": FIXED_USER_ID,
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
    instrument_type: str = "equity",
    strike: Optional[int] = None,
    expiry: Optional[str] = None,
    right: Optional[str] = None,
) -> SimulationSession:
    from app.services import wallet_service
    session_id = str(uuid.uuid4())
    session_capital = wallet_service.get_balance(FIXED_USER_ID, date)
    session = SimulationSession(
        session_id=session_id,
        symbol=symbol,
        date=date,
        start_time=start_time,
        speed=speed,
        session_capital=session_capital,
        instrument_type=instrument_type,
        strike=strike,
        expiry=expiry,
        right=right,
    )
    session.resume_event.set()  # not paused initially
    _sessions[session_id] = session
    _upsert_session_to_db(session)
    return session


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
        if session.instrument_type == "options" and session.strike and session.expiry and session.right:
            from app.services.options_service import options_iter_ticks
            tick_iter = options_iter_ticks(
                session.symbol, session.date, session.strike,
                session.expiry, session.right, session.start_time,
            )
        else:
            tick_iter = iter_ticks(session.symbol, session.date, session.start_time)

        for tick in tick_iter:
            # Check for pause
            await session.resume_event.wait()

            if session.state == SimulationState.ENDED:
                break

            current_time = tick["time"]
            current_price = tick["close"]
            session.current_time = str(current_time)
            session.last_price = current_price
            await session.queue.put(json.dumps(tick))

            # Check and emit filled orders; record each fill as a trade
            from app.services.order_service import check_orders
            from app.services.trading import record_trade
            filled = check_orders(session.session_id, current_price, current_time, session.date)
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
                    right=session.right,
                )
                fill_event = {
                    "type": "order_filled",
                    "order_id": order.order_id,
                    "side": order.side.value,
                    "quantity": order.quantity,
                    "trigger_price": order.trigger_price,
                    "filled_price": order.filled_price,
                    "filled_at": order.filled_at,
                }
                try:
                    session.queue.put_nowait(json.dumps(fill_event))
                except asyncio.QueueFull:
                    logger.warning("Queue full, dropping order_filled event for %s", order.order_id)

            await asyncio.sleep(session.speed)

    except asyncio.CancelledError:
        pass
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
