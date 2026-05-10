from __future__ import annotations
from enum import Enum
from typing import Literal
from pydantic import BaseModel, Field
import uuid


class TradeSide(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class SimulationState(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    ENDED = "ended"


class SimulationStartRequest(BaseModel):
    symbol: str = "NIFTY"
    date: str = "2026-05-06"
    start_time: str = "09:15:00"
    speed: float = Field(default=1.0, ge=0.05, le=100.0)


class SimulationStartResponse(BaseModel):
    session_id: str
    symbol: str
    date: str
    start_time: str
    speed: float


class SimulationControlRequest(BaseModel):
    session_id: str


class SimulationStatusResponse(BaseModel):
    session_id: str
    state: SimulationState
    current_time: str | None
    speed: float
    symbol: str
    date: str


class Trade(BaseModel):
    trade_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    symbol: str
    side: TradeSide
    quantity: int
    price: float
    timestamp: int
    session_id: str


class Position(BaseModel):
    symbol: str
    quantity: int
    avg_entry_price: float
    side: Literal["LONG", "SHORT", "FLAT"]


class TradeRequest(BaseModel):
    session_id: str


class OHLCCandle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float


class HistoricalDataResponse(BaseModel):
    symbol: str
    dates: list[str]
    candles: list[OHLCCandle]


class TickEvent(BaseModel):
    type: Literal["tick"] = "tick"
    time: int
    open: float
    high: float
    low: float
    close: float


class SessionEvent(BaseModel):
    type: str
    session_id: str | None = None
    trading_date: str | None = None
    start_time: str | None = None
