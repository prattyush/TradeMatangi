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
from typing import Any, Optional

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
    session_type: str = "sim"           # "sim", "paper", or "real"
    # Real trading: maps our order_id → Kotak order ID for Kotak-placed orders
    kotak_order_map: dict[str, str] = field(default_factory=dict)
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=3000))
    # paper_tick_queue: receives raw tick dicts from KiteBroadcaster / BreezeStreamManager
    paper_tick_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=1000))
    resume_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None
    stream_manager: Any = field(default=None, repr=False, compare=False)


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
            "session_type": session.session_type,
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
    session_type: str = "sim",
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
        session_type=session_type,
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
            strike=order.strike if order.strike is not None else session.strike,
            expiry=session.expiry,
            right=order.right,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
        )
        fill_events.append({
            "type": "order_filled",
            "order_id": order.order_id,
            "side": order.side.value,
            "quantity": order.quantity,
            "trigger_price": order.trigger_price,
            "filled_price": order.filled_price,
            "filled_at": order.filled_at,
            "right": order.right,
        })

    # Strategy evaluation — snapshot open orders before/after so strategy-placed
    # orders (e.g. AutoStop TARGET) are surfaced to the frontend via order_placed events.
    try:
        from app.services import strategy_service
        from app.services.order_service import get_open_orders
        before_ids = {o.order_id for o in get_open_orders(session.session_id)}
        strategy_service.on_tick(session, tick, tick_right)
        for new_order in get_open_orders(session.session_id):
            if new_order.order_id not in before_ids:
                fill_events.append({
                    "type": "order_placed",
                    "order_id": new_order.order_id,
                    "session_id": new_order.session_id,
                    "user_id": new_order.user_id,
                    "symbol": new_order.symbol,
                    "side": new_order.side.value,
                    "order_type": new_order.order_type.value,
                    "quantity": new_order.quantity,
                    "trigger_price": new_order.trigger_price,
                    "limit_price": new_order.limit_price,
                    "status": new_order.status.value,
                    "created_at": new_order.created_at,
                    "filled_at": new_order.filled_at,
                    "filled_price": new_order.filled_price,
                    "is_stoploss": new_order.is_stoploss,
                    "right": new_order.right,
                    "strike": new_order.strike,
                })
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


def _build_breeze_instruments(session: SimulationSession) -> list[dict]:
    """Build a list of Breeze feed subscription dicts for a paper session."""
    from app.config import SUPPORTED_SYMBOLS
    sym_info = SUPPORTED_SYMBOLS.get(session.symbol, {})
    instruments = [{
        "exchange_code": sym_info.get("exchange_code", "NSE"),
        "stock_code": sym_info.get("breeze_stock_code", session.symbol),
        "product_type": sym_info.get("product_type", "cash"),
    }]
    if session.instrument_type == "options" and session.expiry:
        opts_exchange = sym_info.get("options_exchange_code", "NFO")
        ce_strike = session.strike_ce or session.strike
        pe_strike = session.strike_pe or session.strike
        expiry_kite = f"{session.expiry}T06:00:00.000Z"
        if session.right in (None, "CE") and ce_strike:
            instruments.append({
                "exchange_code": opts_exchange,
                "stock_code": sym_info.get("breeze_stock_code", session.symbol),
                "product_type": "options",
                "expiry_date": expiry_kite,
                "strike_price": str(ce_strike),
                "right": "call",
            })
        if session.right in (None, "PE") and pe_strike:
            instruments.append({
                "exchange_code": opts_exchange,
                "stock_code": sym_info.get("breeze_stock_code", session.symbol),
                "product_type": "options",
                "expiry_date": expiry_kite,
                "strike_price": str(pe_strike),
                "right": "put",
            })
    return instruments


def _kite_1min_gap_ticks(symbol: str, date: str, after_ts: int) -> list[dict]:
    """
    Return Kite 1-min equity ticks for timestamps strictly after `after_ts`
    (IST-as-UTC Unix). Non-fatal: returns [] on any error.
    """
    try:
        import pandas as pd
        from app.services.kite_service import fetch_kite_1min
        df = fetch_kite_1min(symbol, date)
        if df.empty:
            return []
        if df.index.tzinfo is None:
            df.index = df.index.tz_localize("UTC")
        cutoff = pd.Timestamp(after_ts, unit="s", tz="UTC")
        gap = df[df.index > cutoff]
        return [
            {
                "type": "tick",
                "time": int(ts.timestamp()),
                "open":  round(float(row["open"]),  2),
                "high":  round(float(row["high"]),  2),
                "low":   round(float(row["low"]),   2),
                "close": round(float(row["close"]), 2),
            }
            for ts, row in gap.iterrows()
        ]
    except Exception as exc:
        logger.warning("Kite 1-min equity gap-fill failed for %s %s: %s", symbol, date, exc)
        return []


def _kite_1min_gap_options_ticks(
    symbol: str, date: str, strike: int, expiry: str, right: str, after_ts: int
) -> list[dict]:
    """
    Return Kite 1-min options ticks for timestamps strictly after `after_ts`.
    Non-fatal: returns [] on any error.
    """
    try:
        import pandas as pd
        from app.services.kite_service import fetch_kite_1min_options
        df = fetch_kite_1min_options(symbol, date, strike, expiry, right)
        if df.empty:
            return []
        if df.index.tzinfo is None:
            df.index = df.index.tz_localize("UTC")
        cutoff = pd.Timestamp(after_ts, unit="s", tz="UTC")
        gap = df[df.index > cutoff]
        return [
            {
                "type": "tick",
                "time": int(ts.timestamp()),
                "open":  round(float(row["open"]),  2),
                "high":  round(float(row["high"]),  2),
                "low":   round(float(row["low"]),   2),
                "close": round(float(row["close"]), 2),
                "right": right,
            }
            for ts, row in gap.iterrows()
        ]
    except Exception as exc:
        logger.warning("Kite 1-min options gap-fill failed for %s %s %s: %s", symbol, date, right, exc)
        return []


async def _run_paper_session(session: SimulationSession) -> None:
    """
    Paper trading session loop.

    Phase 1 — Fast pre-session replay:
      Fetch today's Breeze historical data (up to last available second), then
      replay all ticks at near-instant speed so the chart is populated on connect.

    Phase 2 — Live streaming:
      Register with KiteBroadcaster (or fall back to BreezeStreamManager).
      The broadcaster pushes 1-second OHLC dicts into session.paper_tick_queue.
      This loop reads those dicts, evaluates orders/strategies, and puts ticks
      on session.queue for SSE delivery — exactly as _run_session does.
    """
    session.state = SimulationState.RUNNING

    start_event = {
        "type": "session_started",
        "session_id": session.session_id,
        "trading_date": session.date,
        "start_time": session.start_time,
    }
    await session.queue.put(json.dumps(start_event))

    try:
        # ── Phase 1: fast-replay historical data for today ────────────────────
        logger.info("Paper session %s: Phase 1 — fetching today's data for %s %s",
                    session.session_id, session.symbol, session.date)
        try:
            from app.services.broker_service import fetch_historical
            fetch_historical(session.symbol, session.date)
            logger.info("Paper session %s: Phase 1 — equity data ready", session.session_id)
        except Exception as exc:
            logger.warning("Paper session %s: could not pre-fetch today's data: %s", session.session_id, exc)

        # Track the last Breeze tick timestamp so we know where the gap starts.
        _last_breeze_ts: int = 0

        # Dual-stream options pre-replay
        if session.instrument_type == "options" and session.strike and session.expiry and session.right is None:
            from app.services.options_service import options_iter_ticks
            ce_strike = session.strike_ce or session.strike
            pe_strike = session.strike_pe or session.strike
            logger.info("Paper session %s: Phase 1 — loading CE/PE tick dicts (strike CE=%s PE=%s expiry=%s)",
                        session.session_id, ce_strike, pe_strike, session.expiry)
            try:
                ce_by_time = {t["time"]: t for t in options_iter_ticks(
                    session.symbol, session.date, ce_strike, session.expiry, "CE", session.start_time
                )}
                pe_by_time = {t["time"]: t for t in options_iter_ticks(
                    session.symbol, session.date, pe_strike, session.expiry, "PE", session.start_time
                )}
            except Exception as exc:
                logger.error("Paper session %s: Phase 1 — options tick load failed: %s", session.session_id, exc)
                ce_by_time = {}
                pe_by_time = {}
            logger.info("Paper session %s: Phase 1 — CE ticks=%d PE ticks=%d",
                        session.session_id, len(ce_by_time), len(pe_by_time))
            try:
                for eq_tick in iter_ticks(session.symbol, session.date, session.start_time):
                    if session.state == SimulationState.ENDED:
                        break
                    session.last_price = eq_tick["close"]
                    ts = eq_tick["time"]
                    _last_breeze_ts = ts
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
                            pass
                    await asyncio.sleep(0.001)
            except Exception as exc:
                logger.warning("Paper session %s: Phase 1 options pre-replay failed: %s", session.session_id, exc)

            # Kite 1-min gap-fill for the period between last Breeze data and now
            if _last_breeze_ts > 0 and session.state != SimulationState.ENDED:
                eq_gap = _kite_1min_gap_ticks(session.symbol, session.date, _last_breeze_ts)
                ce_gap = _kite_1min_gap_options_ticks(session.symbol, session.date, ce_strike, session.expiry, "CE", _last_breeze_ts)
                pe_gap = _kite_1min_gap_options_ticks(session.symbol, session.date, pe_strike, session.expiry, "PE", _last_breeze_ts)
                logger.info("Paper session %s: Kite 1-min gap-fill — eq=%d CE=%d PE=%d",
                            session.session_id, len(eq_gap), len(ce_gap), len(pe_gap))
                for tick in eq_gap:
                    if session.state == SimulationState.ENDED: break
                    session.last_price = tick["close"]
                    session.current_time = str(tick["time"])
                    _last_breeze_ts = tick["time"]
                    for fe in _emit_tick_and_check_orders(session, tick, None):
                        try: session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull: pass
                    await asyncio.sleep(0.001)
                for tick in ce_gap:
                    if session.state == SimulationState.ENDED: break
                    session.last_price_ce = tick["close"]
                    for fe in _emit_tick_and_check_orders(session, tick, "CE"):
                        try: session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull: pass
                    await asyncio.sleep(0.001)
                for tick in pe_gap:
                    if session.state == SimulationState.ENDED: break
                    session.last_price_pe = tick["close"]
                    for fe in _emit_tick_and_check_orders(session, tick, "PE"):
                        try: session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull: pass
                    await asyncio.sleep(0.001)

        elif session.instrument_type == "options" and session.strike and session.expiry and session.right:
            from app.services.options_service import options_iter_ticks
            try:
                for tick in options_iter_ticks(
                    session.symbol, session.date, session.strike,
                    session.expiry, session.right, session.start_time,
                ):
                    if session.state == SimulationState.ENDED:
                        break
                    session.last_price = tick["close"]
                    _last_breeze_ts = tick["time"]
                    fill_events = _emit_tick_and_check_orders(session, tick, session.right)
                    for fe in fill_events:
                        try:
                            session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull:
                            pass
                    await asyncio.sleep(0.001)
            except Exception as exc:
                logger.warning("Paper session %s: Phase 1 single-right pre-replay failed: %s", session.session_id, exc)

            # Kite 1-min equity gap-fill (single-right options; equity not replayed in this branch)
            if _last_breeze_ts > 0 and session.state != SimulationState.ENDED:
                for tick in _kite_1min_gap_ticks(session.symbol, session.date, _last_breeze_ts):
                    if session.state == SimulationState.ENDED: break
                    session.last_price = tick["close"]
                    session.current_time = str(tick["time"])
                    for fe in _emit_tick_and_check_orders(session, tick, None):
                        try: session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull: pass
                    await asyncio.sleep(0.001)

        else:
            pre_replay_count = 0
            logger.info("Paper session %s: Phase 1 — equity pre-replay from %s",
                        session.session_id, session.start_time)
            try:
                for tick in iter_ticks(session.symbol, session.date, session.start_time):
                    if session.state == SimulationState.ENDED:
                        break
                    session.last_price = tick["close"]
                    session.current_time = str(tick["time"])
                    _last_breeze_ts = tick["time"]
                    fill_events = _emit_tick_and_check_orders(session, tick, None)
                    for fe in fill_events:
                        try:
                            session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull:
                            pass
                    await asyncio.sleep(0.001)
                    pre_replay_count += 1
            except Exception as exc:
                logger.warning("Paper session %s: Phase 1 pre-replay failed: %s", session.session_id, exc)
            logger.info("Paper session %s: Phase 1 — pre-replay done, %d ticks sent",
                        session.session_id, pre_replay_count)

            # Kite 1-min gap-fill for equity
            if _last_breeze_ts > 0 and session.state != SimulationState.ENDED:
                gap_ticks = _kite_1min_gap_ticks(session.symbol, session.date, _last_breeze_ts)
                if gap_ticks:
                    logger.info("Paper session %s: Kite 1-min equity gap-fill — %d ticks",
                                session.session_id, len(gap_ticks))
                for tick in gap_ticks:
                    if session.state == SimulationState.ENDED: break
                    session.last_price = tick["close"]
                    session.current_time = str(tick["time"])
                    for fe in _emit_tick_and_check_orders(session, tick, None):
                        try: session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull: pass
                    await asyncio.sleep(0.001)

        if session.state == SimulationState.ENDED:
            return

        # ── Phase 2: live streaming ────────────────────────────────────────────
        loop = asyncio.get_running_loop()
        using_kite = False

        try:
            from app.services import kite_service
            tokens: list[int] = []
            rights: list[str | None] = []

            eq_exchange, eq_token = kite_service.fetch_equity_instrument_token(session.symbol)
            tokens.append(eq_token)
            rights.append(None)

            if session.instrument_type == "options" and session.expiry:
                ce_strike = session.strike_ce or session.strike
                pe_strike = session.strike_pe or session.strike
                if session.right in (None, "CE") and ce_strike:
                    ce_token = kite_service.fetch_options_instrument_token(
                        session.symbol, session.expiry, ce_strike, "CE"
                    )
                    tokens.append(ce_token)
                    rights.append("CE")
                if session.right in (None, "PE") and pe_strike:
                    pe_token = kite_service.fetch_options_instrument_token(
                        session.symbol, session.expiry, pe_strike, "PE"
                    )
                    tokens.append(pe_token)
                    rights.append("PE")

            kite_service.get_broadcaster().register(
                session.session_id, tokens, rights,
                session.paper_tick_queue, loop,
            )
            using_kite = True
            logger.info("Paper session %s: Kite live streaming started (%d tokens)", session.session_id, len(tokens))

        except (Exception,) as exc:
            # Kite unavailable — emit error and try Breeze fallback
            err_msg = f"Kite unavailable ({exc}). Switching to ICICIDirect for live data."
            logger.warning("Paper session %s: %s", session.session_id, err_msg)
            error_event = {"type": "broker_error", "message": err_msg}
            try:
                session.queue.put_nowait(json.dumps(error_event))
            except asyncio.QueueFull:
                pass

            try:
                from app.services.kite_service import BreezeStreamManager
                instruments = _build_breeze_instruments(session)
                manager = BreezeStreamManager()
                manager.start(session.paper_tick_queue, loop, instruments)
                session.stream_manager = manager
                logger.info("Paper session %s: Breeze fallback streaming started", session.session_id)
            except Exception as be:
                both_err = {"type": "broker_error", "message": f"Both Kite and ICICIDirect unavailable. Cannot stream live data: {be}"}
                try:
                    session.queue.put_nowait(json.dumps(both_err))
                except asyncio.QueueFull:
                    pass
                logger.error("Paper session %s: all streaming sources failed: %s", session.session_id, be)
                return

        # ── Phase 3: consume live ticks indefinitely ──────────────────────────
        logger.info("Paper session %s: Phase 3 — waiting for live ticks", session.session_id)
        _phase3_tick_count = 0
        while session.state != SimulationState.ENDED:
            await session.resume_event.wait()
            if session.state == SimulationState.ENDED:
                break

            try:
                payload = await asyncio.wait_for(session.paper_tick_queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                logger.debug("Paper session %s: Phase 3 — 30s timeout waiting for tick (market may be closed)", session.session_id)
                continue  # normal during market close / weekend — no data, keep waiting

            _phase3_tick_count += 1
            if _phase3_tick_count <= 3 or _phase3_tick_count % 60 == 0:
                logger.info("Paper session %s: Phase 3 tick #%d received: time=%s close=%s right=%s",
                            session.session_id, _phase3_tick_count,
                            payload.get("time"), payload.get("close"), payload.get("right"))

            tick_right: str | None = payload.get("right")
            tick_type = payload.get("type", "tick")
            if tick_type == "broker_error":
                # Forward connection-lost / reconnect-failed messages to the SSE stream.
                error_event = {"type": "broker_error", "message": payload.get("message", "Kite connection lost")}
                try:
                    session.queue.put_nowait(json.dumps(error_event))
                except asyncio.QueueFull:
                    pass
                continue
            if tick_type != "tick":
                continue

            if tick_right == "CE":
                session.last_price_ce = payload["close"]
            elif tick_right == "PE":
                session.last_price_pe = payload["close"]
            else:
                session.last_price = payload["close"]
                session.current_time = str(payload["time"])

            tick_for_emit = {**payload}
            if tick_right and "right" not in tick_for_emit:
                tick_for_emit["right"] = tick_right

            fill_events = _emit_tick_and_check_orders(session, tick_for_emit, tick_right)
            for fe in fill_events:
                try:
                    session.queue.put_nowait(json.dumps(fe))
                except asyncio.QueueFull:
                    logger.warning("Queue full dropping fill event for session %s", session.session_id)

    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("_run_paper_session crashed for session %s", session.session_id)
    finally:
        session.state = SimulationState.ENDED
        end_event = {"type": "session_ended"}
        try:
            session.queue.put_nowait(json.dumps(end_event))
        except asyncio.QueueFull:
            pass


async def _run_real_session(session: SimulationSession) -> None:
    """
    Real trading session: uses the same Kite tick-stream infrastructure as
    paper trading for chart data, but order execution goes to Kotak Neo.
    The wallet is pre-synced from Kotak at session start (handled in the router).
    Limit/Target triggered fills are forwarded to Kotak after local detection.
    """
    session.state = SimulationState.RUNNING
    loop = asyncio.get_running_loop()

    start_event = {
        "type": "session_started",
        "session_id": session.session_id,
        "trading_date": session.date,
        "start_time": session.start_time,
    }
    await session.queue.put(json.dumps(start_event))

    try:
        # Phase 1: fast-replay today's historical data (same as paper)
        logger.info("Real session %s: Phase 1 — fetching today's data for %s",
                    session.session_id, session.symbol)
        try:
            from app.services.broker_service import fetch_historical
            fetch_historical(session.symbol, session.date)
        except Exception as exc:
            logger.warning("Real session %s: could not pre-fetch today's data: %s", session.session_id, exc)

        _last_breeze_ts: int = 0
        try:
            from app.services.data_loader import iter_ticks
            for tick in iter_ticks(session.symbol, session.date, session.start_time):
                if session.state == SimulationState.ENDED:
                    break
                session.last_price = tick["close"]
                session.current_time = str(tick["time"])
                _last_breeze_ts = tick["time"]
                fill_events = _emit_tick_and_check_orders_real(session, tick, None, loop)
                for fe in fill_events:
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        pass
                await asyncio.sleep(0.001)
        except Exception as exc:
            logger.warning("Real session %s: Phase 1 pre-replay failed: %s", session.session_id, exc)

        # Kite 1-min gap fill
        if _last_breeze_ts > 0 and session.state != SimulationState.ENDED:
            for tick in _kite_1min_gap_ticks(session.symbol, session.date, _last_breeze_ts):
                if session.state == SimulationState.ENDED:
                    break
                session.last_price = tick["close"]
                session.current_time = str(tick["time"])
                for fe in _emit_tick_and_check_orders_real(session, tick, None, loop):
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        pass
                await asyncio.sleep(0.001)

        if session.state == SimulationState.ENDED:
            return

        # Phase 2: Kite live streaming (same as paper)
        try:
            from app.services import kite_service
            eq_exchange, eq_token = kite_service.fetch_equity_instrument_token(session.symbol)
            kite_service.get_broadcaster().register(
                session.session_id, [eq_token], [None],
                session.paper_tick_queue, loop,
            )
            logger.info("Real session %s: Kite live streaming started", session.session_id)
        except Exception as exc:
            logger.warning("Real session %s: Kite unavailable — %s", session.session_id, exc)
            error_event = {"type": "broker_error", "message": f"Kite unavailable: {exc}"}
            try:
                session.queue.put_nowait(json.dumps(error_event))
            except asyncio.QueueFull:
                pass

        # Phase 3: consume live ticks
        logger.info("Real session %s: Phase 3 — consuming live ticks", session.session_id)
        while session.state != SimulationState.ENDED:
            await session.resume_event.wait()
            if session.state == SimulationState.ENDED:
                break
            try:
                payload = await asyncio.wait_for(session.paper_tick_queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                continue

            tick_type = payload.get("type", "tick")
            if tick_type == "broker_error":
                error_event = {"type": "broker_error", "message": payload.get("message", "")}
                try:
                    session.queue.put_nowait(json.dumps(error_event))
                except asyncio.QueueFull:
                    pass
                continue
            if tick_type != "tick":
                continue

            session.last_price = payload["close"]
            session.current_time = str(payload["time"])

            fill_events = _emit_tick_and_check_orders_real(session, payload, None, loop)
            for fe in fill_events:
                try:
                    session.queue.put_nowait(json.dumps(fe))
                except asyncio.QueueFull:
                    pass

    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("_run_real_session crashed for session %s", session.session_id)
    finally:
        session.state = SimulationState.ENDED
        end_event = {"type": "session_ended"}
        try:
            session.queue.put_nowait(json.dumps(end_event))
        except asyncio.QueueFull:
            pass


def _register_kotak_sl_for_order(session: SimulationSession, order: Any, loop: Any) -> None:
    """
    Place a locally-created SL order on Kotak and register fill/reject callbacks.
    Called by strategies in real sessions that need to place a broker-side SL immediately.
    """
    from app.services.kotak_service import get_service as get_kotak, KotakError
    from app.services.trading import record_trade
    from app.services import wallet_service, order_service
    from app.models.schemas import OrderStatus
    from app.config import KOTAK_SLIPPAGE_PCT

    kotak_svc = get_kotak()
    trigger = order.trigger_price
    if order.side.value == "BUY":
        kotak_limit = round(trigger * (1 + KOTAK_SLIPPAGE_PCT), 2)
    else:
        kotak_limit = round(trigger * (1 - KOTAK_SLIPPAGE_PCT), 2)

    if order.right and session.instrument_type == "options":
        kotak_order_id = kotak_svc.place_options_sl_order(
            symbol=session.symbol,
            right=order.right,
            strike=order.strike if order.strike is not None else session.strike,
            expiry=session.expiry,
            side="B" if order.side.value == "BUY" else "S",
            qty=order.quantity,
            trigger_price=trigger,
            limit_price=kotak_limit,
        )
    else:
        kotak_order_id = kotak_svc.place_sl_order(
            symbol=session.symbol,
            side="B" if order.side.value == "BUY" else "S",
            qty=order.quantity,
            trigger_price=trigger,
            limit_price=kotak_limit,
        )

    order.kotak_order_id = kotak_order_id
    session.kotak_order_map[order.order_id] = kotak_order_id
    order_service._write_order_to_db(order)

    def _fill_cb(k_id: str, fill_side: str, fill_qty: int, fill_price: float):
        o = order_service.get_order(session.session_id, order.order_id)
        if o is None:
            return
        o.status = OrderStatus.FILLED
        o.filled_price = fill_price
        o.filled_at = int(session.current_time) if session.current_time else 0
        record_trade(
            session_id=session.session_id,
            side=o.side,
            price=fill_price,
            timestamp=o.filled_at,
            quantity=fill_qty,
            symbol=o.symbol,
            instrument_type=session.instrument_type,
            strike=o.strike if o.strike is not None else session.strike,
            expiry=session.expiry,
            right=o.right,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
        )
        if o.side.value == "SELL":
            wallet_service.credit(session.user_id, round(fill_price * fill_qty, 2), session.date)
        evt = {
            "type": "order_filled",
            "order_id": order.order_id,
            "side": o.side.value,
            "quantity": fill_qty,
            "trigger_price": o.trigger_price,
            "filled_price": fill_price,
            "filled_at": o.filled_at,
            "right": o.right,
        }
        try:
            session.queue.put_nowait(json.dumps(evt))
        except asyncio.QueueFull:
            pass

    def _reject_cb(k_id: str, reason: str):
        o = order_service.get_order(session.session_id, order.order_id)
        if o is None:
            return
        logger.warning("Kotak rejected strategy SL %s: %s", order.order_id, reason)
        o.status = OrderStatus.CANCELLED
        order_service._write_order_to_db(o)
        cancel_event = {"type": "order_cancelled", "order_id": order.order_id}
        error_event = {"type": "broker_error", "message": f"Kotak rejected SL: {reason}"}
        for evt in (cancel_event, error_event):
            try:
                session.queue.put_nowait(json.dumps(evt))
            except asyncio.QueueFull:
                pass

    kotak_svc.register_fill_callback(kotak_order_id, _fill_cb, loop)
    kotak_svc.register_reject_callback(kotak_order_id, _reject_cb, loop)
    logger.info(
        "Strategy SL order %s placed on Kotak (kotak_id=%s trigger=%.2f)",
        order.order_id, kotak_order_id, trigger,
    )


def _emit_tick_and_check_orders_real(
    session: SimulationSession,
    tick: dict,
    tick_right: Optional[str],
    loop: Any,
) -> list[dict]:
    """
    Like _emit_tick_and_check_orders but for real sessions:
    when a LIMIT or TARGET order is triggered locally, forward it to Kotak
    as a limit order instead of directly marking it filled.
    Fills from Kotak arrive asynchronously via the order-feed WebSocket.
    """
    from app.services.order_service import check_orders
    from app.services.trading import record_trade
    from app.services.kotak_service import get_service as get_kotak, KotakError
    from app.config import KOTAK_SLIPPAGE_PCT

    try:
        session.queue.put_nowait(json.dumps(tick))
    except asyncio.QueueFull:
        logger.warning("Queue full, dropping tick for real session %s", session.session_id)

    current_time = tick["time"]
    current_price = tick["close"]
    triggered = check_orders(
        session.session_id, current_price, current_time, session.date,
        tick_right=tick_right,
    )

    fill_events: list[dict] = []
    kotak_svc = get_kotak()

    for order in triggered:
        # SL orders placed on Kotak at creation time; fill comes via WebSocket.
        # For LIMIT/TARGET, forward to Kotak now as a market-ish limit order.
        if order.is_stoploss or (order.kotak_order_id and order.kotak_order_id in session.kotak_order_map.values()):
            # Already placed on Kotak — the fill will arrive via order-feed WebSocket.
            continue

        # Forward triggered LIMIT/TARGET to Kotak as limit order
        side_code = "B" if order.side.value == "BUY" else "S"
        price = order.filled_price or current_price
        if order.side.value == "BUY":
            kotak_price = round(price * (1 + KOTAK_SLIPPAGE_PCT), 2)
        else:
            kotak_price = round(price * (1 - KOTAK_SLIPPAGE_PCT), 2)

        try:
            if order.right and session.instrument_type == "options":
                kotak_order_id = kotak_svc.place_options_limit_order(
                    symbol=session.symbol,
                    right=order.right,
                    strike=order.strike if order.strike is not None else session.strike,
                    expiry=session.expiry,
                    side=side_code,
                    qty=order.quantity,
                    price=kotak_price,
                )
            else:
                kotak_order_id = kotak_svc.place_limit_order(
                    symbol=session.symbol,
                    side=side_code,
                    qty=order.quantity,
                    price=kotak_price,
                )
            session.kotak_order_map[order.order_id] = kotak_order_id
            logger.info(
                "Real session %s: forwarded triggered %s order %s to Kotak (kotak_id=%s price=%.2f)",
                session.session_id, order.order_type.value, order.order_id, kotak_order_id, kotak_price,
            )

            def _make_fill_cb(ord_id: str, sess: SimulationSession):
                def on_kotak_fill(kotak_id: str, fill_side: str, fill_qty: int, fill_price: float):
                    from app.services.order_service import get_order
                    from app.services import wallet_service
                    o = get_order(sess.session_id, ord_id)
                    if o is None:
                        return
                    record_trade(
                        session_id=sess.session_id,
                        side=o.side,
                        price=fill_price,
                        timestamp=int(sess.current_time) if sess.current_time else 0,
                        quantity=fill_qty,
                        symbol=o.symbol,
                        instrument_type=sess.instrument_type,
                        strike=o.strike if o.strike is not None else sess.strike,
                        expiry=sess.expiry,
                        right=o.right,
                        brokerage_per_order=sess.brokerage_per_order,
                        user_id=sess.user_id,
                        session_type=sess.session_type,
                    )
                    if o.side.value == "SELL":
                        wallet_service.credit(sess.user_id, fill_price * fill_qty, sess.date)
                    else:
                        wallet_service.debit(sess.user_id, fill_price * fill_qty, sess.date)
                    evt = {
                        "type": "order_filled",
                        "order_id": ord_id,
                        "side": o.side.value,
                        "quantity": fill_qty,
                        "trigger_price": o.trigger_price,
                        "filled_price": fill_price,
                        "filled_at": int(sess.current_time) if sess.current_time else 0,
                        "right": o.right,
                    }
                    try:
                        sess.queue.put_nowait(json.dumps(evt))
                    except asyncio.QueueFull:
                        pass
                return on_kotak_fill

            kotak_svc.register_fill_callback(kotak_order_id, _make_fill_cb(order.order_id, session), loop)

            def _make_reject_cb(ord_id: str, sess: SimulationSession):
                def on_reject(kotak_id: str, reason: str):
                    from app.services.order_service import get_order, _write_order_to_db
                    from app.models.schemas import OrderStatus
                    from app.services import wallet_service
                    o = get_order(sess.session_id, ord_id)
                    if o is None:
                        return
                    logger.warning(
                        "Real session %s: Kotak rejected order %s: %s",
                        sess.session_id, ord_id, reason,
                    )
                    o.status = OrderStatus.CANCELLED
                    # Credit back the upfront wallet reservation for BUY orders
                    if o.side.value == "BUY" and o.reserved_amount > 0:
                        wallet_service.credit(o.user_id, o.reserved_amount, sess.date)
                    _write_order_to_db(o)
                    cancel_event = {"type": "order_cancelled", "order_id": ord_id}
                    error_event = {"type": "broker_error", "message": f"Kotak rejected order: {reason}"}
                    for evt in (cancel_event, error_event):
                        try:
                            sess.queue.put_nowait(json.dumps(evt))
                        except asyncio.QueueFull:
                            pass
                return on_reject

            kotak_svc.register_reject_callback(kotak_order_id, _make_reject_cb(order.order_id, session), loop)

        except KotakError as exc:
            logger.error(
                "Real session %s: failed to forward order %s to Kotak: %s",
                session.session_id, order.order_id, exc,
            )
            # Revert the order — check_orders already marked it FILLED, undo that.
            from app.models.schemas import OrderStatus
            order.status = OrderStatus.CANCELLED
            # Credit back reserved funds for BUY orders so wallet stays consistent.
            if order.side.value == "BUY" and order.reserved_amount > 0:
                from app.services import wallet_service
                wallet_service.credit(order.user_id, order.reserved_amount, session.date)
            # Notify frontend: remove from open orders, show error banner.
            cancel_event = {"type": "order_cancelled", "order_id": order.order_id}
            error_event = {"type": "broker_error", "message": f"Kotak order failed: {exc}"}
            for evt in (cancel_event, error_event):
                try:
                    session.queue.put_nowait(json.dumps(evt))
                except asyncio.QueueFull:
                    pass
            # Do NOT record the trade — wait for actual Kotak fill confirmation.

    # Strategy evaluation — pass loop so real-session strategies can place Kotak orders
    try:
        from app.services import strategy_service
        from app.services.order_service import get_open_orders
        before_ids = {o.order_id for o in get_open_orders(session.session_id)}
        strategy_service.on_tick(session, tick, tick_right, loop=loop)
        for new_order in get_open_orders(session.session_id):
            if new_order.order_id not in before_ids:
                fill_events.append({
                    "type": "order_placed",
                    "order_id": new_order.order_id,
                    "session_id": new_order.session_id,
                    "user_id": new_order.user_id,
                    "symbol": new_order.symbol,
                    "side": new_order.side.value,
                    "order_type": new_order.order_type.value,
                    "quantity": new_order.quantity,
                    "trigger_price": new_order.trigger_price,
                    "limit_price": new_order.limit_price,
                    "status": new_order.status.value,
                    "created_at": new_order.created_at,
                    "filled_at": new_order.filled_at,
                    "filled_price": new_order.filled_price,
                    "is_stoploss": new_order.is_stoploss,
                    "right": new_order.right,
                    "strike": new_order.strike,
                })
    except Exception as exc:
        logger.warning("strategy eval error for real session %s: %s", session.session_id, exc)

    return fill_events


def start_session(session: SimulationSession) -> None:
    loop = asyncio.get_running_loop()
    if session.session_type == "paper":
        session.task = loop.create_task(_run_paper_session(session))
    elif session.session_type == "real":
        session.task = loop.create_task(_run_real_session(session))
    else:
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
    # Stop live streaming for paper and real sessions
    if session.session_type in ("paper", "real"):
        if session.stream_manager is not None:
            # BreezeStreamManager fallback
            try:
                session.stream_manager.stop()
            except Exception as exc:
                logger.warning("BreezeStreamManager stop error for %s: %s", session.session_id, exc)
        else:
            # Kite broadcaster — unregister this session
            try:
                from app.services.kite_service import get_broadcaster
                get_broadcaster().unregister(session.session_id)
            except Exception as exc:
                logger.warning("Kite unregister error for %s: %s", session.session_id, exc)
    # Cancel and clean up any running strategies
    try:
        from app.services import strategy_service
        strategy_service.cancel_all(session.session_id)
        strategy_service.clear_session(session.session_id)
    except Exception as exc:
        logger.warning("Could not cancel strategies for session %s: %s", session.session_id, exc)
