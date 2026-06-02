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
    strike: int | None = None          # ATM/reference strike; required when instrument_type="options"
    expiry: str | None = None          # YYYY-MM-DD; required when instrument_type="options"
    right: str | None = None           # "CE" or "PE"; required when instrument_type="options"
    strike_ce: int | None = None       # CE streaming strike (defaults to strike when omitted)
    strike_pe: int | None = None       # PE streaming strike (defaults to strike when omitted)
    brokerage_per_order: float = 1.0   # flat brokerage deducted per trade (user-configurable)
    strategy_interval_secs: int = 180  # candle interval for all strategies (180=3min, 300=5min)
    session_type: str = "sim"          # "sim" (historical replay), "paper" (live data), or "real" (Kotak live orders)


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
    strike_ce: int | None = None
    strike_pe: int | None = None
    brokerage_per_order: float = 1.0
    session_type: str = "sim"


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
    commission: float = 0.0  # computed at record time: exchange charges + brokerage
    session_type: str = "sim"  # "sim" or "paper" — inherited from parent session


class Position(BaseModel):
    symbol: str
    quantity: int
    avg_entry_price: float
    side: Literal["LONG", "SHORT", "FLAT"]
    entry_commission: float = 0.0  # sum of commissions for the open lots (FIFO-apportioned)


class TradeRequest(BaseModel):
    session_id: str
    right: str | None = None  # "CE" or "PE" for options sessions; None for equity
    funds_ratio_pct: float | None = None  # 0.0–1.0; when provided, overrides default lot-size quantity


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
    strike: int | None = None      # options strike price; None for equity
    kotak_order_id: str | None = None  # set for real-session orders placed on Kotak


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
    strike: int | None = None            # options strike; populated server-side from session when omitted
    target_deviation_pct: float = 0.01   # deviation used to compute limit from trigger for TARGET orders


class UpdateOrderRequest(BaseModel):
    trigger_price: float | None = None    # new trigger price (TARGET / STOPLOSS)
    limit_price: float | None = None      # new limit price (LIMIT orders)
    target_deviation_pct: float = 0.01   # deviation for recomputing TARGET limit from new trigger


class UpdatePaneStrikeRequest(BaseModel):
    right: str   # "CE" or "PE"
    strike: int


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


# ── User Settings ─────────────────────────────────────────────────────────────

class UserSettingsResponse(BaseModel):
    historical_days: int = 2
    funds_ratio_l_pct: float = 0.03
    funds_ratio_m_pct: float = 0.06
    funds_ratio_h_pct: float = 0.12


class UserSettingsUpdateRequest(BaseModel):
    historical_days: int = Field(default=2, ge=1, le=5)
    funds_ratio_l_pct: float | None = Field(default=None, ge=0.001, le=1.0)
    funds_ratio_m_pct: float | None = Field(default=None, ge=0.001, le=1.0)
    funds_ratio_h_pct: float | None = Field(default=None, ge=0.001, le=1.0)


# ── Strategies ────────────────────────────────────────────────────────────────

class StrategyType(str, Enum):
    AUTO_STOP = "AutoStop"
    BREAK_EVEN = "BreakEven"
    AGGRESSIVE_STOPLOSS = "AggressiveStoploss"
    TARGET_PROFIT = "TargetProfit"


class StartStrategyRequest(BaseModel):
    session_id: str
    strategy_type: StrategyType
    right: str | None = None              # "CE" | "PE" | None (equity)
    # Sizing for entry strategies (AutoStop): supply one of these
    quantity: int | None = None
    funds_ratio_pct: float | None = None  # 0.0–1.0 fraction of session capital
    # Direction for AutoStop (equity only; options sessions always use BUY)
    direction: str = "BUY"               # "BUY" | "SELL"
    # AutoStop trigger settings
    autostop_trigger_type: str = "bar"    # "bar" (high/low) | "deviation" (% from close)
    autostop_deviation_pct: float = 1.0   # % deviation from close (only when type=deviation)
    # AggressiveStoploss settings
    only_in_profit: bool = False          # skip SL update when close is at a loss
    # TargetProfit settings
    target_profit_value: float | None = None   # absolute price or % of capital
    target_profit_is_pct: bool = False         # True = % of session capital; False = absolute price
    target_profit_buffer_ticks: int = 3        # ticks past target to trigger (1–5)
    # Breakeven mode
    breakeven_mode: str = "shift_sl"           # "shift_sl" | "limit_order"


class StrategyResponse(BaseModel):
    strategy_id: str
    strategy_type: str
    symbol: str
    right: str | None
    status: str


class CancelAllStrategiesRequest(BaseModel):
    session_id: str


# ── Kotak Neo / Real Trading ──────────────────────────────────────────────────

class KotakLoginRequest(BaseModel):
    totp: str


class KotakStatusResponse(BaseModel):
    authenticated: bool
    broker: str = "KotakNeo"


class KotakFundsResponse(BaseModel):
    balance: float


class WhitelistAddRequest(BaseModel):
    email: str


class WhitelistEntry(BaseModel):
    email: str
    user_id: str | None = None
    added_at: str | None = None


# ── GuardRails ────────────────────────────────────────────────────────────────

class GuardRailSettingsResponse(BaseModel):
    guardrail_block_bars: int = 3
    guardrail_cooldown_block_bars: int = 3
    guardrail_cooldown_losses: int = 3
    guardrail_ban_capital_pct: float = 10.0
    guardrail_ban_loss_trade_pct: float = 60.0
    guardrail_ban_enabled: bool = False
    guardrail_cooldown_enabled: bool = False


class GuardRailSettingsUpdateRequest(BaseModel):
    guardrail_block_bars: int | None = Field(default=None, ge=1, le=20)
    guardrail_cooldown_block_bars: int | None = Field(default=None, ge=1, le=20)
    guardrail_cooldown_losses: int | None = Field(default=None, ge=1, le=20)
    guardrail_ban_capital_pct: float | None = Field(default=None, ge=1.0, le=100.0)
    guardrail_ban_loss_trade_pct: float | None = Field(default=None, ge=1.0, le=100.0)
    guardrail_ban_enabled: bool | None = None
    guardrail_cooldown_enabled: bool | None = None


class GuardRailStatusResponse(BaseModel):
    block_active: bool
    block_until_bar: int
    ban_active: bool
    cooldown_enabled: bool
    consecutive_losses: int
    settings: GuardRailSettingsResponse


class TriggerBlockRequest(BaseModel):
    session_id: str
