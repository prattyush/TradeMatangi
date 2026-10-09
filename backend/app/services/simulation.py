"""
Simulation engine: replays second-level OHLC data asynchronously.
One asyncio Task per session; ticks flow through a ring-buffer queue.
Supports pause/resume via asyncio.Event and speed multiplier.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from app.models.schemas import SimulationState
from app.services.data_loader import iter_ticks
from app.config import FIXED_USER_ID

logger = logging.getLogger(__name__)


def _json_decimal(value: object) -> int | float:
    """Encode DynamoDB numbers in tick events without losing integer fields."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


# ── Ring-buffer async queue ───────────────────────────────────────────────────

class RingQueue:
    """
    Async ring buffer that drops the *oldest* event when full (unlike
    asyncio.Queue which drops the *newest*).  This keeps the most recent
    ticks available for an SSE client that reconnects after being idle.
    """

    def __init__(self, maxsize: int = 12000) -> None:
        self._dq: deque = deque(maxlen=maxsize)
        self._event = asyncio.Event()
        self._closed = False
        self._dropped: int = 0
        self._maxsize = maxsize

    @property
    def maxsize(self) -> int:
        return self._maxsize

    def full(self) -> bool:
        return len(self._dq) >= self._maxsize

    def put_nowait(self, item: str) -> None:
        """Push an item; oldest is silently dropped when the buffer is full."""
        if self._closed:
            return
        was_empty = len(self._dq) == 0
        if len(self._dq) == self._maxsize:
            self._dropped += 1
            if self._dropped % 100 == 1:
                logger.warning(
                    "RingQueue dropped %d events (maxsize=%d)",
                    self._dropped, self._maxsize,
                )
        self._dq.append(item)
        if was_empty:
            self._event.set()

    async def put(self, item: str) -> None:
        """Async-compatible put (same as put_nowait — ring buffer never blocks)."""
        self.put_nowait(item)
        await asyncio.sleep(0)  # yield to event loop for compatibility

    def get_nowait(self) -> str:
        """Return the oldest item without blocking. Raises IndexError if empty."""
        if len(self._dq) == 0:
            raise IndexError("RingQueue is empty")
        return self._dq.popleft()

    async def get(self) -> str | None:
        """Wait for the next item (or return None after close)."""
        while len(self._dq) == 0:
            if self._closed:
                return None
            self._event.clear()
            await self._event.wait()
            if self._closed:
                return None
        return self._dq.popleft()

    def close(self) -> None:
        """Wake any waiting coroutines and prevent further writes."""
        self._closed = True
        self._event.set()

    def empty(self) -> bool:
        return len(self._dq) == 0

    def qsize(self) -> int:
        return len(self._dq)

    def __len__(self) -> int:
        return len(self._dq)


class ReplayEventQueue:
    """
    Per-session SSE replay buffer.

    Unlike RingQueue.get(), reading by event id does not remove events. This lets
    multiple browser tabs/windows attach to the same trading session without
    stealing ticks and order events from each other.
    """

    def __init__(self, maxsize: int = 12000) -> None:
        self._dq: deque[tuple[int, str]] = deque(maxlen=maxsize)
        self._event = asyncio.Event()
        self._closed = False
        self._dropped: int = 0
        self._maxsize = maxsize
        self._next_id = 1
        self.owner_id = "-"
        self.phase = "initializing"
        self._last_drop_log_at = 0.0

    def put_nowait(self, item: str) -> None:
        if self._closed:
            return
        if len(self._dq) == self._maxsize:
            self._dropped += 1
            now = time.monotonic()
            # This is a bounded reconnect history, not the consumer queue.
            # During a healthy live session it naturally retains the most
            # recent 12k events and discards older ones indefinitely.
            if self._dropped == 1 or now - self._last_drop_log_at >= 60:
                self._last_drop_log_at = now
                logger.warning(
                    "ReplayEventQueue retention rolling owner=%s phase=%s dropped_total=%d "
                    "maxsize=%d buffer_first_id=%s buffer_last_id=%s queue_size=%d "
                    "reason=live_events_exceed_reconnect_history",
                    self.owner_id, self.phase, self._dropped, self._maxsize,
                    self._dq[0][0] if self._dq else "-",
                    self._dq[-1][0] if self._dq else "-",
                    len(self._dq),
                )
        event_id = self._next_id
        self._next_id += 1
        self._dq.append((event_id, item))
        self._event.set()

    async def put(self, item: str) -> None:
        self.put_nowait(item)
        await asyncio.sleep(0)

    def get_nowait(self) -> str:
        """Legacy test helper: pop the oldest buffered payload."""
        if len(self._dq) == 0:
            raise IndexError("ReplayEventQueue is empty")
        return self._dq.popleft()[1]

    async def get_after(self, last_event_id: int | None) -> tuple[int, str] | None:
        """Return the first event after last_event_id, waiting for new data if needed."""
        cursor = last_event_id or 0
        while True:
            if cursor and self._dq and self._dq[0][0] > cursor + 1:
                logger.warning(
                    "ReplayEventQueue event gap owner=%s requested_after=%s "
                    "available_first_id=%s available_last_id=%s dropped=%s",
                    self.owner_id, cursor, self._dq[0][0], self._dq[-1][0], self._dropped,
                )
            for event_id, item in self._dq:
                if event_id > cursor:
                    return event_id, item
            if self._closed:
                return None
            self._event.clear()
            for event_id, item in self._dq:
                if event_id > cursor:
                    return event_id, item
            await self._event.wait()

    def latest_id(self) -> int:
        return self._next_id - 1

    def oldest_id(self) -> int | None:
        return self._dq[0][0] if self._dq else None

    def close(self) -> None:
        self._closed = True
        self._event.set()

    def empty(self) -> bool:
        return len(self._dq) == 0

    def qsize(self) -> int:
        return len(self._dq)

    def __len__(self) -> int:
        return len(self._dq)

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
    desktop_sizing_settings: Optional[dict] = None  # frozen on first desktop start/attachment
    instrument_type: str = "equity"   # "equity" or "options"
    strike: Optional[int] = None       # options: ATM/reference strike
    expiry: Optional[str] = None       # options only (YYYY-MM-DD)
    right: Optional[str] = None        # options only: "CE", "PE", or None (dual-stream)
    strike_ce: Optional[int] = None    # CE streaming strike (equals strike when offset=0)
    strike_pe: Optional[int] = None    # PE streaming strike (equals strike when offset=0)
    brokerage_per_order: float = 1.0    # flat brokerage per trade (from session start config)
    execution_broker: str = "KotakNeo"  # execution identity is independent of market-data source
    strategy_interval_secs: int = 180   # candle interval for all strategies (180=3min, 300=5min)
    session_type: str = "sim"           # "sim", "paper", "real", or "stepwise"
    group_id: str | None = None
    session_alias: str | None = None
    wallet_ledger_id: str = ""
    stepwise: bool = False              # advance one bar per next-bar signal
    step_event: asyncio.Event = field(default_factory=asyncio.Event)
    # Set whenever a completed Stepwise bar is available to consumers that
    # need an atomic snapshot after advancing the shared clock.
    bar_paused_event: asyncio.Event = field(default_factory=asyncio.Event)
    current_bar_index: int = 0         # bars completed so far (stepwise)
    total_bars: int = 0                # total bars in the day (stepwise)
    # Real trading: maps our order_id → Kotak order ID for Kotak-placed orders
    kotak_order_map: dict[str, str] = field(default_factory=dict)
    # Kotak order IDs reconciled from external/manual broker orders (not in our system)
    external_reconciled_kotak_ids: set = field(default_factory=set)
    queue: ReplayEventQueue = field(default_factory=lambda: ReplayEventQueue(12000))
    # paper_tick_queue: receives raw tick dicts from KiteBroadcaster / BreezeStreamManager / KotakBroadcaster
    paper_tick_queue: RingQueue = field(default_factory=lambda: RingQueue(1000))
    resume_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None
    stream_manager: Any = field(default=None, repr=False, compare=False)
    # True when KotakBroadcaster is the active streaming source for this session.
    # Used by stop_session() to call the correct unregister() method.
    kotak_streaming: bool = False
    # True when BreezeStreamManager is the active streaming source for this session.
    # Used for clarity in cleanup; stream_manager.stop() handles actual teardown.
    breeze_streaming: bool = False
    # True when FyersBroadcaster is the active streaming source for this session.
    # Used by stop_session() to call the correct unregister() method.
    fyers_streaming: bool = False
    paper_stream_source: str | None = None
    paper_base_contracts: dict[str, dict] = field(default_factory=dict)
    desktop_option_subscriptions: dict = field(default_factory=dict, repr=False)
    # AI Helper (Phase XI)
    ai_commands_active: bool = False
    # Per-right bar state for AI bar-close hook: {right → {slot, open, high, low, close, history}}
    _ai_bar_tracker: dict = field(default_factory=dict, init=False, repr=False)
    # Unix epoch ms of initial session creation; preserved across DB writes for resume lookup
    created_at: int = 0
    resumed_from_db: bool = False
    # GuardRails runtime state (snapshotted from UserSettings at create_session)
    guardrail_block_until_bar: int = 0        # Unix bar-slot ts; blocked while current_bar_slot <= this
    guardrail_ban_active: bool = False
    guardrail_cooldown_enabled: bool = False
    guardrail_consecutive_losses: int = 0
    guardrail_cooldown_trips_seen: int = 0    # round-trips already consumed by prior cooldown triggers
    guardrail_block_bars: int = 3             # n bars for manual BLOCK
    guardrail_cooldown_block_bars: int = 3    # n bars for COOLDOWN block (separate from manual BLOCK)
    guardrail_cooldown_losses: int = 3        # p consecutive losses for COOLDOWN trigger
    guardrail_ban_capital_pct: float = 10.0   # x% capital loss triggers BAN
    guardrail_ban_loss_trade_pct: float = 60.0 # y% of trades in loss triggers BAN
    guardrail_ban_enabled: bool = False
    guardrail_maxsize_enabled: bool = False
    guardrail_maxsize_mode: str = "percentage"
    guardrail_maxsize_pct: float = 20.0
    guardrail_maxsize_value: float = 0.0
    # Auto-close at end of day (15:09)
    _auto_closed: bool = field(default=False, init=False, repr=False)

    def __post_init__(self) -> None:
        self.queue.owner_id = self.session_id


# Registry of active sessions
_sessions: dict[str, SimulationSession] = {}


def _count_total_bars(symbol: str, date: str, start_time: str, interval_secs: int) -> int:
    """Count distinct bar slots in the day's equity tick data (for stepwise bar counter)."""
    slots: set[int] = set()
    try:
        for tick in iter_ticks(symbol, date, start_time):
            slots.add((tick["time"] // interval_secs) * interval_secs)
    except Exception as exc:
        logger.warning("Could not count bars for %s %s: %s", symbol, date, exc)
    return len(slots)


def _upsert_session_to_db(session: SimulationSession, *, strict: bool = False) -> None:
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
            "strategy_interval_secs": session.strategy_interval_secs,
            "brokerage_per_order": Decimal(str(session.brokerage_per_order)),
            "instrument_type": session.instrument_type,
            "session_type": session.session_type,
            "execution_broker": session.execution_broker,
        }
        if getattr(session, "broker_projection_id", None):
            item["broker_projection_id"] = session.broker_projection_id
            item["broker_projection_owner"] = getattr(session, "broker_projection_owner", session.session_id)
        if session.current_time is not None:
            item["current_time"] = str(session.current_time)
        if session.last_price:
            item["last_price"] = Decimal(str(session.last_price))
        if session.last_price_ce:
            item["last_price_ce"] = Decimal(str(session.last_price_ce))
        if session.last_price_pe:
            item["last_price_pe"] = Decimal(str(session.last_price_pe))
        if session.created_at:
            item["created_at"] = session.created_at
        if session.group_id:
            item["group_id"] = session.group_id
        if session.session_alias:
            item["session_alias"] = session.session_alias
        if session.wallet_ledger_id:
            item["wallet_ledger_id"] = session.wallet_ledger_id
        if getattr(session, "desktop_contracts", None):
            item["desktop_contracts"] = session.desktop_contracts
        if getattr(session, "desktop_origin", None) == "desktop_paper" and getattr(session, "desktop_contract_quotes", None):
            item["desktop_contract_quotes"] = {
                key: {
                    field: Decimal(str(value)) if isinstance(value, float) else value
                    for field, value in quote.items() if value is not None
                }
                for key, quote in session.desktop_contract_quotes.items()
            }
        if session.desktop_sizing_settings is not None:
            item["desktop_sizing_settings"] = {
                key: Decimal(str(value)) if isinstance(value, (float, int)) else value
                for key, value in session.desktop_sizing_settings.items()
            }
        desktop_mode = getattr(session, "desktop_mode", None)
        if desktop_mode:
            item["desktop_mode"] = desktop_mode
        desktop_origin = getattr(session, "desktop_origin", None)
        if desktop_origin:
            item["desktop_origin"] = desktop_origin
        if desktop_origin == "desktop_paper":
            item["desktop_guardrail_state"] = {
                "block_until_bar": int(session.guardrail_block_until_bar),
                "ban_active": bool(session.guardrail_ban_active),
                "consecutive_losses": int(session.guardrail_consecutive_losses),
                "cooldown_trips_seen": int(session.guardrail_cooldown_trips_seen),
                "last_type": str(getattr(session, "guardrail_last_type", "")),
                "last_reason": str(getattr(session, "guardrail_last_reason", "")),
            }
        if getattr(session, "desktop_checkpointed", False):
            item["desktop_checkpointed"] = True
            item["desktop_checkpoint_time"] = int(getattr(session, "desktop_checkpoint_time", 0) or 0)
            item["desktop_checkpoint_bar_index"] = int(getattr(session, "desktop_checkpoint_bar_index", 0) or 0)
            item["desktop_checkpoint_mode"] = str(getattr(session, "desktop_checkpoint_mode", desktop_mode or ""))
            item["desktop_checkpoint_contracts"] = getattr(session, "desktop_contracts", []) or []
        if session.instrument_type == "options":
            item["strike"] = session.strike
            item["expiry"] = session.expiry
            item["right"] = session.right
            if session.strike_ce is not None:
                item["strike_ce"] = session.strike_ce
            if session.strike_pe is not None:
                item["strike_pe"] = session.strike_pe
        if getattr(session, "desktop_origin", None) == "desktop_paper" and getattr(session, "paper_engine_token", None):
            from app.services import paper_wallet
            paper_wallet.fenced_put("Sessions", item, user_id=session.user_id, date=session.date,
                symbol=session.symbol, session_id=session.session_id,
                token=session.paper_engine_token, stopped=session.state == SimulationState.ENDED)
        else:
            table.put_item(Item=item)
    except Exception:
        logger.exception("DynamoDB write failed for session %s", session.session_id)
        if strict:
            raise


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
    stepwise: bool = False,
    group_id: str | None = None,
    session_alias: str | None = None,
    wallet_ledger_id: str | None = None,
    starting_capital: float | None = None,
) -> SimulationSession:
    from app.services import wallet_service
    session_id = str(uuid.uuid4())
    ledger_id = wallet_ledger_id or f"sim:{date}"
    ledger_kind = "paper" if session_type == "paper" else ("real" if session_type == "real" else "sim")
    session_capital = (starting_capital if starting_capital is not None else
                       wallet_service.get_ledger_balance(user_id, date, ledger_id, ledger_kind))
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
        stepwise=stepwise,
        group_id=group_id,
        session_alias=session_alias.strip() if session_alias else None,
        wallet_ledger_id=ledger_id,
    )
    session.resume_event.set()  # not paused initially
    session.created_at = int(datetime.now(timezone.utc).timestamp() * 1000)
    if stepwise:
        session.total_bars = _count_total_bars(symbol, date, start_time, strategy_interval_secs)
    _sessions[session_id] = session
    _upsert_session_to_db(session)
    from app.services.guardrail_service import initialize_guardrails
    initialize_guardrails(session, user_id)
    return session


def find_session_by_context(
    user_id: str,
    symbol: str,
    date: str,
    session_type: str,
    instrument_type: Optional[str] = None,
) -> Optional[dict]:
    """Return the most recent DynamoDB Sessions record for (user, symbol, date, session_type).

    Failures are swallowed so a DB error never blocks a fresh session start.
    """
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        table = get_dynamodb_resource().Table("Sessions")
        resp = table.query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
        )
        matches = [
            it for it in resp.get("Items", [])
            if it.get("symbol") == symbol
            and it.get("date") == date
            and it.get("session_type") == session_type
            and (
                instrument_type is None
                or it.get("instrument_type") == instrument_type
                or (instrument_type == "options" and (it.get("expiry") or it.get("strike") or it.get("strike_ce") or it.get("strike_pe")))
            )
        ]
        if not matches:
            return None
        return max(matches, key=lambda it: int(it.get("created_at", 0)))
    except Exception:
        logger.exception(
            "find_session_by_context failed for user=%s symbol=%s date=%s type=%s",
            user_id, symbol, date, session_type,
        )
        return None


def find_all_sessions_by_context(
    user_id: str,
    symbol: str,
    date: str,
    session_type: str,
    instrument_type: Optional[str] = None,
) -> list[dict]:
    """Return ALL DynamoDB Sessions records matching (user, symbol, date, session_type).

    Returns empty list on failure.
    """
    try:
        from app.services.db import get_dynamodb_resource
        from boto3.dynamodb.conditions import Key
        table = get_dynamodb_resource().Table("Sessions")
        resp = table.query(
            IndexName="UserIdIndex",
            KeyConditionExpression=Key("user_id").eq(user_id),
        )
        return [
            it for it in resp.get("Items", [])
            if it.get("symbol") == symbol
            and it.get("date") == date
            and it.get("session_type") == session_type
            and (
                instrument_type is None
                or it.get("instrument_type") == instrument_type
                or (instrument_type == "options" and (it.get("expiry") or it.get("strike") or it.get("strike_ce") or it.get("strike_pe")))
            )
        ]
    except Exception:
        logger.exception(
            "find_all_sessions_by_context failed for user=%s symbol=%s date=%s type=%s",
            user_id, symbol, date, session_type,
        )
        return []


def rebuild_session_from_db(
    db_record: dict,
    user_id: str,
    strike_ce: Optional[int] = None,
    strike_pe: Optional[int] = None,
    brokerage_per_order: float = 1.0,
    strategy_interval_secs: int = 180,
    starting_capital: float | None = None,
    read_only: bool = False,
    repair_fills: bool = True,
) -> SimulationSession:
    """Re-create a SimulationSession in memory from a DynamoDB record, reusing the same session_id.

    Called when a paper or real session is resumed after a stop/disconnect.
    All prior trades remain visible under this session_id, so position tracking
    and margin checks work without any cross-session logic.

    strike_ce / strike_pe: new request values take priority over DB-saved values.
    This lets the user change their OTM offset on each restart.
    Priority order: caller override → DB-saved → ATM strike fallback.
    """
    from app.services import wallet_service
    session_id = db_record["session_id"]
    symbol = db_record["symbol"]
    date = db_record["date"]
    start_time = db_record.get("start_time", "09:15:00")
    speed = float(db_record.get("speed", 1.0))
    session_type = db_record["session_type"]
    instrument_type = db_record.get("instrument_type", "equity")
    strike_raw = db_record.get("strike")
    strike = int(strike_raw) if strike_raw is not None else None
    expiry = db_record.get("expiry")
    right = db_record.get("right")
    created_at = int(db_record.get("created_at", 0))

    # Resolve effective CE/PE strikes: caller override > DB-saved > ATM fallback
    db_ce_raw = db_record.get("strike_ce")
    db_pe_raw = db_record.get("strike_pe")
    effective_ce = strike_ce if strike_ce is not None else (int(db_ce_raw) if db_ce_raw is not None else strike)
    effective_pe = strike_pe if strike_pe is not None else (int(db_pe_raw) if db_pe_raw is not None else strike)

    ledger_id = f"real:{date}" if session_type == "real" else (db_record.get("wallet_ledger_id") or f"sim:{date}")
    ledger_kind = "paper" if session_type == "paper" else ("real" if session_type == "real" else "sim")
    session_capital = (starting_capital if starting_capital is not None else
                       wallet_service.get_ledger_balance(user_id, date, ledger_id, ledger_kind))

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
        strike_ce=effective_ce,
        strike_pe=effective_pe,
        brokerage_per_order=brokerage_per_order,
        strategy_interval_secs=strategy_interval_secs,
        session_type=session_type,
        stepwise=(session_type == "stepwise"),
        created_at=created_at,
        group_id=db_record.get("group_id"),
        session_alias=db_record.get("session_alias"),
        wallet_ledger_id=ledger_id,
        resumed_from_db=True,
        execution_broker=db_record.get("execution_broker", "KotakNeo"),
    )
    session.desktop_contracts = [
        {**contract, "strike": int(contract["strike"])} if isinstance(contract.get("strike"), Decimal) else contract
        for contract in db_record.get("desktop_contracts", [])
    ]
    session.desktop_contract_quotes = {
        key: {
            field: float(value) if isinstance(value, Decimal) else value
            for field, value in quote.items()
        }
        for key, quote in db_record.get("desktop_contract_quotes", {}).items()
    }
    session.desktop_mode = db_record.get("desktop_mode")
    session.desktop_origin = db_record.get("desktop_origin")
    saved_sizing = db_record.get("desktop_sizing_settings")
    session.desktop_sizing_settings = ({
        key: float(value) if isinstance(value, Decimal) else value
        for key, value in saved_sizing.items()
    } if saved_sizing is not None else None)
    # Restore last-known tick state so orders can be placed immediately after
    # restart, without waiting for the first live tick to arrive.
    saved_current_time = db_record.get("current_time")
    if saved_current_time is not None:
        session.current_time = str(saved_current_time)
    saved_last_price = db_record.get("last_price")
    if saved_last_price is not None:
        session.last_price = float(saved_last_price)
    saved_last_price_ce = db_record.get("last_price_ce")
    if saved_last_price_ce is not None:
        session.last_price_ce = float(saved_last_price_ce)
    saved_last_price_pe = db_record.get("last_price_pe")
    if saved_last_price_pe is not None:
        session.last_price_pe = float(saved_last_price_pe)
    session.broker_projection_id = db_record.get("broker_projection_id")
    session.broker_projection_owner = db_record.get("broker_projection_owner", session.session_id)
    session.resume_event.set()
    if not read_only:
        from app.services.guardrail_service import initialize_guardrails
        initialize_guardrails(session, user_id)
    # Restore restrictions before any resume write. Otherwise the initial
    # session upsert would replace a saved BAN/cooldown with default values.
    if db_record.get("desktop_origin") == "desktop_paper":
        guardrails = db_record.get("desktop_guardrail_state") or {}
        session.guardrail_block_until_bar = int(guardrails.get("block_until_bar") or 0)
        session.guardrail_ban_active = bool(guardrails.get("ban_active"))
        session.guardrail_consecutive_losses = int(guardrails.get("consecutive_losses") or 0)
        session.guardrail_cooldown_trips_seen = int(guardrails.get("cooldown_trips_seen") or 0)
        session.guardrail_last_type = guardrails.get("last_type") or ""
        session.guardrail_last_reason = guardrails.get("last_reason") or ""
    if read_only:
        session.state = SimulationState.ENDED
        session.desktop_read_only = True
    else:
        _sessions[session_id] = session
        _upsert_session_to_db(session)
    from app.services import trading as trading_svc
    trading_svc.reload_trades_from_db(session_id,
        strict=db_record.get("desktop_origin") == "desktop_paper")
    if session_type == "real":
        from app.services.real_broker_state import restore_orders
        restore_orders(session)
    if session_type == "paper" and ledger_id.startswith("paper:"):
        from app.services.order_service import reload_paper_orders
        reload_paper_orders(session, repair_fills=repair_fills)
    logger.info(
        "rebuild_session_from_db: resumed session %s for user=%s symbol=%s date=%s type=%s (%d trades restored)",
        session_id, user_id, symbol, date, session_type,
        len(trading_svc.get_trades(session_id)),
    )
    return session


def resolve_website_paper_resume_contracts(session: SimulationSession) -> None:
    resolve_website_resume_contracts(session)


def resolve_website_resume_contracts(session: SimulationSession) -> None:
    """Open positions win per side; flat sides keep the requested selection."""
    from app.services import trading, order_service
    positions = trading.get_open_option_contracts(session.session_id, session.symbol)
    for right in ("CE", "PE"):
        candidates = [item for item in positions if item["right"] == right and item["expiry"] == session.expiry]
        if candidates:
            chosen = max(candidates, key=lambda item: (item["last_opened_at"], item["strike"]))
            setattr(session, f"strike_{right.lower()}", chosen["strike"])
        # Persisted display prices are not current-feed execution quotes.
        setattr(session, f"last_price_{right.lower()}", 0.0)
    contracts = {(item["right"], item["strike"], item["expiry"]) for item in positions}
    contracts.update((order.right, order.strike, order.expiry)
        for order in order_service.get_open_orders(session.session_id)
        if order.right in ("CE", "PE") and order.strike is not None and order.expiry)
    session.desktop_contracts = list(getattr(session, "desktop_contracts", []))
    existing = {item["contract_key"] for item in session.desktop_contracts}
    for right, strike, expiry in sorted(contracts):
        key = f"{session.symbol}:{expiry}:{strike}:{right}"
        if key not in existing:
            session.desktop_contracts.append({"symbol": session.symbol, "right": right,
                "strike": strike, "expiry": expiry, "contract_key": key})
            existing.add(key)
    logger.info("resume_contracts_selected session_id=%s strike_ce=%s strike_pe=%s open_contracts=%d tracked_contracts=%d",
        session.session_id, session.strike_ce, session.strike_pe, len(positions), len(contracts))
    _upsert_session_to_db(session)


# ── Auto-close positions at end of day ────────────────────────────────────────

_AUTO_CLOSE_TIME = "15:09:00"


def _auto_close_positions_if_eod(
    session: SimulationSession,
    tick: dict,
    tick_right: Optional[str],
) -> list[dict]:
    """Check if it's past 15:09 and auto-close any open positions at market price."""
    from app.services.order_service import place_order, get_open_orders, OrderType
    from app.services.trading import get_position, TradeSide

    tick_time = tick["time"]
    tick_price = tick["close"]

    # Parse the tick time to check if it's past auto-close time
    from datetime import datetime as _dt
    import pandas as _pd
    auto_close_ts = int(_pd.Timestamp(f"{session.date} {_AUTO_CLOSE_TIME}").timestamp())
    if tick_time < auto_close_ts:
        return []

    strike = tick.get("strike")
    if strike is None and tick_right:
        strike = session.strike_ce if tick_right == "CE" else session.strike_pe
    expiry = tick.get("expiry", session.expiry) if tick_right else None
    contract_key = (tick_right, strike, expiry)
    closed_contracts = getattr(session, "_auto_closed_contracts", set())
    if contract_key in closed_contracts:
        return []
    closed_contracts.add(contract_key)
    session._auto_closed_contracts = closed_contracts
    session._auto_closed = True

    fill_events = []

    # Determine which positions to check
    rights_to_check = [tick_right]

    for right in rights_to_check:
        position = get_position(session.session_id, session.symbol, right, strike, expiry)
        if position.side == "FLAT" or position.quantity == 0:
            continue

        # Cancel any existing open orders for this right first
        open_orders = get_open_orders(session.session_id)
        for order in open_orders:
            if order.right == right and (not right or (order.strike == strike and order.expiry == expiry)):
                from app.services.order_service import cancel_order
                cancel_order(session.session_id, order.order_id, session.date)

        # Create a market order to close the position
        if position.side == "LONG":
            # Sell to close long
            close_side = TradeSide.SELL
        else:
            # Buy to cover short
            close_side = TradeSide.BUY

        try:
            close_order = place_order(
                session_id=session.session_id,
                symbol=session.symbol,
                side=close_side,
                order_type=OrderType.LIMIT,
                quantity=position.quantity,
                created_at=tick_time,
                trading_date=session.date,
                limit_price=tick_price,  # Will fill immediately at market
                is_stoploss=True,  # Don't reserve wallet for closing orders
                right=right,
                strike=strike,
                expiry=expiry,
                user_id=session.user_id,
                wallet_ledger_id=session.wallet_ledger_id or None,
                wallet_ledger_kind="paper" if session.session_type == "paper" else "sim",
            )
            logger.info(
                "Auto-close: placed %s order for %s %s qty=%d at %.2f (session=%s)",
                close_side.value, session.symbol, right, position.quantity, tick_price, session.session_id,
            )
        except Exception as exc:
            logger.error("Auto-close order failed for session %s right=%s: %s", session.session_id, right, exc)

    return fill_events


class _ContractTickQueue:
    def __init__(self, session: SimulationSession, contract: dict):
        self.session = session
        self.contract = contract

    @property
    def maxsize(self) -> int:
        return self.session.paper_tick_queue.maxsize

    def full(self) -> bool:
        return self.session.paper_tick_queue.full()

    def put_nowait(self, payload: dict) -> None:
        if self.session.state != SimulationState.ENDED:
            self.session.paper_tick_queue.put_nowait({**payload, **self.contract})


def subscribe_desktop_option_contract(session: SimulationSession, contract: dict) -> None:
    if not session.paper_stream_source:
        return
    key = contract["contract_key"]
    if key in session.desktop_option_subscriptions:
        return
    if session.paper_base_contracts.get(contract["right"]) == {
        "strike": contract["strike"], "expiry": contract["expiry"],
    }:
        return
    loop = asyncio.get_running_loop()
    queue = _ContractTickQueue(session, dict(contract))
    subscription_id = f"{session.session_id}:option:{key}"
    from app.config import SUPPORTED_SYMBOLS
    from app.services.market_data import FeedGroup, get_hub
    if getattr(session, "market_feed_group", None) is None:
        session.market_feed_group = FeedGroup(session.paper_stream_source, session.session_type == "real")
    instrument = {"kind": "option", "exchange": SUPPORTED_SYMBOLS[session.symbol]["options_exchange_code"],
                  "underlying": session.symbol, "expiry": contract["expiry"],
                  "strike": int(contract["strike"]), "right": contract["right"]}
    async def attach():
        try:
            handle = await get_hub().subscribe(instrument, subscription_id, session.market_feed_group, queue)
            if session.state == SimulationState.ENDED:
                handle.close()
            else:
                session.desktop_option_subscriptions[key] = ("hub", handle, subscription_id)
        except Exception as exc:
            session.desktop_option_subscriptions.pop(key, None)
            session.queue.put_nowait(json.dumps({"type": "broker_error", "message": str(exc)}))
    task = loop.create_task(attach())
    session.desktop_option_subscriptions[key] = ("pending", task, subscription_id)
    return task


def _stop_desktop_option_subscriptions(session: SimulationSession) -> None:
    for source, manager, subscription_id in list(session.desktop_option_subscriptions.values()):
        try:
            if source == "pending":
                manager.cancel()
            elif source == "hub":
                manager.close()
            elif source == "breeze":
                manager.stop()
            else:
                manager.unregister(subscription_id)
        except Exception:
            logger.exception("Could not stop option subscription %s", subscription_id)
    session.desktop_option_subscriptions.clear()
    session.paper_stream_source = None


def _emit_attached_option_ticks(session: SimulationSession, timestamp: int) -> list[dict]:
    from app.services.desktop_preparation import desktop_option_ticks as options_iter_ticks
    cache = getattr(session, "desktop_option_ticks_by_time", None)
    if cache is None:
        cache = {}
        session.desktop_option_ticks_by_time = cache
    events = []
    for contract in getattr(session, "desktop_contracts", []):
        if session.instrument_type == "options":
            primary_rights = (session.right,) if session.right else ("CE", "PE")
            primary_strike = session.strike if session.right else (
                session.strike_ce if contract["right"] == "CE" else session.strike_pe)
            if contract["right"] in primary_rights and contract["strike"] == primary_strike and contract["expiry"] == session.expiry:
                continue  # The normal source stream evaluates this exact contract.
        key = contract["contract_key"]
        if key not in cache:
            quote_cache = getattr(session, "desktop_contract_quote_ticks", {})
            ticks = quote_cache.get(key)
            if ticks is None:
                ticks = list(options_iter_ticks(session.symbol, session.date, contract["strike"], contract["expiry"], contract["right"], session.start_time))
            cache[key] = {tick["time"]: tick for tick in ticks}
            quote_cache[key] = ticks
            session.desktop_contract_quote_ticks = quote_cache
        tick = cache[key].get(timestamp)
        if tick:
            events.extend(_emit_tick_and_check_orders(session, {**tick, **contract}, contract["right"]))
    return events


def _emit_tick_and_check_orders(
    session: SimulationSession,
    tick: dict,
    tick_right: Optional[str],
    only_order_id: str | None = None,
) -> list[dict]:
    """Put one tick on the queue and return fill events for any triggered orders."""
    from app.services.order_service import check_orders
    from app.models.schemas import OrderStatus
    from app.services.trading import record_trade, settle_wallet_for_trade

    if getattr(session, "paper_engine_token", None) and time.monotonic() >= getattr(session, "paper_engine_valid_until", 0):
        session.paper_lease_lost = True
        stop_session(session)
        return []

    if not tick.get("provider"):
        history_key = (tick_right, tick.get("strike") or (session.strike_ce if tick_right == "CE" else session.strike_pe if tick_right == "PE" else None), tick.get("expiry", session.expiry) if tick_right else None)
        marks = getattr(session, "_history_watermarks", {})
        marks[history_key] = max(marks.get(history_key, 0), int(tick["time"]))
        session._history_watermarks = marks
    if tick_right and not tick.get("contract_key"):
        base_contract = session.paper_base_contracts.get(tick_right, {}) if session.paper_stream_source else {}
        tick_strike = tick.get("strike") or base_contract.get("strike") or (session.strike_ce if tick_right == "CE" else session.strike_pe)
        tick_expiry = tick.get("expiry") or base_contract.get("expiry") or session.expiry
        tick = {**tick, "strike": tick_strike, "expiry": tick_expiry}
        for contract in getattr(session, "desktop_contracts", []):
            if (
                contract.get("right") == tick_right
                and int(contract.get("strike") or 0) == int(tick_strike or 0)
                and (contract.get("expiry") or "") == (tick_expiry or "")
            ):
                tick = {**tick, **contract}
                break

    linked_stream_id = getattr(session, "desktop_live_stream_id", None) if session.session_type == "paper" else None
    if tick_right and linked_stream_id and getattr(session, "market_feed_group", None) is None:
        from app.services import desktop_live_service
        contract = next((item for item in getattr(session, "desktop_contracts", []) if item.get("contract_key") == tick.get("contract_key")), None)
        if contract is None:
            return []
        chart_quote = desktop_live_service.option_quote(session.user_id, linked_stream_id, contract["symbol"], contract["expiry"], contract["strike"], contract["right"])
        if chart_quote is None:
            return []
        logged = getattr(session, "_paper_quote_source_logged", set())
        if contract["contract_key"] not in logged:
            logger.info("paper_option_quote_source session_id=%s contract=%s engine_price=%s engine_token=%s chart_price=%s chart_token=%s chart_timestamp=%s", session.session_id, contract["contract_key"], tick.get("close"), tick.get("provider_token"), chart_quote["price"], chart_quote.get("provider_token"), chart_quote["timestamp"])
            logged.add(contract["contract_key"])
            session._paper_quote_source_logged = logged
        tick = {**tick, **{key: chart_quote[key] for key in ("open", "high", "low", "close")}, "time": chart_quote["timestamp"], "source": chart_quote["source"], "provider_token": chart_quote.get("provider_token")}

    if tick_right and tick.get("contract_key"):
        registry = getattr(session, "desktop_contract_quotes", {})
        registry[tick["contract_key"]] = {**tick, "price": tick["close"], "timestamp": tick["time"], "source": tick.get("source") or ("live_paper" if session.paper_stream_source else "historical_stepwise")}
        session.desktop_contract_quotes = registry
        active_strike = session.strike_ce if tick_right == "CE" else session.strike_pe
        if tick.get("strike") == active_strike:
            if tick_right == "CE":
                session.last_price_ce = tick["close"]
            else:
                session.last_price_pe = tick["close"]

    history_presentation = (session.session_type == "paper" and getattr(session, "market_feed_group", None)
                            and not session.paper_stream_source and not tick.get("provider"))
    # Auto-close only on observations evaluated by the engine, not chart backfill.
    if session.session_type != "real" and not history_presentation:
        _auto_close_positions_if_eod(session, tick, tick_right)

    session.queue.put_nowait(json.dumps({**tick, "session_id": session.session_id}, default=_json_decimal))
    if not getattr(session, "_first_tick_forwarded_logged", False):
        session._first_tick_forwarded_logged = True
        logger.debug(
            "paper_tick_forwarded_to_sse session_id=%s right=%s time=%s",
            session.session_id, tick_right or "EQ", tick.get("time"),
        )

    if history_presentation:
        return []

    current_time = tick["time"]
    # A grouped replay has one durable clock.  Each member may have different
    # quote availability, but its visible clock is always this common tick.
    if only_order_id is None and session.group_id and session.session_type in ("sim", "stepwise"):
        try:
            from app.services import session_group_service
            group = session_group_service.get_group(session.group_id, session.user_id)
            if group and group.get("current_time") != str(current_time):
                # Keep the shared clock current in the in-memory group cache.
                # Persisting this on every tick makes one Stepwise click issue
                # hundreds of synchronous DynamoDB writes before the next bar
                # can finish processing.  The clock is persisted at the bar
                # boundary by _persist_group_clock().
                group["current_time"] = str(current_time)
        except Exception:
            logger.exception("Could not persist clock for group %s", session.group_id)
    current_price = tick["close"]
    tick_strike = None
    if tick_right == "CE":
        tick_strike = session.strike_ce or session.strike
    elif tick_right == "PE":
        tick_strike = session.strike_pe or session.strike
    tick_strike = tick.get("strike", tick_strike)
    filled = check_orders(
        session.session_id, current_price, current_time, session.date,
        tick_right=tick_right,
        tick_strike=tick_strike,
        tick_expiry=tick.get("expiry", session.expiry) if tick_right else None,
        settle_wallet=False,
        only_order_id=only_order_id,
    )
    fill_events = []
    desktop_sources = {"desktop_paper", "desktop_replay", "desktop_stepwise"}
    for order in filled:
        fill_started = time.monotonic()
        if getattr(session, "desktop_origin", None) in desktop_sources or order.source in desktop_sources:
            logger.info("desktop_fill_triggered session_id=%s order_id=%s tick_time=%s", session.session_id, order.order_id, current_time)
        try:
            settle_wallet_for_trade(
                session,
                order.side,
                order.filled_price,
                order.quantity,
                right=order.right,
                strike=order.strike if order.strike is not None else session.strike,
                expiry=order.expiry if order.expiry is not None else session.expiry,
                entry_reserved=order.reserved_amount > 0,
                reserved_amount=order.reserved_amount,
                operation_id=f"fill:{order.order_id}",
                order=order,
            )
        except Exception as exc:
            from app.services.wallet_service import InsufficientFundsError
            order.status = OrderStatus.PENDING
            if not (session.wallet_ledger_id or "").startswith("paper:"):
                order.filled_at = None
                order.filled_price = None
            if isinstance(exc, InsufficientFundsError):
                from app.services.order_service import cancel_order
                cancel_order(session.session_id, order.order_id, session.date)
                fill_events.append({"type": "order_cancelled", "order_id": order.order_id, "reason": str(exc)})
            else:
                logger.exception("Wallet settlement deferred for %s", order.order_id)
            continue
        trade = record_trade(
            trade_id=order.order_id,
            session_id=session.session_id,
            side=order.side,
            price=order.filled_price,
            timestamp=order.filled_at,
            quantity=order.quantity,
            symbol=order.symbol,
            instrument_type="options" if order.right else session.instrument_type,
            strike=order.strike if order.strike is not None else session.strike,
            expiry=order.expiry if order.expiry is not None else session.expiry,
            right=order.right,
            brokerage_per_order=session.brokerage_per_order,
            user_id=session.user_id,
            session_type=session.session_type,
            source=order.source,
        )
        fill_event = {
            "type": "order_filled",
            "order_id": order.order_id,
            "side": order.side.value,
            "quantity": order.quantity,
            "trigger_price": order.trigger_price,
            "filled_price": order.filled_price,
            "filled_at": order.filled_at,
            "right": order.right,
            "strike": order.strike,
            "expiry": order.expiry,
        }
        if getattr(session, "desktop_origin", None) in desktop_sources or order.source in desktop_sources:
            # All desktop modes can render a committed fill without a snapshot.
            from app.routers.desktop_trading import _day_pnl, _mark_open_trades, _position_for, _position_pnl
            from app.services.trading import get_trades
            contract_key = f"{order.symbol}:{order.expiry}:{order.strike}:{order.right}" if order.right else None
            day_pnl = _day_pnl(session)
            capital = float(session.session_capital or 0)
            fill_event.update({
                "committed_at_ms": int(time.time() * 1000),
                "trade": trade.model_dump(mode="json"),
                "contract_key": contract_key,
                "position": _position_for(session, order.right, order.strike, order.expiry).model_dump(mode="json"),
                "open_trade_ids": [item["trade_id"] for item in _mark_open_trades([item.model_dump(mode="json") for item in get_trades(session.session_id)]) if item["is_open"]],
                "pnl": {
                    "equity": _position_pnl(session, None),
                    "ce": _position_pnl(session, "CE", session.strike_ce, session.expiry),
                    "pe": _position_pnl(session, "PE", session.strike_pe, session.expiry),
                    "contracts": {item["contract_key"]: _position_pnl(session, item["right"], item["strike"], item["expiry"]) for item in getattr(session, "desktop_contracts", [])},
                    "day": day_pnl,
                    "day_pct": round(day_pnl / capital * 100, 2) if capital > 0 else 0,
                },
            })
            if session.wallet_ledger_id and not session.wallet_ledger_id.startswith("paper:"):
                # Historical settlement has already updated this cached ledger.
                # Preserve prompt wallet updates without a full snapshot or an
                # additional distributed Paper-wallet read on the fill path.
                from app.services.wallet_service import get_ledger_balance
                fill_event["wallet_balance"] = get_ledger_balance(session.user_id, session.date, session.wallet_ledger_id)
            session.queue.put_nowait(json.dumps(fill_event, default=_json_decimal))
            logger.info("desktop_fill_queued session_id=%s order_id=%s elapsed_ms=%.1f event_id=%s", session.session_id, order.order_id, (time.monotonic() - fill_started) * 1000, session.queue.latest_id())
        else:
            fill_events.append(fill_event)

    # Strategy evaluation — snapshot open orders before/after so strategy-placed
    # orders (e.g. AutoStop TARGET) are surfaced to the frontend via order_placed events,
    # and strategy-cancelled orders (e.g. stoploss cancelled by TargetProfit) emit
    # order_cancelled events so the UI removes them immediately.
    try:
        from app.services import strategy_service
        from app.services.order_service import get_open_orders, get_order
        running_before = {s.strategy_id: s for s in strategy_service.list_running(session.session_id)}
        before_orders = {o.order_id: (o.quantity, o.trigger_price, o.limit_price, o.order_type, o.is_stoploss) for o in get_open_orders(session.session_id)}
        before_ids = set(before_orders)

        # Auto-stoploss-on-entry: place SL orders for filled entries.
        # Must run AFTER before_ids snapshot so the diff captures new SL orders,
        # but BEFORE strategy_service.on_tick() so strategies like BreakEven
        # can see and modify the newly placed SL.
        for order in filled:
            if order.entry_sl_price is not None or order.is_autostop:
                from app.services.entry_sl_watcher import on_entry_filled
                on_entry_filled(order, session)
        strategy_service.on_tick(session, tick, tick_right)
        after_open_orders = get_open_orders(session.session_id)
        after_ids = {o.order_id for o in after_open_orders}
        # Emit cancellation events for orders the strategy cancelled
        for order_id in before_ids - after_ids:
            o = get_order(session.session_id, order_id)
            if o and o.status == OrderStatus.CANCELLED:
                fill_events.append({"type": "order_cancelled", "order_id": order_id})
        # Emit placed events for new strategy orders
        for new_order in after_open_orders:
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
                    "is_autostop": new_order.is_autostop,
                    "right": new_order.right,
                    "strike": new_order.strike,
                    "expiry": new_order.expiry,
                    "entry_sl_price": new_order.entry_sl_price,
                    "group_id": new_order.group_id,
                })
        for changed in after_open_orders:
            if changed.order_id in before_orders and before_orders[changed.order_id] != (changed.quantity, changed.trigger_price, changed.limit_price, changed.order_type, changed.is_stoploss):
                fill_events.append({"type": "order_updated", **changed.model_dump(mode="json")})
        # Emit completion events for strategies that just finished
        running_after_ids = {s.strategy_id for s in strategy_service.list_running(session.session_id)}
        for sid, strat in running_before.items():
            if sid not in running_after_ids:
                fill_events.append({"type": "strategy_completed", "strategy_id": sid, "right": strat.right})
    except Exception as exc:
        logger.warning("strategy eval error for session %s: %s", session.session_id, exc)

    # AI bar-close hook (Phase XI)
    if session.ai_commands_active:
        try:
            _check_and_schedule_ai_hook(session, tick, tick_right, asyncio.get_running_loop())
        except RuntimeError:
            pass  # not in async context — shouldn't happen

    if (only_order_id is None and tick_right is None and not session.paper_stream_source
            and getattr(session, "desktop_contracts", None)
            and (session.instrument_type == "equity" or session.session_type in ("sim", "stepwise"))):
        fill_events.extend(_emit_attached_option_ticks(session, current_time))
    return fill_events


def _persist_group_clock(session: SimulationSession) -> None:
    """Persist a grouped replay clock after a bar, not once per tick."""
    if not session.group_id or session.session_type not in ("sim", "stepwise"):
        return
    try:
        from app.services import session_group_service
        group = session_group_service.get_group(session.group_id, session.user_id)
        if group:
            session_group_service.update_clock(group, session.current_time)
    except Exception:
        logger.exception("Could not persist clock for group %s", session.group_id)


async def _run_session(session: SimulationSession) -> None:
    from app.services.historical_data_service import detach_historical_operation
    detach_historical_operation(mode="replay")
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
            if getattr(session, "desktop_created", False) or str(getattr(session, "desktop_origin", "")).startswith("desktop_"):
                from app.services.desktop_preparation import desktop_option_ticks as options_iter_ticks

            cur_ce_strike = session.strike_ce or session.strike
            cur_pe_strike = session.strike_pe or session.strike

            def _load_by_time(strike: int, right: str, start_str: str) -> dict:
                return {t["time"]: t for t in options_iter_ticks(
                    session.symbol, session.date, strike, session.expiry, right, start_str
                )}

            # Materializing an entire day's three streams must not block SSE,
            # pause/stop or the other sessions on the application event loop.
            ce_by_time, pe_by_time, eq_ticks = await asyncio.gather(
                asyncio.to_thread(_load_by_time, cur_ce_strike, "CE", session.start_time),
                asyncio.to_thread(_load_by_time, cur_pe_strike, "PE", session.start_time),
                asyncio.to_thread(lambda: list(iter_ticks(session.symbol, session.date, session.start_time))),
            )

            prev_bar_slot_ds: Optional[int] = None
            bar_o_ds = bar_h_ds = bar_l_ds = bar_c_ds = None
            bar_o_ce = bar_h_ce = bar_l_ce = bar_c_ce = None
            bar_o_pe = bar_h_pe = bar_l_pe = bar_c_pe = None
            for eq_tick in eq_ticks:
                await session.resume_event.wait()
                if session.state == SimulationState.ENDED:
                    break

                # Stepwise: pause at each bar boundary before processing the new bar
                if session.stepwise:
                    interval = session.strategy_interval_secs
                    bar_slot = (eq_tick["time"] // interval) * interval
                    if prev_bar_slot_ds is not None and bar_slot != prev_bar_slot_ds:
                        session.current_bar_index += 1
                        try:
                            session.queue.put_nowait(json.dumps({
                                "type": "bar_paused",
                                "bar_index": session.current_bar_index,
                                "total_bars": session.total_bars,
                                "bar_time": prev_bar_slot_ds,
                                "bar_open": bar_o_ds, "bar_high": bar_h_ds,
                                "bar_low": bar_l_ds, "bar_close": bar_c_ds,
                                "bar_open_ce": bar_o_ce, "bar_high_ce": bar_h_ce,
                                "bar_low_ce": bar_l_ce, "bar_close_ce": bar_c_ce,
                                "bar_open_pe": bar_o_pe, "bar_high_pe": bar_h_pe,
                                "bar_low_pe": bar_l_pe, "bar_close_pe": bar_c_pe,
                            }))
                        except asyncio.QueueFull:
                            pass
                        _persist_group_clock(session)
                        bar_o_ds = bar_h_ds = bar_l_ds = bar_c_ds = None
                        bar_o_ce = bar_h_ce = bar_l_ce = bar_c_ce = None
                        bar_o_pe = bar_h_pe = bar_l_pe = bar_c_pe = None
                        session.bar_paused_event.set()
                        session.step_event.clear()
                        await session.step_event.wait()
                        if session.state == SimulationState.ENDED:
                            break
                    prev_bar_slot_ds = bar_slot

                ts = eq_tick["time"]
                ts_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%H:%M:%S")

                new_ce = session.strike_ce or session.strike
                if new_ce != cur_ce_strike:
                    cur_ce_strike = new_ce
                    try:
                        ce_by_time = await asyncio.to_thread(_load_by_time, cur_ce_strike, "CE", ts_str)
                    except Exception as exc:
                        logger.warning("Could not reload CE data for strike %s: %s", cur_ce_strike, exc)
                        ce_by_time = {}

                new_pe = session.strike_pe or session.strike
                if new_pe != cur_pe_strike:
                    cur_pe_strike = new_pe
                    try:
                        pe_by_time = await asyncio.to_thread(_load_by_time, cur_pe_strike, "PE", ts_str)
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
                    if session.stepwise:
                        t = ce_by_time[ts]
                        if bar_o_ce is None:
                            bar_o_ce, bar_h_ce, bar_l_ce = t["open"], t["high"], t["low"]
                        else:
                            bar_h_ce = max(bar_h_ce, t["high"])
                            bar_l_ce = min(bar_l_ce, t["low"])
                        bar_c_ce = t["close"]

                if ts in pe_by_time:
                    pe_tick = {**pe_by_time[ts], "right": "PE"}
                    session.last_price_pe = pe_tick["close"]
                    fill_events += _emit_tick_and_check_orders(session, pe_tick, "PE")
                    if session.stepwise:
                        t = pe_by_time[ts]
                        if bar_o_pe is None:
                            bar_o_pe, bar_h_pe, bar_l_pe = t["open"], t["high"], t["low"]
                        else:
                            bar_h_pe = max(bar_h_pe, t["high"])
                            bar_l_pe = min(bar_l_pe, t["low"])
                        bar_c_pe = t["close"]

                for fe in fill_events:
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        logger.warning("Queue full, dropping order_filled event for %s", fe.get("order_id"))

                if session.stepwise:
                    if bar_o_ds is None:
                        bar_o_ds, bar_h_ds, bar_l_ds = eq_tick["open"], eq_tick["high"], eq_tick["low"]
                    else:
                        bar_h_ds = max(bar_h_ds, eq_tick["high"])
                        bar_l_ds = min(bar_l_ds, eq_tick["low"])
                    bar_c_ds = eq_tick["close"]
                else:
                    await asyncio.sleep(session.speed)

        # Single-contract options (right provided — Sprint 3 compat)
        elif session.instrument_type == "options" and session.strike and session.expiry and session.right:
            from app.services.options_service import options_iter_ticks
            if getattr(session, "desktop_created", False) or str(getattr(session, "desktop_origin", "")).startswith("desktop_"):
                from app.services.desktop_preparation import desktop_option_ticks as options_iter_ticks
            tick_iter = options_iter_ticks(
                session.symbol, session.date, session.strike,
                session.expiry, session.right, session.start_time,
            )
            prev_bar_slot_so: Optional[int] = None
            bar_o_so = bar_h_so = bar_l_so = bar_c_so = None
            for tick in tick_iter:
                await session.resume_event.wait()
                if session.state == SimulationState.ENDED:
                    break

                # Stepwise: pause at each bar boundary before processing the new bar
                if session.stepwise:
                    interval = session.strategy_interval_secs
                    bar_slot = (tick["time"] // interval) * interval
                    if prev_bar_slot_so is not None and bar_slot != prev_bar_slot_so:
                        session.current_bar_index += 1
                        try:
                            session.queue.put_nowait(json.dumps({
                                "type": "bar_paused",
                                "bar_index": session.current_bar_index,
                                "total_bars": session.total_bars,
                                "bar_time": prev_bar_slot_so,
                                "bar_open": bar_o_so, "bar_high": bar_h_so,
                                "bar_low": bar_l_so, "bar_close": bar_c_so,
                            }))
                        except asyncio.QueueFull:
                            pass
                        _persist_group_clock(session)
                        bar_o_so = bar_h_so = bar_l_so = bar_c_so = None
                        session.bar_paused_event.set()
                        session.step_event.clear()
                        await session.step_event.wait()
                        if session.state == SimulationState.ENDED:
                            break
                    prev_bar_slot_so = bar_slot

                session.current_time = str(tick["time"])
                session.last_price = tick["close"]
                # Attachments can change the CE/PE convenience strike, but this
                # iterator still belongs to the original single-contract source.
                tick = {**tick, "strike": session.strike, "expiry": session.expiry, "right": session.right}
                fill_events = _emit_tick_and_check_orders(session, tick, session.right)
                if getattr(session, "desktop_contracts", None):
                    fill_events.extend(_emit_attached_option_ticks(session, tick["time"]))
                for fe in fill_events:
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        logger.warning("Queue full, dropping order_filled event for %s", fe["order_id"])

                if session.stepwise:
                    if bar_o_so is None:
                        bar_o_so, bar_h_so, bar_l_so = tick["open"], tick["high"], tick["low"]
                    else:
                        bar_h_so = max(bar_h_so, tick["high"])
                        bar_l_so = min(bar_l_so, tick["low"])
                    bar_c_so = tick["close"]
                else:
                    await asyncio.sleep(session.speed)

        # Equity
        else:
            prev_bar_slot_eq: Optional[int] = None
            bar_o_eq = bar_h_eq = bar_l_eq = bar_c_eq = None
            for tick in iter_ticks(session.symbol, session.date, session.start_time):
                await session.resume_event.wait()
                if session.state == SimulationState.ENDED:
                    break

                # Stepwise: pause at each bar boundary before processing the new bar
                if session.stepwise:
                    interval = session.strategy_interval_secs
                    bar_slot = (tick["time"] // interval) * interval
                    if prev_bar_slot_eq is not None and bar_slot != prev_bar_slot_eq:
                        session.current_bar_index += 1
                        try:
                            session.queue.put_nowait(json.dumps({
                                "type": "bar_paused",
                                "bar_index": session.current_bar_index,
                                "total_bars": session.total_bars,
                                "bar_time": prev_bar_slot_eq,
                                "bar_open": bar_o_eq, "bar_high": bar_h_eq,
                                "bar_low": bar_l_eq, "bar_close": bar_c_eq,
                            }))
                        except asyncio.QueueFull:
                            pass
                        _persist_group_clock(session)
                        bar_o_eq = bar_h_eq = bar_l_eq = bar_c_eq = None
                        session.bar_paused_event.set()
                        session.step_event.clear()
                        await session.step_event.wait()
                        if session.state == SimulationState.ENDED:
                            break
                    prev_bar_slot_eq = bar_slot

                session.current_time = str(tick["time"])
                session.last_price = tick["close"]
                fill_events = _emit_tick_and_check_orders(session, tick, None)
                for fe in fill_events:
                    try:
                        session.queue.put_nowait(json.dumps(fe))
                    except asyncio.QueueFull:
                        logger.warning("Queue full, dropping order_filled event for %s", fe["order_id"])

                if session.stepwise:
                    if bar_o_eq is None:
                        bar_o_eq, bar_h_eq, bar_l_eq = tick["open"], tick["high"], tick["low"]
                    else:
                        bar_h_eq = max(bar_h_eq, tick["high"])
                        bar_l_eq = min(bar_l_eq, tick["low"])
                    bar_c_eq = tick["close"]
                else:
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
    import logging
    _log = logging.getLogger(__name__)
    from app.config import SUPPORTED_SYMBOLS
    sym_info = SUPPORTED_SYMBOLS.get(session.symbol, {})
    _log.info(
        "build_breeze_instruments: symbol=%s instrument_type=%s strike=%s strike_ce=%s strike_pe=%s expiry=%s right=%s",
        session.symbol, session.instrument_type, session.strike,
        session.strike_ce, session.strike_pe, session.expiry, session.right,
    )
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


def _historical_gap_ticks(symbol: str, date: str, after_ts: int) -> list[dict]:
    """
    Return configured historical equity ticks for timestamps strictly after `after_ts`
    (IST-as-UTC Unix). Non-fatal: returns [] on any error.
    """
    try:
        import pandas as pd
        from app.services.historical_data_service import load_history
        df = load_history(symbol, date, mode="live").frame
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
        logger.warning("Configured historical equity gap-fill failed for %s %s: %s", symbol, date, exc)
        return []


def _historical_gap_options_ticks(
    symbol: str, date: str, strike: int, expiry: str, right: str, after_ts: int
) -> list[dict]:
    """
    Return configured historical options ticks for timestamps strictly after `after_ts`.
    Non-fatal: returns [] on any error.
    """
    try:
        import pandas as pd
        from app.services.historical_data_service import load_history
        df = load_history(symbol, date, strike, expiry, right, mode="live").frame
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
        logger.warning("Configured historical options gap-fill failed for %s %s %s: %s", symbol, date, right, exc)
        return []


async def _setup_kotak_streaming(session: SimulationSession, loop: "asyncio.AbstractEventLoop") -> bool:
    """
    Subscribe a paper/real session to the KotakBroadcaster for live market data.
    Returns True on success, False if Kotak is not authenticated.
    Raises KotakError on subscription failure.

    Token lookup: resolves Kotak scrip tokens from the cached instrument master.
    The master is downloaded lazily on first use (requires Kotak auth).
    """
    from app.services import kotak_service as ks

    if not ks.get_kotak_broadcaster().is_ready():
        logger.warning(
            "KotakBroadcaster: Kotak Neo not authenticated — cannot use Kotak streaming "
            "for session %s", session.session_id,
        )
        return False

    from app.config import SUPPORTED_SYMBOLS

    tokens: list[str] = []
    exchanges: list[str] = []
    rights: list[str | None] = []
    is_indices: list[bool] = []

    # Equity / index token — NIFTY and BSESEN are index instruments (options_only symbols)
    eq_token, eq_exchange = ks.fetch_kotak_equity_instrument_token(session.symbol)
    sym_is_index = SUPPORTED_SYMBOLS.get(session.symbol, {}).get("options_only", False)
    tokens.append(eq_token)
    exchanges.append(eq_exchange)
    rights.append(None)
    is_indices.append(sym_is_index)
    logger.info(
        "_setup_kotak_streaming: session %s equity token=%s exchange=%s isIndex=%s",
        session.session_id, eq_token, eq_exchange, sym_is_index,
    )

    # Options tokens (when running an options session)
    if session.instrument_type == "options" and session.expiry:
        ce_strike = session.strike_ce or session.strike
        pe_strike = session.strike_pe or session.strike
        if session.right in (None, "CE") and ce_strike:
            try:
                ce_token, ce_exchange = ks.fetch_kotak_options_instrument_token(
                    session.symbol, session.expiry, ce_strike, "CE"
                )
                tokens.append(ce_token)
                exchanges.append(ce_exchange)
                rights.append("CE")
                is_indices.append(False)
                logger.info(
                    "_setup_kotak_streaming: session %s CE token=%s exchange=%s",
                    session.session_id, ce_token, ce_exchange,
                )
            except Exception as exc:
                logger.warning(
                    "_setup_kotak_streaming: session %s could not resolve CE token: %s",
                    session.session_id, exc,
                )
        if session.right in (None, "PE") and pe_strike:
            try:
                pe_token, pe_exchange = ks.fetch_kotak_options_instrument_token(
                    session.symbol, session.expiry, pe_strike, "PE"
                )
                tokens.append(pe_token)
                exchanges.append(pe_exchange)
                rights.append("PE")
                is_indices.append(False)
                logger.info(
                    "_setup_kotak_streaming: session %s PE token=%s exchange=%s",
                    session.session_id, pe_token, pe_exchange,
                )
            except Exception as exc:
                logger.warning(
                    "_setup_kotak_streaming: session %s could not resolve PE token: %s",
                    session.session_id, exc,
                )

    await asyncio.to_thread(ks.get_kotak_broadcaster().register,
        session.session_id, tokens, exchanges, rights,
        session.paper_tick_queue, loop,
        is_indices=is_indices,
    )
    session.kotak_streaming = True
    logger.info(
        "_setup_kotak_streaming: session %s registered %d tokens with KotakBroadcaster",
        session.session_id, len(tokens),
    )
    return True


async def _run_paper_session(session: SimulationSession) -> None:
    """
    Paper trading session loop.

    Phase 1 — Fast pre-session replay:
      Fetch today's configured historical data (up to last available second), then
      replay all ticks at near-instant speed so the chart is populated on connect.

    Phase 2 — Live streaming:
      Register with the shared MarketDataHub and its selected live provider.
      The feed pushes live OHLC dicts into session.paper_tick_queue.
      This loop reads those dicts, evaluates orders/strategies, and puts ticks
      on session.queue for SSE delivery — exactly as _run_session does.
    """
    # Background engines must not retain their originating HTTP request cache.
    from app.services.historical_data_service import detach_historical_operation, historical_operation
    detach_historical_operation(mode="live")
    session.state = SimulationState.RUNNING
    session.queue.phase = "phase1_fast_replay"
    phase1_started = time.monotonic()
    logger.info(
        "paper_phase1_started session_id=%s resumed=%s symbol=%s instrument_type=%s "
        "strike=%s strike_ce=%s strike_pe=%s expiry=%s right=%s",
        session.session_id, session.resumed_from_db, session.symbol, session.instrument_type,
        session.strike, session.strike_ce, session.strike_pe, session.expiry, session.right,
    )

    start_event = {
        "type": "session_started",
        "session_id": session.session_id,
        "trading_date": session.date,
        "start_time": session.start_time,
    }
    await session.queue.put(json.dumps(start_event))

    try:
        from app.services.market_data import start_session_feed
        await start_session_feed(session)
        session.paper_stream_source = None  # history is presentation, not a live quote
        await session.queue.put(json.dumps({"type": "feed_status", **session.market_feed_group.status()}))
        with historical_operation(mode="live"):
            # ── Phase 1: fast-replay historical data for today ────────────────────
            logger.info("Paper session %s: Phase 1 — fetching today's data for %s %s",
                        session.session_id, session.symbol, session.date)
            try:
                from app.services.broker_service import fetch_historical
                await asyncio.to_thread(fetch_historical, session.symbol, session.date)
                logger.info("Paper session %s: Phase 1 — equity data ready", session.session_id)
            except Exception as exc:
                logger.warning("Paper session %s: could not pre-fetch today's data: %s", session.session_id, exc)

            # Track the last Breeze tick timestamp so we know where the gap starts.
            _last_historical_ts: int = 0

            # Dual-stream options pre-replay
            if session.instrument_type == "options" and session.strike and session.expiry and session.right is None:
                from app.services.options_service import fetch_options_historical, options_iter_ticks
                ce_strike = session.strike_ce or session.strike
                pe_strike = session.strike_pe or session.strike
                logger.info("Paper session %s: Phase 1 — loading CE/PE tick dicts (strike CE=%s PE=%s expiry=%s)",
                            session.session_id, ce_strike, pe_strike, session.expiry)
                # Ensure today's parquet is available before loading ticks (defensive — soft_ensure
                # in the router already runs but may have been swallowed or used a different strike)
                try:
                    await asyncio.to_thread(fetch_options_historical, session.symbol, session.date, ce_strike, session.expiry, "CE")
                    await asyncio.to_thread(fetch_options_historical, session.symbol, session.date, pe_strike, session.expiry, "PE")
                except Exception as exc:
                    logger.warning("Paper session %s: Phase 1 options pre-fetch failed: %s", session.session_id, exc)
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
                        _last_historical_ts = ts
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

                # Configured historical gap-fill for the period between last Breeze data and now
                if _last_historical_ts > 0 and session.state != SimulationState.ENDED:
                    eq_gap = _historical_gap_ticks(session.symbol, session.date, _last_historical_ts)
                    ce_gap = _historical_gap_options_ticks(session.symbol, session.date, ce_strike, session.expiry, "CE", _last_historical_ts)
                    pe_gap = _historical_gap_options_ticks(session.symbol, session.date, pe_strike, session.expiry, "PE", _last_historical_ts)
                    logger.info("Paper session %s: Configured historical gap-fill — eq=%d CE=%d PE=%d",
                                session.session_id, len(eq_gap), len(ce_gap), len(pe_gap))
                    for tick in eq_gap:
                        if session.state == SimulationState.ENDED: break
                        session.last_price = tick["close"]
                        session.current_time = str(tick["time"])
                        _last_historical_ts = tick["time"]
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
                if getattr(session, "desktop_created", False) or str(getattr(session, "desktop_origin", "")).startswith("desktop_"):
                    from app.services.desktop_preparation import desktop_option_ticks as options_iter_ticks
                try:
                    for tick in options_iter_ticks(
                        session.symbol, session.date, session.strike,
                        session.expiry, session.right, session.start_time,
                    ):
                        if session.state == SimulationState.ENDED:
                            break
                        session.last_price = tick["close"]
                        _last_historical_ts = tick["time"]
                        fill_events = _emit_tick_and_check_orders(session, tick, session.right)
                        for fe in fill_events:
                            try:
                                session.queue.put_nowait(json.dumps(fe))
                            except asyncio.QueueFull:
                                pass
                        await asyncio.sleep(0.001)
                except Exception as exc:
                    logger.warning("Paper session %s: Phase 1 single-right pre-replay failed: %s", session.session_id, exc)

                # Configured historical equity gap-fill (single-right options; equity not replayed in this branch)
                if _last_historical_ts > 0 and session.state != SimulationState.ENDED:
                    for tick in _historical_gap_ticks(session.symbol, session.date, _last_historical_ts):
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
                        _last_historical_ts = tick["time"]
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

                # Configured historical gap-fill for equity
                if _last_historical_ts > 0 and session.state != SimulationState.ENDED:
                    gap_ticks = _historical_gap_ticks(session.symbol, session.date, _last_historical_ts)
                    if gap_ticks:
                        logger.info("Paper session %s: Configured historical equity gap-fill — %d ticks",
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

            logger.info(
                "paper_phase1_completed session_id=%s resumed=%s duration_seconds=%.3f last_historical_ts=%s",
                session.session_id, session.resumed_from_db, time.monotonic() - phase1_started,
                _last_historical_ts or "-",
            )
            if time.monotonic() - phase1_started >= 30:
                logger.warning(
                    "paper_phase1_slow session_id=%s duration_seconds=%.3f",
                    session.session_id, time.monotonic() - phase1_started,
                )

        # Live subscription ownership is shared across website and desktop.
        session.paper_base_contracts = {
            right: {"strike": session.strike_ce or session.strike if right == "CE" else session.strike_pe or session.strike, "expiry": session.expiry}
            for right in ("CE", "PE") if session.instrument_type == "options" and session.right in (None, right)
        }
        stream_source = session.market_feed_group.actual
        session.paper_stream_source = stream_source
        loop = asyncio.get_running_loop()
        for contract in getattr(session, "desktop_contracts", []):
            task = subscribe_desktop_option_contract(session, contract)
            if task:
                await task
        session.queue.phase = "phase3_live_stream"
        logger.info("paper_phase3_waiting session_id=%s source=%s", session.session_id, stream_source)
        _phase3_tick_count = 0
        _phase3_first_received = False
        _phase3_last_timeout_logged = 0.0
        while session.state != SimulationState.ENDED:
            await session.resume_event.wait()
            if session.state == SimulationState.ENDED:
                break

            try:
                payload = await asyncio.wait_for(session.paper_tick_queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                now = time.monotonic()
                if not _phase3_first_received and now - _phase3_last_timeout_logged >= 30:
                    _phase3_last_timeout_logged = now
                    logger.debug(
                        "breeze_live_no_tick_warning session_id=%s source=%s seconds_waiting=%.1f",
                        session.session_id, stream_source, now - phase1_started,
                    )
                continue  # normal during market close / weekend — no data, keep waiting

            if payload is None:  # queue closed — session stopping
                break

            _phase3_tick_count += 1
            if not _phase3_first_received:
                _phase3_first_received = True
                logger.info(
                    "paper_tick_queue_first_received session_id=%s source=%s right=%s time=%s",
                    session.session_id, stream_source, payload.get("right"), payload.get("time"),
                )

            if payload.get("type") == "tick" and payload.get("provider") and (payload["provider"] != session.market_feed_group.actual or payload.get("feed_generation", session.market_feed_group.generation) != session.market_feed_group.generation):
                continue
            watermarks = getattr(session, "_live_watermarks", {})
            instrument_id = payload.get("instrument_id", payload.get("right") or "equity")
            if payload.get("type") == "tick":
                history_key = (payload.get("right"), payload.get("strike"), payload.get("expiry"))
                history_time = getattr(session, "_history_watermarks", {}).get(history_key, 0)
                if int(payload["time"]) <= max(history_time, watermarks.get(instrument_id, 0)):
                    continue
                watermarks[instrument_id] = int(payload["time"])
                session._live_watermarks = watermarks
            status = session.market_feed_group.status()
            if status != getattr(session, "_last_feed_status", None):
                session._last_feed_status = status
                session.queue.put_nowait(json.dumps({"type": "feed_status", "session_id": session.session_id, **status}))
            session.paper_stream_source = session.market_feed_group.actual
            tick_right: str | None = payload.get("right")
            tick_type = payload.get("type", "tick")
            # Drop live ticks past market close (SEBI 15:15 effective 03 Aug 2026)
            tick_time = payload.get("time")
            if tick_time and tick_type == "tick":
                import pandas as _pd
                from app.config import get_market_close
                close_ts = int(_pd.Timestamp(f"{session.date} {get_market_close(session.date)}").timestamp())
                if tick_time >= close_ts:
                    continue
            if tick_type == "broker_error":
                # Forward connection-lost / reconnect-failed messages to the SSE stream.
                error_event = {"type": "broker_error", "message": payload.get("message", "Kite connection lost")}
                if payload.get("stream_gap"):
                    session.queue.put_nowait(json.dumps({"type": "stream_reset", "session_id": session.session_id}))
                try:
                    session.queue.put_nowait(json.dumps(error_event))
                except asyncio.QueueFull:
                    pass
                continue
            if tick_type != "tick":
                continue

            if tick_right and not payload.get("contract_key"):
                payload = {**session.paper_base_contracts.get(tick_right, {}), **payload}

            if tick_right == "CE" and not getattr(session, "desktop_live_stream_id", None) and ("strike" not in payload or payload["strike"] == session.strike_ce):
                session.last_price_ce = payload["close"]
            elif tick_right == "PE" and not getattr(session, "desktop_live_stream_id", None) and ("strike" not in payload or payload["strike"] == session.strike_pe):
                session.last_price_pe = payload["close"]
            elif tick_right is None:
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
        unexpected_end = session.state != SimulationState.ENDED
        if unexpected_end:
            logger.error("Paper session %s ended unexpectedly during %s; releasing its engine", session.session_id, getattr(session.queue, "phase", "unknown"))
        _stop_desktop_option_subscriptions(session)
        if session.stream_manager is not None:
            session.stream_manager.stop()
        session.state = SimulationState.ENDED
        end_event = {"type": "session_ended"}
        try:
            session.queue.put_nowait(json.dumps(end_event))
        except asyncio.QueueFull:
            pass
        if unexpected_end:
            try:
                stop_session(session, preserve_trading_state=getattr(session, "desktop_origin", None) != "desktop_paper")
            except Exception:
                logger.exception("Paper session %s cleanup failed after unexpected end", session.session_id)


async def _run_real_session(session: SimulationSession) -> None:
    """
    Real trading session: uses the same shared live-feed infrastructure as
    paper trading for chart data, but order execution goes to Kotak Neo.
    The wallet is pre-synced from Kotak at session start (handled in the router).
    Limit/Target triggered fills are forwarded to Kotak after local detection.
    """
    # Background engines must not retain their originating HTTP request cache.
    from app.services.historical_data_service import detach_historical_operation, historical_operation
    detach_historical_operation(mode="live")
    session.state = SimulationState.RUNNING
    from app.services.protection_recovery import resume
    await resume(session)
    from app.services.broker_conversion import resume as resume_conversions
    await resume_conversions(session)
    loop = asyncio.get_running_loop()
    from app.services.kotak_service import get_service as get_position_broker
    from app.services.broker_position_events import register as register_position_events
    register_position_events(session, get_position_broker(), loop)

    start_event = {
        "type": "session_started",
        "session_id": session.session_id,
        "trading_date": session.date,
        "start_time": session.start_time,
    }
    await session.queue.put(json.dumps(start_event))

    try:
        from app.services.market_data import start_session_feed
        await start_session_feed(session)
        session.paper_stream_source = None  # history is presentation, not a live quote
        await session.queue.put(json.dumps({"type": "feed_status", **session.market_feed_group.status()}))
        with historical_operation(mode="live"):
            # Phase 1: fast-replay today's historical data (same as paper)
            logger.info("Real session %s: Phase 1 — fetching today's data for %s",
                        session.session_id, session.symbol)
            try:
                from app.services.broker_service import fetch_historical
                await asyncio.to_thread(fetch_historical, session.symbol, session.date)
            except Exception as exc:
                logger.warning("Real session %s: could not pre-fetch today's data: %s", session.session_id, exc)

            _last_historical_ts: int = 0
            try:
                from app.services.data_loader import iter_ticks
                for tick in iter_ticks(session.symbol, session.date, session.start_time):
                    if session.state == SimulationState.ENDED:
                        break
                    session.last_price = tick["close"]
                    session.current_time = str(tick["time"])
                    _last_historical_ts = tick["time"]
                    fill_events = _emit_tick_and_check_orders_real(session, tick, None, loop)
                    for fe in fill_events:
                        try:
                            session.queue.put_nowait(json.dumps(fe))
                        except asyncio.QueueFull:
                            pass
                    await asyncio.sleep(0.001)
            except Exception as exc:
                logger.warning("Real session %s: Phase 1 pre-replay failed: %s", session.session_id, exc)

            # Configured historical gap fill
            if _last_historical_ts > 0 and session.state != SimulationState.ENDED:
                for tick in _historical_gap_ticks(session.symbol, session.date, _last_historical_ts):
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

        session.paper_stream_source = session.market_feed_group.actual
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

            if payload is None:  # queue closed — session stopping
                break

            tick_type = payload.get("type", "tick")
            if tick_type == "feed_status":
                session.queue.put_nowait(json.dumps({"type": "feed_status", "session_id": session.session_id, **session.market_feed_group.status()}))
                continue
            # Drop live ticks past market close (SEBI 15:15 effective 03 Aug 2026)
            tick_time = payload.get("time")
            if tick_time and tick_type == "tick":
                import pandas as _pd
                from app.config import get_market_close
                close_ts = int(_pd.Timestamp(f"{session.date} {get_market_close(session.date)}").timestamp())
                if tick_time >= close_ts:
                    continue
            if tick_type == "broker_error":
                error_event = {"type": "broker_error", "message": payload.get("message", "")}
                if payload.get("stream_gap"):
                    session.queue.put_nowait(json.dumps({"type": "stream_reset", "session_id": session.session_id}))
                try:
                    session.queue.put_nowait(json.dumps(error_event))
                except asyncio.QueueFull:
                    pass
                continue
            if tick_type != "tick":
                continue

            if payload.get("provider") != session.market_feed_group.actual or payload.get("feed_generation", session.market_feed_group.generation) != session.market_feed_group.generation:
                continue
            history_key = (payload.get("right"), payload.get("strike"), payload.get("expiry"))
            instrument_id = payload.get("instrument_id", payload.get("right") or "equity")
            watermarks = getattr(session, "_live_watermarks", {})
            if int(payload["time"]) <= max(getattr(session, "_history_watermarks", {}).get(history_key, 0), watermarks.get(instrument_id, 0)):
                continue
            watermarks[instrument_id] = int(payload["time"])
            session._live_watermarks = watermarks
            tick_right = payload.get("right")
            quotes = getattr(session, "_protection_quotes", {})
            quotes[(tick_right, payload.get("strike"), payload.get("expiry"))] = {**payload, "received_at": time.time()}
            session._protection_quotes = quotes
            if tick_right == "CE":
                session.last_price_ce = payload["close"]
            elif tick_right == "PE":
                session.last_price_pe = payload["close"]
            else:
                session.last_price = payload["close"]
            session.current_time = str(payload["time"])

            fill_events = _emit_tick_and_check_orders_real(session, payload, tick_right, loop)
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
        if session.stream_manager is not None:
            session.stream_manager.stop()
        session.state = SimulationState.ENDED
        end_event = {"type": "session_ended"}
        try:
            session.queue.put_nowait(json.dumps(end_event))
        except asyncio.QueueFull:
            pass


def _is_position_exit(session, order) -> bool:
    """Classify against the exact held contract, independently of UI stoploss flags."""
    from app.services.trading import get_position
    position = get_position(session.session_id, session.symbol, right=order.right,
                            strike=order.strike, expiry=order.expiry)
    return position.quantity > 0 and (
        (position.side == "LONG" and order.side.value == "SELL") or
        (position.side == "SHORT" and order.side.value == "BUY")
    )


def _register_kotak_sl_for_order(session: SimulationSession, order: Any, loop: Any, *, attach_only: bool = False) -> None:
    """
    Place a closing STOPLOSS or LIMIT on Kotak and register fill/reject callbacks.
    Entry orders remain local. The historical helper name is retained for strategies.
    """
    from app.services.kotak_service import get_service as get_kotak, KotakError
    from app.services.trading import record_trade, settle_wallet_for_trade
    from app.services import order_service
    from app.models.schemas import OrderStatus

    kotak_svc = get_kotak()
    from app.models.schemas import OrderType
    if attach_only:
        kotak_order_id = order.kotak_order_id
        if not kotak_order_id:
            return
    else:
        if order.kotak_order_id:
            return
        if not _is_position_exit(session, order):
            return  # Entry triggers remain local until live data triggers execution.
        trigger = order.trigger_price
        # Legacy local protection is priced once on first broker submission.
        if order.order_type == OrderType.STOPLOSS and order.execution_gap_pct is None:
            from app.services.execution_price_service import reprice_trigger
            reprice_trigger(order)
        kotak_limit = order.limit_price

        side = "B" if order.side.value == "BUY" else "S"
        kwargs = dict(symbol=session.symbol, side=side, qty=order.quantity)
        if order.right:
            kwargs.update(right=order.right,
                          strike=order.strike if order.strike is not None else session.strike,
                          expiry=order.expiry or session.expiry)
        if order.order_type == OrderType.LIMIT:
            method = kotak_svc.place_options_limit_order if order.right else kotak_svc.place_limit_order
            kotak_order_id = method(**kwargs, price=order.limit_price)
        elif order.order_type == OrderType.STOPLOSS:
            method = kotak_svc.place_options_sl_order if order.right else kotak_svc.place_sl_order
            kotak_order_id = method(**kwargs, trigger_price=trigger, limit_price=kotak_limit)
        else:
            return

    if not attach_only:
        order.execution_role = "exit"
    order.kotak_order_id = kotak_order_id
    session.kotak_order_map[order.order_id] = kotak_order_id
    order_service._write_order_to_db(order)

    from app.services.broker_order_service import register_callbacks
    register_callbacks(session, order, kotak_svc, loop)
    logger.info(
        "broker_exit_placed order=%s kotak_id=%s type=%s",
        order.order_id, kotak_order_id, order.order_type.value,
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
    from app.services.trading import record_trade, settle_wallet_for_trade
    if getattr(session, "broker_refresh_events", None) is not None:
        return []
    from app.services.kotak_service import get_service as get_kotak, KotakError
    from app.models.schemas import OrderType

    try:
        session.queue.put_nowait(json.dumps({**tick, "session_id": session.session_id}))
    except asyncio.QueueFull:
        logger.warning("Queue full, dropping tick for real session %s", session.session_id)

    if getattr(session, "market_feed_group", None) and not tick.get("provider"):
        key = (tick_right, tick.get("strike"), tick.get("expiry"))
        marks = getattr(session, "_history_watermarks", {})
        marks[key] = max(marks.get(key, 0), int(tick["time"]))
        session._history_watermarks = marks
        return []

    current_time = tick["time"]
    current_price = tick["close"]
    triggered = check_orders(
        session.session_id, current_price, current_time, session.date,
        tick_right=tick_right,
        tick_strike=tick.get("strike"),
        tick_expiry=tick.get("expiry"),
        settle_wallet=False,
    )

    fill_events: list[dict] = []
    kotak_svc = get_kotak()

    for order in triggered:
        # SL orders placed on Kotak at creation time; fill comes via WebSocket.
        # For LIMIT/TARGET, forward to Kotak now as a market-ish limit order.
        if order.kotak_order_id:
            # Already placed on Kotak — the fill will arrive via order-feed WebSocket.
            continue

        # Forward triggered LIMIT/TARGET to Kotak as limit order
        side_code = "B" if order.side.value == "BUY" else "S"
        kotak_price = order.limit_price

        try:
            from app.services.real_trading_day import require_entry_allowed
            from fastapi import HTTPException
            try:
                require_entry_allowed(session, order.side, order.quantity, order.right, order.strike, order.expiry)
            except HTTPException as exc:
                raise KotakError(str(exc.detail)) from exc
            if order.right and session.instrument_type == "options":
                kotak_order_id = kotak_svc.place_options_limit_order(
                    symbol=session.symbol,
                    right=order.right,
                    strike=order.strike if order.strike is not None else session.strike,
                    expiry=order.expiry or session.expiry,
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
            order.kotak_order_id = kotak_order_id
            order.execution_role = order.execution_role or "entry"
            from app.models.schemas import OrderStatus
            order.status = OrderStatus.PENDING
            order.filled_at = None
            order.filled_price = None
            from app.services.order_service import _write_order_to_db
            _write_order_to_db(order)
            logger.info(
                "Real session %s: forwarded triggered %s order %s to Kotak (kotak_id=%s price=%.2f)",
                session.session_id, order.order_type.value, order.order_id, kotak_order_id, kotak_price,
            )

            order.execution_role = order.execution_role or "entry"
            from app.services.broker_order_service import register_callbacks
            register_callbacks(session, order, kotak_svc, loop)

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
                from app.services import order_service
                order_service._credit_reservation(order, order.reserved_amount, session.date)
                order.reserved_amount = 0.0
            from app.services.order_service import _write_order_to_db
            _write_order_to_db(order)
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
        from app.services.order_service import get_open_orders, get_order, OrderStatus
        running_before = {s.strategy_id: s for s in strategy_service.list_running(session.session_id)}
        before_ids = {o.order_id for o in get_open_orders(session.session_id)}
        strategy_service.on_tick(session, tick, tick_right, loop=loop)
        after_open_orders = get_open_orders(session.session_id)
        after_ids = {o.order_id for o in after_open_orders}
        # Emit cancellation events for orders the strategy cancelled
        for order_id in before_ids - after_ids:
            o = get_order(session.session_id, order_id)
            if o and o.status == OrderStatus.CANCELLED:
                fill_events.append({"type": "order_cancelled", "order_id": order_id})
        # Emit placed events for new strategy orders
        for new_order in after_open_orders:
            if new_order.order_id not in before_ids:
                if not new_order.kotak_order_id and new_order.order_type in (OrderType.LIMIT, OrderType.STOPLOSS):
                    try:
                        _register_kotak_sl_for_order(session, new_order, loop)
                    except Exception as exc:
                        from app.services import order_service
                        order_service.cancel_order(session.session_id, new_order.order_id, session.date)
                        logger.warning("broker_strategy_exit_failed order=%s: %s", new_order.order_id, exc)
                        fill_events.append({"type": "broker_error", "message": f"Broker exit placement failed: {exc}"})
                        continue
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
                    "is_autostop": new_order.is_autostop,
                    "right": new_order.right,
                    "strike": new_order.strike,
                })
        # Emit completion events for strategies that just finished
        running_after_ids = {s.strategy_id for s in strategy_service.list_running(session.session_id)}
        for sid, strat in running_before.items():
            if sid not in running_after_ids:
                fill_events.append({"type": "strategy_completed", "strategy_id": sid, "right": strat.right})
    except Exception as exc:
        logger.warning("strategy eval error for real session %s: %s", session.session_id, exc)

    # AI bar-close hook (Phase XI)
    if session.ai_commands_active:
        try:
            _check_and_schedule_ai_hook(session, tick, tick_right, asyncio.get_running_loop())
        except RuntimeError:
            pass

    return fill_events


_AI_MAX_BARS = 15


def _backfill_bar_history(
    session: "SimulationSession",
    right: Optional[str],
    current_slot_ts: int,
) -> list[dict]:
    """
    Build the bar history that would have accumulated if ai_commands_active had
    been set from session start. Called once per (session, right) on first tick.
    Returns up to _AI_MAX_BARS completed candles, oldest-first, in the same
    ISO-string time format used by the live closed_bar entries.

    For paper/real sessions: fetches from the configured historical provider (up to current IST
    time) so bars that arrived via live streaming after session start are
    included. For simulation: reads the local Breeze parquet file.

    Non-fatal — returns [] on any error so the trading path is never blocked.
    """
    try:
        import pandas as pd
        from app.services.data_loader import resample_to_candles, candles_to_records

        interval_minutes: int = getattr(session, "strategy_interval_secs", 180) // 60
        is_live = session.session_type in ("paper", "real")

        market_open = pd.Timestamp(f"{session.date} 09:15:00", tz="UTC")
        slot_dt = datetime.fromtimestamp(current_slot_ts, tz=timezone.utc)
        slot_boundary = pd.Timestamp(slot_dt)

        if right is None:
            if is_live:
                from app.services.historical_data_service import load_history
                df = load_history(session.symbol, session.date, mode="live").frame
            else:
                from app.services.data_loader import load_dataframe
                df = load_dataframe(session.symbol, session.date)
        else:
            strike = session.strike_ce if right == "CE" else session.strike_pe
            if not strike or not session.expiry:
                return []
            if is_live:
                from app.services.historical_data_service import load_history
                df = load_history(session.symbol, session.date, strike, session.expiry, right, mode="live").frame
            else:
                from app.services.options_service import load_options_dataframe
                df = load_options_dataframe(session.symbol, session.date, strike, session.expiry, right)

        if df.index.tzinfo is None:
            df.index = df.index.tz_localize("UTC")

        window = df[(df.index >= market_open) & (df.index < slot_boundary)]
        if window.empty:
            return []

        candles = resample_to_candles(window, interval_minutes)
        records = candles_to_records(candles)

        result = [
            {
                "time": datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
                "open": r["open"],
                "high": r["high"],
                "low": r["low"],
                "close": r["close"],
            }
            for r in records
        ]
        return result[-_AI_MAX_BARS:]
    except Exception as exc:
        logger.warning(
            "_backfill_bar_history failed for session %s right=%s: %s",
            session.session_id, right, exc,
        )
        return []


def _check_and_schedule_ai_hook(
    session: SimulationSession,
    tick: dict,
    tick_right: Optional[str],
    loop: asyncio.AbstractEventLoop,
) -> None:
    """
    Track per-right bar OHLC state. When a bar closes, schedule a fire-and-forget
    POST to aihelper /hook/bar-close. Called from both tick-emit functions.
    """
    ts: int = tick["time"]
    interval: int = getattr(session, "strategy_interval_secs", 180)
    slot: int = (ts // interval) * interval

    tracker = session._ai_bar_tracker.get(tick_right)
    if tracker is None:
        session._ai_bar_tracker[tick_right] = {
            "slot": slot,
            "open": tick["open"],
            "high": tick["high"],
            "low": tick["low"],
            "close": tick["close"],
            "history": _backfill_bar_history(session, tick_right, slot),
        }
        return

    if slot != tracker["slot"]:
        # Previous bar just closed — record it
        closed_bar = {
            "time": datetime.fromtimestamp(tracker["slot"], tz=timezone.utc).isoformat(),
            "open": tracker["open"],
            "high": tracker["high"],
            "low": tracker["low"],
            "close": tracker["close"],
        }
        history: list = tracker["history"]
        history.append(closed_bar)
        if len(history) > _AI_MAX_BARS:
            history.pop(0)

        loop.create_task(
            _fire_bar_close_hook(session, tick_right, list(history), slot)
        )

        # Reset for the new bar
        tracker["slot"] = slot
        tracker["open"] = tick["open"]
        tracker["high"] = tick["high"]
        tracker["low"] = tick["low"]
        tracker["close"] = tick["close"]
    else:
        tracker["high"] = max(tracker["high"], tick["high"])
        tracker["low"] = min(tracker["low"], tick["low"])
        tracker["close"] = tick["close"]


async def _fire_bar_close_hook(
    session: SimulationSession,
    right: Optional[str],
    bars: list[dict],
    slot_ts: int,
) -> None:
    """
    Fire-and-forget POST to aihelper /hook/bar-close.
    100 ms timeout — errors are swallowed so the trading path is never blocked.
    """
    from app.config import AI_HELPER_URL
    import httpx

    from app.services import user_settings_service
    from app.services import trading as trading_svc
    user_settings = user_settings_service.get_settings(session.user_id)

    position_dict: dict | None = None
    try:
        pos = trading_svc.get_position(session.session_id, symbol=session.symbol, right=right)
        if pos.side != "FLAT" and pos.quantity > 0:
            last_close = bars[-1]["close"] if bars else 0.0
            pnl_pct = 0.0
            if pos.avg_entry_price > 0 and last_close > 0:
                if pos.side == "LONG":
                    pnl_pct = (last_close - pos.avg_entry_price) / pos.avg_entry_price * 100
                else:
                    pnl_pct = (pos.avg_entry_price - last_close) / pos.avg_entry_price * 100
            position_dict = {
                "side": pos.side,
                "qty": pos.quantity,
                "avg_entry": pos.avg_entry_price,
                "unrealized_pnl_pct": round(pnl_pct, 2),
            }
    except Exception:
        logger.debug(
            "Failed to resolve position for bar-close hook: session=%s right=%s",
            session.session_id, right,
        )

    # Include NIFTY underlying bars for CE/PE hooks so cross-symbol commands can reference them
    underlying_bars: list[dict] = []
    if right in ("CE", "PE"):
        nifty_tracker = session._ai_bar_tracker.get(None)
        if nifty_tracker and nifty_tracker.get("history"):
            underlying_bars = list(nifty_tracker["history"])

    payload = {
        "user_id": session.user_id,
        "session_id": session.session_id,
        "symbol": session.symbol,
        "right": right,
        "bars": bars,
        "underlying_bars": underlying_bars,
        "position": position_dict,
        "timestamp": datetime.fromtimestamp(slot_ts, tz=timezone.utc).isoformat(),
        "session_type": session.session_type,
        "funds_ratios": {
            "ratio_l": user_settings["funds_ratio_l_pct"],
            "ratio_m": user_settings["funds_ratio_m_pct"],
            "ratio_h": user_settings["funds_ratio_h_pct"],
        },
    }
    try:
        async with httpx.AsyncClient(timeout=0.1) as client:
            await client.post(f"{AI_HELPER_URL}/hook/bar-close", json=payload)
        logger.debug(
            "bar-close hook sent: session=%s right=%s bars=%d",
            session.session_id, right, len(bars),
        )
    except Exception as exc:
        logger.debug("bar-close hook failed (session %s): %s", session.session_id, exc)


def start_session(session: SimulationSession) -> None:
    loop = asyncio.get_running_loop()
    if session.session_type == "paper":
        session.task = loop.create_task(_run_paper_session(session))
    elif session.session_type == "real":
        from app.services import order_service
        from app.services.entry_sl_watcher import on_entry_filled
        for order in order_service.get_all_orders(session.session_id):
            if order.kotak_order_id and order.status.value == "PENDING":
                _register_kotak_sl_for_order(session, order, loop, attach_only=True)
            if order.execution_role != "exit" and order.broker_filled_quantity and (order.entry_sl_price is not None or order.is_autostop):
                on_entry_filled(order, session, loop)
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


def stop_session(session: SimulationSession, *, preserve_trading_state: bool = False) -> None:
    logger.info("session_stop_begin session_id=%s type=%s lease_lost=%s preserve_trading_state=%s",
        session.session_id, session.session_type, getattr(session, "paper_lease_lost", False), preserve_trading_state)
    if session.session_type == "real":
        preserve_trading_state = True
    desktop_paper = getattr(session, "desktop_origin", None) == "desktop_paper"
    cleanup_owned = not getattr(session, "paper_lease_lost", False)
    if desktop_paper:
        from app.services import paper_wallet
        try:
            claim = paper_wallet.session_claim(session.user_id, session.date, session.symbol)
            # A replaced engine must not cancel the new owner's orders.
            cleanup_owned = bool(claim and claim.get("session_id") == session.session_id and
                (claim.get("session_status") == "stopped" or
                 (claim.get("session_status") == "running" and claim.get("engine_token") == getattr(session, "paper_engine_token", None))))
            if cleanup_owned and claim.get("session_status") == "running":
                paper_wallet.stop_desktop_session(session.user_id, session.date, session.symbol, session.session_id)
        except Exception:
            logger.exception("Could not persist desktop Paper stop for %s", session.session_id)
            cleanup_owned = False
    try:
        current_task = asyncio.current_task()
    except RuntimeError:
        current_task = None
    lease_task = getattr(session, "paper_engine_task", None)
    if lease_task:
        if lease_task is not current_task:
            lease_task.cancel()
    if session.session_type == "real":
        from app.services.kotak_service import get_service as get_event_broker
        from app.services.broker_position_events import stop as stop_position_events
        from app.services.broker_conversion import stop as stop_conversions
        stop_position_events(session, get_event_broker())
        stop_conversions(session)
    session.state = SimulationState.ENDED
    session.resume_event.set()  # unblock if paused
    session.step_event.set()    # unblock if waiting for next-bar (stepwise)
    session.queue.close()       # unblock any waiting SSE get() consumers
    session.paper_tick_queue.close()
    _stop_desktop_option_subscriptions(session)
    if session.task and session.task is not current_task and not session.task.done():
        session.task.cancel()
    if cleanup_owned:
        _upsert_session_to_db(session)
    _sessions.pop(session.session_id, None)
    logger.info("session_removed_from_memory session_id=%s", session.session_id)
    # Stop live streaming for paper and real sessions
    if session.session_type in ("paper", "real"):
        if session.stream_manager is not None:
            # BreezeStreamManager (primary or fallback)
            logger.info(
                "stop_session %s: stopping BreezeStreamManager", session.session_id,
            )
            try:
                session.stream_manager.stop()
            except Exception as exc:
                logger.warning(
                    "BreezeStreamManager stop error for %s: %s", session.session_id, exc,
                )
        elif session.fyers_streaming:
            # FyersBroadcaster — unregister this session
            logger.info(
                "stop_session %s: unregistering from FyersBroadcaster", session.session_id,
            )
            try:
                from app.services.fyers_service import get_fyers_broadcaster
                get_fyers_broadcaster().unregister(session.session_id)
            except Exception as exc:
                logger.warning(
                    "FyersBroadcaster unregister error for %s: %s", session.session_id, exc,
                )
        elif session.kotak_streaming:
            # KotakBroadcaster — unregister this session
            logger.info(
                "stop_session %s: unregistering from KotakBroadcaster", session.session_id,
            )
            try:
                from app.services.kotak_service import get_kotak_broadcaster
                get_kotak_broadcaster().unregister(session.session_id)
            except Exception as exc:
                logger.warning(
                    "KotakBroadcaster unregister error for %s: %s", session.session_id, exc,
                )
        else:
            # KiteBroadcaster — unregister this session
            logger.info(
                "stop_session %s: unregistering from KiteBroadcaster", session.session_id,
            )
            try:
                from app.services.kite_service import get_broadcaster
                get_broadcaster().unregister(session.session_id)
            except Exception as exc:
                logger.warning(
                    "Kite unregister error for %s: %s", session.session_id, exc,
                )
    # Cancel and clean up any running strategies
    try:
        from app.services import strategy_service
        if cleanup_owned and not preserve_trading_state:
            strategy_service.cancel_all(session.session_id)
        strategy_service.clear_session(session.session_id)
    except Exception as exc:
        logger.warning("Could not cancel strategies for session %s: %s", session.session_id, exc)

    # Cancel pending orders and refund reserved wallet amounts (prevents phantom wallet deductions
    # when session is restarted with a new session_id and old pending orders become invisible).
    try:
        from app.services import order_service
        cancelled = order_service.cancel_all_pending_orders(session.session_id, session.date) if cleanup_owned and not preserve_trading_state else 0
        if session.session_type != "real":
            order_service.clear_session(session.session_id)
        if cancelled:
            logger.info(
                "stop_session %s: cancelled %d pending orders, wallet refunded",
                session.session_id, cancelled,
            )
    except Exception as exc:
        logger.warning("Could not cancel orders for session %s: %s", session.session_id, exc)

    # Cancel AI commands in aihelper (synchronous — must complete before stop_session returns
    # so a racing bar-close hook cannot fire after session is torn down).
    # Failure must NOT block session stop — log and continue.
    if session.ai_commands_active:
        from app.config import AI_HELPER_URL
        import httpx
        try:
            with httpx.Client(timeout=2.0) as client:
                client.post(f"{AI_HELPER_URL}/hook/session/{session.session_id}/stop")
            logger.info("aihelper session-stop hook sent for %s", session.session_id)
        except Exception as exc:
            logger.warning(
                "aihelper session-stop hook failed for %s (continuing): %s",
                session.session_id, exc,
            )
    if getattr(session, "paper_engine_token", None) and not desktop_paper and not getattr(session, "paper_lease_lost", False):
        from app.services.paper_wallet import renew_engine
        renew_engine(session.user_id, session.date, session.symbol, session.paper_engine_token, stop=True)
