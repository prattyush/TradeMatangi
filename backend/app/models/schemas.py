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
    date: str
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


class SymbolInfo(BaseModel):
    symbol: str
    display_name: str


class SymbolsResponse(BaseModel):
    symbols: list[SymbolInfo]


class AvailableDatesResponse(BaseModel):
    symbol: str
    dates: list[str]


class PreSessionDataResponse(BaseModel):
    symbol: str
    date: str
    start_time: str
    candles: list[OHLCCandle]


class OrderStatus(str, Enum):
    PENDING = "PENDING"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"


class OrderType(str, Enum):
    TARGET = "TARGET"  # internally a stop-limit; limit auto-set at 1% from trigger


class Order(BaseModel):
    order_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    user_id: str
    symbol: str
    side: TradeSide
    order_type: OrderType = OrderType.TARGET
    quantity: int
    trigger_price: float
    limit_price: float
    status: OrderStatus = OrderStatus.PENDING
    created_at: int  # Unix timestamp
    filled_at: int | None = None
    filled_price: float | None = None


class PlaceOrderRequest(BaseModel):
    session_id: str
    side: TradeSide
    trigger_price: float
    quantity: int = 1


class OrderFilledEvent(BaseModel):
    type: Literal["order_filled"] = "order_filled"
    order_id: str
    side: str
    quantity: int
    trigger_price: float
    filled_price: float
    filled_at: int
