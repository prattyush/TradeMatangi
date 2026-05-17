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
    session_type: str = "sim"           # "sim" (historical replay) or "paper" (live data)
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
            strike=session.strike,
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


def start_session(session: SimulationSession) -> None:
    loop = asyncio.get_running_loop()
    if session.session_type == "paper":
        session.task = loop.create_task(_run_paper_session(session))
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
    # Stop live streaming if this is a paper session
    if session.session_type == "paper":
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
