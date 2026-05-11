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
    instrument_type: str = "equity"   # "equity" or "options"
    strike: int | None = None          # required when instrument_type="options"
    expiry: str | None = None          # YYYY-MM-DD; required when instrument_type="options"
    right: str | None = None           # "CE" or "PE"; required when instrument_type="options"


class SimulationStartResponse(BaseModel):
    session_id: str
    symbol: str
    date: str
    start_time: str
    speed: float
    session_capital: float = 0.0
    instrument_type: str = "equity"
    strike: int | None = None
    expiry: str | None = None
    right: str | None = None


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
    instrument_type: str = "equity"
    strike: int | None = None
    expiry: str | None = None
    right: str | None = None


class Position(BaseModel):
    symbol: str
    quantity: int
    avg_entry_price: float
    side: Literal["LONG", "SHORT", "FLAT"]


class TradeRequest(BaseModel):
    session_id: str
    right: str | None = None  # "CE" or "PE" for options sessions; None for equity


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
    right: str | None = None  # "CE" or "PE" for options ticks; None for equity


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
    TARGET = "TARGET"    # stop-limit: trigger then fill; limit auto-set at 1% from trigger
    LIMIT = "LIMIT"      # plain limit: fill when price reaches the limit price directly
    STOPLOSS = "STOPLOSS"  # stoploss exit: same trigger logic as TARGET, no wallet effect


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
    reserved_amount: float = 0.0  # wallet amount debited on BUY placement; 0 for SELL
    is_stoploss: bool = False      # SL orders skip all wallet debit/credit
    right: str | None = None       # "CE" or "PE" for options orders; None for equity


class PlaceOrderRequest(BaseModel):
    session_id: str
    side: TradeSide
    order_type: OrderType = OrderType.TARGET
    trigger_price: float | None = None   # required for TARGET / STOPLOSS
    limit_price: float | None = None     # required for LIMIT; auto-computed for TARGET
    quantity: int | None = None          # required when funds_ratio_pct is None
    funds_ratio_pct: float | None = None  # 0–1 fraction; backend computes quantity
    is_stoploss: bool = False
    right: str | None = None             # "CE" or "PE" for options orders; None for equity


class OrderFilledEvent(BaseModel):
    type: Literal["order_filled"] = "order_filled"
    order_id: str
    side: str
    quantity: int
    trigger_price: float
    filled_price: float
    filled_at: int


class PriceAtResponse(BaseModel):
    symbol: str
    date: str
    time: str
    price: float


class ExpiryResponse(BaseModel):
    symbol: str
    date: str
    expiry: str


class WalletResponse(BaseModel):
    user_id: str
    date: str
    balance: float


class WalletResetRequest(BaseModel):
    amount: float = 150_000.0
