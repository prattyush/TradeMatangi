import { BACKEND_URL, AI_HELPER_URL } from '../config'

function _authHeaders(): Record<string, string> {
  try {
    const stored = localStorage.getItem('auth_user')
    if (stored) {
      const { userId } = JSON.parse(stored)
      if (userId) return { 'X-User-Id': userId }
    }
  } catch {}
  return {}
}

export interface OHLCCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface ChartStructureItem {
  chart_structure_id: string
  symbol: string
  date: string
  opening_type: string
  midday_type: string
  closing_type: string
  is_predefined: boolean
  user_id: string
  created_at: string
  updated_at: string
  can_delete: boolean
}

export interface TickEvent {
  type: 'tick'
  time: number
  open: number
  high: number
  low: number
  close: number
  right?: string   // "CE" or "PE" for options dual-stream; undefined for equity
}

export interface BarCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface SymbolInfo {
  symbol: string
  display_name: string
}

export interface Order {
  order_id: string
  session_id: string
  user_id: string
  symbol: string
  side: 'BUY' | 'SELL'
  order_type: 'TARGET' | 'LIMIT' | 'STOPLOSS'
  quantity: number
  trigger_price: number
  limit_price: number
  status: 'PENDING' | 'FILLED' | 'CANCELLED'
  created_at: number
  filled_at: number | null
  filled_price: number | null
  is_stoploss: boolean
  right?: string         // "CE" or "PE" for options orders
  strike?: number | null // options strike; null for equity or old orders (backward-compat)
}

export interface HistoricalDataResponse {
  symbol: string
  dates: string[]
  candles: OHLCCandle[]
}

export interface SimulationStartRequest {
  symbol?: string
  date?: string
  start_time?: string
  speed?: number
  instrument_type?: 'equity' | 'options'
  strike?: number
  expiry?: string   // YYYY-MM-DD
  // right is omitted for dual-stream options (backend streams both CE and PE)
  strike_ce?: number  // CE streaming strike (OTM direction: ATM + offset)
  strike_pe?: number  // PE streaming strike (OTM direction: ATM - offset)
  brokerage_per_order?: number  // flat brokerage per order (default 1)
  strategy_interval_secs?: number  // candle interval for all strategies (180=3min, 300=5min)
  session_type?: 'sim' | 'paper' | 'real' | 'stepwise'
  stepwise?: boolean
}

export interface UserSettingsResponse {
  historical_days: number
  funds_ratio_l_pct?: number
  funds_ratio_m_pct?: number
  funds_ratio_h_pct?: number
  analysis_price_source?: string
  experimental_patterns_enabled?: boolean
  pattern_share_emails?: string
}

// ── Strategy types ──────────────────────────────────────────────────────────

export interface StrategyResponse {
  strategy_id: string
  strategy_type: string
  symbol: string
  right: string | null
  status: string
  triggered: boolean
}

export interface StartStrategyRequest {
  session_id: string
  strategy_type: 'AutoStop' | 'BreakEven' | 'AggressiveStoploss' | 'TargetProfit' | 'LockProfit' | 'UnderlyingTargetProfit'
  right?: 'CE' | 'PE' | null
  quantity?: number
  funds_ratio_pct?: number
  direction?: 'BUY' | 'SELL'
  autostop_trigger_type?: 'bar' | 'deviation'
  autostop_deviation_pct?: number
  only_in_profit?: boolean
  target_profit_value?: number
  target_profit_is_pct?: boolean
  target_profit_buffer_ticks?: number
  breakeven_mode?: 'shift_sl' | 'limit_order'
  lock_profit_value?: number
  lock_profit_is_pct?: boolean
}

export interface SimulationStartResponse {
  session_id: string
  symbol: string
  date: string
  start_time: string
  speed: number
  session_capital: number
  instrument_type: string
  strike: number | null
  expiry: string | null
  right: string | null
  strike_ce: number | null
  strike_pe: number | null
  session_type: string
  stepwise: boolean
  total_bars: number | null
}

export interface WalletResponse {
  user_id: string
  date: string
  balance: number
}

// Pattern Library types
export interface PatternAnnotation {
  id: string
  time: number
  price: number
  type: 'entry' | 'exit'
  instrument: 'underlying' | 'CE' | 'PE'
  strategy_name: string
  category?: string
  text: string
}

export interface PatternChartMeta {
  chart_id: string
  user_id: string
  symbol: string
  date: string
  instrument_type: string
  right?: string
  strike?: number
  notes: string
  created_at: string
  updated_at: string
  entry_count: number
  exit_count: number
  strategy_names: string[]
  categories: string[]
  can_delete?: boolean
}

export interface PatternChart extends PatternChartMeta {
  annotations: PatternAnnotation[]
}

export interface PatternOHLCResponse {
  symbol: string
  date: string
  interval_minutes: number
  candles: OHLCCandle[]
  // options extras
  strike?: number
  expiry?: string
  right?: string
}

export interface AuthResponse {
  user_id: string
  email: string
  is_admin: boolean
}

export interface AdminTokensResponse {
  icici_session: string | null
  kite_access: string | null
  fyers_access: string | null
  fyers_refresh: string | null
}

// ── Analysis types ──────────────────────────────────────────────────────────

export interface SessionSummary {
  session_id: string
  user_id: string
  symbol: string
  date: string
  start_time: string | null
  instrument_type: string
  session_type: string
  strike: number | null
  expiry: string | null
  session_capital: number
  net_pnl: number
  pnl_pct: number
  total_commission: number
  trade_count: number
  buy_count: number
  sell_count: number
}

export interface AnalysisTrade {
  trade_id: string
  session_id: string
  user_id: string
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  timestamp: number
  instrument_type: string
  right: string | null
  strike: number | null
  expiry: string | null
  commission: number
  underlying_price?: number
}

export interface SessionDetail extends SessionSummary {
  trades: AnalysisTrade[]
}

// ── Event Snapshot types ────────────────────────────────────────────────────

export interface SnapshotFilledTrade {
  trade_id: string
  side: 'BUY' | 'SELL'
  price: number
  timestamp: number
  right?: string
  strike?: number
  underlying_price?: number
  quantity: number
}

export interface SnapshotPosition {
  side: string
  quantity: number
  avg_entry_price: number
  pnl: number
  pnl_pct: number
}

export interface SnapshotEventDetail {
  type: string
  description: string
  details: Record<string, unknown>
}

export interface SnapshotData {
  current_price: number
  current_price_ce: number
  current_price_pe: number
  bar_time: number
  bar_ohlc: { open: number; high: number; low: number; close: number } | null
  position: SnapshotPosition
  position_ce: SnapshotPosition
  position_pe: SnapshotPosition
  // Combined P&L across all positions
  combined_pnl: number
  combined_pnl_pct: number
  // Session-level P&L (realized + unrealized, net of all commissions)
  session_pnl: number
  session_pnl_pct: number
  wallet_balance: number
  session_capital: number
  wallet_used_pct: number
  // How many distinct positions are open (equity + CE + PE)
  active_positions: number
  open_orders: Order[]
  strike_ce: number | null
  strike_pe: number | null
  expiry: string | null
  // Snapshot metadata: exact event timestamp (not just bar start)
  event_timestamp: number
  // Quantity mode: "quantity" or "funds_ratio"
  quantity_mode: string
  // Filled trades up to this event time (for chart markers)
  filled_trades: SnapshotFilledTrade[]
}

export interface EventSnapshot {
  event_id: string
  session_id: string
  user_id: string
  symbol: string
  date: string
  instrument_type: string
  session_type: string
  timestamp: number
  event: SnapshotEventDetail
  snapshot: SnapshotData
}

export interface SnapshotPayload {
  event_id: string
  session_id: string
  user_id: string
  symbol: string
  date: string
  instrument_type: string
  session_type: string
  timestamp: number
  event: SnapshotEventDetail
  snapshot: SnapshotData
}

export class InsufficientFundsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientFundsError'
  }
}

export interface Trade {
  trade_id: string
  user_id: string
  symbol: string
  side: 'BUY' | 'SELL'
  quantity: number
  price: number
  timestamp: number
  session_id: string
  right?: string       // "CE" or "PE" for options trades
  strike?: number      // options strike
  commission: number   // exchange charges + brokerage, computed at record time
  // Frontend-only: NIFTY price snapshotted when a CE/PE trade lands in local state
  underlying_price?: number
}

export interface Position {
  symbol: string
  quantity: number
  avg_entry_price: number
  side: 'LONG' | 'SHORT' | 'FLAT'
  entry_commission: number  // sum of commissions for the currently-open lots (FIFO-apportioned)
}

export interface PriceAtResponse {
  symbol: string
  date: string
  time: string
  price: number
}

export interface ExpiryResponse {
  symbol: string
  date: string
  expiry: string
}

// ── GuardRails ─────────────────────────────────────────────────────────────

export interface GuardRailSettings {
  guardrail_block_bars: number
  guardrail_cooldown_block_bars: number
  guardrail_cooldown_losses: number
  guardrail_ban_capital_pct: number
  guardrail_ban_loss_trade_pct: number
  guardrail_ban_min_trades: number
  guardrail_ban_enabled: boolean
  guardrail_cooldown_enabled: boolean
}

export interface GuardRailStatusResponse {
  block_active: boolean
  block_until_bar: number
  ban_active: boolean
  cooldown_enabled: boolean
  consecutive_losses: number
  settings: GuardRailSettings
}

// ── AI Helper types ─────────────────────────────────────────────────────────

export interface DecisionAction {
  side?: string
  quantity_type?: string
  quantity_value?: number | null
  price_type?: string
  price_value?: number | null
}

export interface DecisionItem {
  command_id: string
  command_text: string
  bar_time: string
  reason: string
  action: DecisionAction
  action_result: string
  timestamp: string
}

export interface AIChatRequest {
  message: string
  session_id: string | null
  user_id: string
  symbol?: string | null
  strike_ce?: number | null
  strike_pe?: number | null
}

export interface AnalysisPattern {
  type: 'positive' | 'negative'
  title: string
  detail: string
  frequency: string
}

export interface AnalysisNotableStats {
  win_rate?: string
  avg_profit_pct?: string
  avg_loss_pct?: string
  best_time_of_day?: string
  worst_time_of_day?: string
}

export interface PatternInstance {
  group_id: string
  direction: 'LONG' | 'SHORT'
  pnl: number
  entry_time: number
  exit_time?: number | null
  symbol: string
  detected: boolean
  detail: string
  pct?: number
}

export interface PatternInstances {
  scared_exits?: PatternInstance[]
  early_exits?: PatternInstance[]
  entry_deviation?: PatternInstance[]
  buying_on_top?: PatternInstance[]
  panic_entries?: PatternInstance[]
}

export interface AnalysisResult {
  summary: string
  patterns: AnalysisPattern[]
  suggestions: string[]
  notable_stats: AnalysisNotableStats
  pattern_instances?: PatternInstances
}

export interface AIChatResponse {
  status: string
  message: string
  command_id?: string | null
  hotword?: string | null
  commands?: unknown[] | null
  analysis?: AnalysisResult | null
}

export interface StrategyItem {
  hotword: string
  strategy_text: string
  description?: string
  created_at: string
  last_used_at?: string
  use_count?: number
  is_template?: boolean
  template_text?: string
  template_type?: string
}

export interface CommandItem {
  command_id: string
  user_id: string
  session_id: string
  command_text: string
  status: 'active' | 'executed' | 'cancelled'
  order_type: string
  quantity_type: string
  quantity_value?: number | null
  parsed_trigger: string
  parsed_price_expr: string
  symbol?: string | null
  right?: string | null
  strike?: number | null
  hotword?: string | null
  one_shot: boolean
  created_at: string
  fired_at?: string | null
  cancel_reason?: string | null
}

const api = {
  async getSymbols(): Promise<SymbolInfo[]> {
    const res = await fetch(`${BACKEND_URL}/api/data/symbols`)
    if (!res.ok) throw new Error(`Symbols fetch failed: ${res.status}`)
    const data = await res.json()
    return data.symbols as SymbolInfo[]
  },

  async getAvailableDates(symbol: string): Promise<string[]> {
    const res = await fetch(`${BACKEND_URL}/api/data/available-dates?symbol=${encodeURIComponent(symbol)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data.dates as string[]
  },

  async getHistorical(symbol = 'NIFTY', tradingDate?: string, intervalMinutes?: number, historicalDays?: number): Promise<HistoricalDataResponse> {
    let url = `${BACKEND_URL}/api/data/historical?symbol=${encodeURIComponent(symbol)}`
    if (tradingDate) url += `&trading_date=${tradingDate}`
    if (intervalMinutes) url += `&interval_minutes=${intervalMinutes}`
    if (historicalDays) url += `&historical_days=${historicalDays}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Historical data fetch failed: ${res.status}`)
    return res.json()
  },

  async getOptionsHistorical(
    symbol: string,
    date: string,
    strike: number,
    expiry: string,
    right: string,
    intervalMinutes?: number,
    historicalDays?: number,
  ): Promise<HistoricalDataResponse> {
    let url = `${BACKEND_URL}/api/data/options-historical`
      + `?symbol=${encodeURIComponent(symbol)}`
      + `&date=${date}`
      + `&strike=${strike}`
      + `&expiry=${expiry}`
      + `&right=${right}`
    if (intervalMinutes) url += `&interval_minutes=${intervalMinutes}`
    if (historicalDays) url += `&historical_days=${historicalDays}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Options historical data fetch failed: ${res.status}`)
    return res.json()
  },

  async getPreSession(symbol: string, tradingDate: string, startTime: string, intervalMinutes?: number): Promise<OHLCCandle[]> {
    let url = `${BACKEND_URL}/api/data/pre-session?symbol=${encodeURIComponent(symbol)}&trading_date=${tradingDate}&start_time=${encodeURIComponent(startTime)}`
    if (intervalMinutes) url += `&interval_minutes=${intervalMinutes}`
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return data.candles ?? []
  },

  async getPriceAt(symbol: string, date: string, time: string): Promise<PriceAtResponse> {
    const url = `${BACKEND_URL}/api/data/price-at?symbol=${encodeURIComponent(symbol)}&date=${date}&time=${encodeURIComponent(time)}`
    const res = await fetch(url)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body?.detail || `Price-at fetch failed: ${res.status}`)
    }
    return res.json()
  },

  async getExpiry(symbol: string, date: string): Promise<ExpiryResponse> {
    const url = `${BACKEND_URL}/api/data/expiry?symbol=${encodeURIComponent(symbol)}&date=${date}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Expiry fetch failed: ${res.status}`)
    return res.json()
  },

  async startSimulation(req: SimulationStartRequest = {}): Promise<SimulationStartResponse> {
    const body = { symbol: 'NIFTY', date: '2026-05-06', start_time: '09:15:00', speed: 1.0, ...req }
    const res = await fetch(`${BACKEND_URL}/api/simulation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.detail || `Start simulation failed: ${res.status}`)
    }
    return res.json()
  },

  async stopSimulation(session_id: string): Promise<void> {
    await fetch(`${BACKEND_URL}/api/simulation/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id }),
    })
  },

  async pauseSimulation(session_id: string): Promise<void> {
    await fetch(`${BACKEND_URL}/api/simulation/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id }),
    })
  },

  async resumeSimulation(session_id: string): Promise<void> {
    await fetch(`${BACKEND_URL}/api/simulation/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id }),
    })
  },

  async nextBar(session_id: string): Promise<{ bar_index: number; total_bars: number }> {
    const res = await fetch(`${BACKEND_URL}/api/simulation/${session_id}/next-bar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
    })
    if (!res.ok) throw new Error(`Next bar failed: ${res.status}`)
    return res.json()
  },

  async buy(session_id: string, right?: string): Promise<Trade | { status: string; kotak_order_id?: string }> {
    const res = await fetch(`${BACKEND_URL}/api/trades/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id, ...(right ? { right } : {}) }),
    })
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Buy failed: ${res.status}`)
    }
    if (!res.ok) throw new Error(`Buy failed: ${res.status}`)
    return res.json()
  },

  async sell(session_id: string, right?: string): Promise<Trade | { status: string; kotak_order_id?: string }> {
    const res = await fetch(`${BACKEND_URL}/api/trades/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id, ...(right ? { right } : {}) }),
    })
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Sell failed: ${res.status}`)
    }
    if (!res.ok) throw new Error(`Sell failed: ${res.status}`)
    return res.json()
  },

  async getTrades(session_id: string): Promise<Trade[]> {
    const res = await fetch(`${BACKEND_URL}/api/trades?session_id=${session_id}`)
    if (!res.ok) throw new Error(`Get trades failed: ${res.status}`)
    return res.json()
  },

  async getTradesByContext(
    symbol: string,
    date: string,
    instrumentType: string,
    sessionType: string,
  ): Promise<{ trades: Trade[]; sessionIds: string[] }> {
    const url = `${BACKEND_URL}/api/trades/by-context`
      + `?symbol=${encodeURIComponent(symbol)}`
      + `&date=${date}`
      + `&instrument_type=${encodeURIComponent(instrumentType)}`
      + `&session_type=${encodeURIComponent(sessionType)}`
    const res = await fetch(url, { headers: _authHeaders() })
    if (!res.ok) return { trades: [], sessionIds: [] }
    return res.json()
  },

  async getPosition(session_id: string, right?: string): Promise<Position> {
    let url = `${BACKEND_URL}/api/trades/position?session_id=${session_id}`
    if (right) url += `&right=${right}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Get position failed: ${res.status}`)
    return res.json()
  },

  async placeOrder(
    session_id: string,
    side: 'BUY' | 'SELL',
    order_type: 'TARGET' | 'LIMIT' | 'STOPLOSS',
    price: number,
    quantityOrRatio: number | null,
    opts: { is_stoploss?: boolean; funds_ratio_pct?: number; right?: string; target_deviation_pct?: number } = {},
  ): Promise<Order> {
    const { target_deviation_pct, ...restOpts } = opts
    const body: Record<string, unknown> = { session_id, side, order_type, ...restOpts }
    if (order_type === 'LIMIT') {
      body.limit_price = price
    } else {
      body.trigger_price = price  // TARGET and STOPLOSS both use trigger_price
    }
    if (opts.funds_ratio_pct != null) {
      body.funds_ratio_pct = opts.funds_ratio_pct
    } else {
      body.quantity = quantityOrRatio
    }
    if (target_deviation_pct != null) {
      body.target_deviation_pct = target_deviation_pct
    }
    const res = await fetch(`${BACKEND_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(body),
    })
    if (res.status === 402) {
      const data = await res.json().catch(() => ({}))
      throw new InsufficientFundsError(data.detail || 'Insufficient funds')
    }
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Place order failed: ${res.status}`)
    }
    if (!res.ok) throw new Error(`Place order failed: ${res.status}`)
    return res.json()
  },

  async updateOrder(
    session_id: string,
    order_id: string,
    triggerPrice?: number,
    limitPrice?: number,
    targetDeviationPct?: number,
  ): Promise<Order> {
    const body: Record<string, unknown> = {}
    if (triggerPrice !== undefined) body.trigger_price = triggerPrice
    if (limitPrice !== undefined) body.limit_price = limitPrice
    if (targetDeviationPct !== undefined) body.target_deviation_pct = targetDeviationPct
    const res = await fetch(`${BACKEND_URL}/api/orders/${order_id}?session_id=${session_id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Update order failed: ${res.status}`)
    return res.json()
  },

  async convertOrder(sessionId: string, orderId: string, newOrderType: 'TARGET' | 'LIMIT' | 'STOPLOSS', price?: number): Promise<Order> {
    const body: Record<string, unknown> = { session_id: sessionId, new_order_type: newOrderType }
    if (price !== undefined) body.price = price
    const res = await fetch(`${BACKEND_URL}/api/orders/${orderId}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Convert order failed: ${res.status}`)
    return res.json()
  },

  async getWallet(date: string): Promise<WalletResponse> {
    const res = await fetch(`${BACKEND_URL}/api/wallet?date=${encodeURIComponent(date)}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Wallet fetch failed: ${res.status}`)
    return res.json()
  },

  async resetWallet(date: string, amount?: number): Promise<WalletResponse> {
    const res = await fetch(`${BACKEND_URL}/api/wallet/reset?date=${encodeURIComponent(date)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ amount: amount ?? 150000 }),
    })
    if (!res.ok) throw new Error(`Wallet reset failed: ${res.status}`)
    return res.json()
  },

  async getOrders(session_id: string, open_only = true): Promise<Order[]> {
    const res = await fetch(`${BACKEND_URL}/api/orders?session_id=${session_id}&open_only=${open_only}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Get orders failed: ${res.status}`)
    return res.json()
  },

  async cancelOrder(session_id: string, order_id: string): Promise<Order | null> {
    const res = await fetch(`${BACKEND_URL}/api/orders/${order_id}?session_id=${session_id}`, {
      method: 'DELETE',
      headers: _authHeaders(),
    })
    // 404 means the order was already filled or cancelled (SSE race) — treat as success
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Cancel order failed: ${res.status}`)
    return res.json()
  },

  async updatePaneStrike(sessionId: string, right: 'CE' | 'PE', strike: number): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/simulation/${sessionId}/update-pane-strike`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ right, strike }),
    })
    if (!res.ok) throw new Error(`Update pane strike failed: ${res.status}`)
  },

  getSSEUrl(session_id: string): string {
    return `${BACKEND_URL}/api/stream/${session_id}`
  },

  // ── Auth ───────────────────────────────────────────────────────────────────

  async login(email: string, password: string): Promise<AuthResponse> {
    const res = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Login failed: ${res.status}`)
    }
    return res.json()
  },

  async register(email: string, password: string): Promise<AuthResponse> {
    const res = await fetch(`${BACKEND_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Registration failed: ${res.status}`)
    }
    return res.json()
  },

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail ?? `Failed to change password: ${res.status}`)
    }
  },

  async getMe(): Promise<AuthResponse> {
    const res = await fetch(`${BACKEND_URL}/api/auth/me`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Get me failed: ${res.status}`)
    return res.json()
  },

  async getAdminTokens(): Promise<AdminTokensResponse> {
    const res = await fetch(`${BACKEND_URL}/api/admin/tokens`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Get admin tokens failed: ${res.status}`)
    return res.json()
  },

  async setAdminTokens(tokens: { icici_session?: string; kite_access?: string; fyers_access?: string; fyers_refresh?: string }): Promise<AdminTokensResponse> {
    const res = await fetch(`${BACKEND_URL}/api/admin/tokens`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(tokens),
    })
    if (!res.ok) throw new Error(`Set admin tokens failed: ${res.status}`)
    return res.json()
  },

  // ── Analysis ───────────────────────────────────────────────────────────────

  async getAnalysisSessions(opts: {
    symbol?: string
    startDate?: string
    endDate?: string
    instrumentType?: string
    sessionType?: string
  } = {}): Promise<SessionSummary[]> {
    const params = new URLSearchParams()
    if (opts.symbol) params.set('symbol', opts.symbol)
    if (opts.startDate) params.set('start_date', opts.startDate)
    if (opts.endDate) params.set('end_date', opts.endDate)
    if (opts.instrumentType) params.set('instrument_type', opts.instrumentType)
    if (opts.sessionType) params.set('session_type', opts.sessionType)
    const res = await fetch(`${BACKEND_URL}/api/analysis/sessions?${params}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Analysis sessions fetch failed: ${res.status}`)
    return res.json()
  },

  async getSessionDetail(sessionId: string): Promise<SessionDetail> {
    const res = await fetch(`${BACKEND_URL}/api/analysis/sessions/${sessionId}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Session detail fetch failed: ${res.status}`)
    return res.json()
  },

  // ── Strategies ─────────────────────────────────────────────────────────────

  async startStrategy(req: StartStrategyRequest): Promise<StrategyResponse> {
    const res = await fetch(`${BACKEND_URL}/api/strategies/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(req),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Start strategy failed: ${res.status}`)
    }
    return res.json()
  },

  async cancelAllStrategies(session_id: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/strategies/cancel-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id }),
    })
    if (!res.ok) throw new Error(`Cancel strategies failed: ${res.status}`)
  },

  async listStrategies(session_id: string): Promise<StrategyResponse[]> {
    const res = await fetch(`${BACKEND_URL}/api/strategies?session_id=${session_id}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`List strategies failed: ${res.status}`)
    return res.json()
  },

  async cancelStrategy(strategy_id: string, session_id: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/strategies/${strategy_id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id }),
    })
    if (!res.ok) throw new Error(`Cancel strategy failed: ${res.status}`)
  },

  async updateStrategyPrice(strategy_id: string, session_id: string, price: number): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/strategies/${strategy_id}/price`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id, price }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Update strategy price failed: ${res.status}`)
    }
  },

  async bulkUpdateSL(session_id: string, trigger_price: number, right: string | null): Promise<{ updated: number; orders: Order[] }> {
    const res = await fetch(`${BACKEND_URL}/api/orders/bulk-update-sl`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id, trigger_price, right }),
    })
    if (!res.ok) throw new Error(`Bulk SL update failed: ${res.status}`)
    return res.json()
  },

  // ── User Settings ──────────────────────────────────────────────────────────

  async getUserSettings(): Promise<UserSettingsResponse> {
    const res = await fetch(`${BACKEND_URL}/api/users/settings`, {
      headers: _authHeaders(),
    })
    if (!res.ok) return { historical_days: 2 }
    return res.json()
  },

  async updateUserSettings(settings: Partial<UserSettingsResponse>): Promise<UserSettingsResponse> {
    const res = await fetch(`${BACKEND_URL}/api/users/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(settings),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.detail || `Update user settings failed: ${res.status}`)
    return data
  },

  // ── Kotak Neo ──────────────────────────────────────────────────────────────

  async kotakLogin(totp: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/kotak/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ totp }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Kotak login failed: ${res.status}`)
    }
  },

  async kotakStatus(): Promise<{ authenticated: boolean; broker: string }> {
    const res = await fetch(`${BACKEND_URL}/api/kotak/status`, {
      headers: _authHeaders(),
    })
    if (!res.ok) return { authenticated: false, broker: 'KotakNeo' }
    return res.json()
  },

  async kotakFunds(): Promise<{ balance: number }> {
    const res = await fetch(`${BACKEND_URL}/api/kotak/funds`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Kotak funds fetch failed: ${res.status}`)
    return res.json()
  },

  async kotakOrderHistory(): Promise<{ orders: Record<string, unknown>[] }> {
    const res = await fetch(`${BACKEND_URL}/api/kotak/order-history`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Kotak order history failed: ${res.status}`)
    return res.json()
  },

  async reconcileKotakOrders(sessionId: string): Promise<{ reconciled: number; open_orders: unknown[]; wallet_balance: number | null }> {
    const res = await fetch(
      `${BACKEND_URL}/api/kotak/reconcile?session_id=${sessionId}`,
      { method: 'POST', headers: _authHeaders() }
    )
    if (!res.ok) throw new Error(`Kotak reconcile failed: ${res.status}`)
    return res.json()
  },

  async checkRealTradingAccess(): Promise<{ has_access: boolean }> {
    const res = await fetch(`${BACKEND_URL}/api/kotak/check-access`, {
      headers: _authHeaders(),
    })
    if (!res.ok) return { has_access: false }
    return res.json()
  },

  // ── Real Trading Whitelist (admin) ─────────────────────────────────────────

  async getRealTradingWhitelist(): Promise<{ email: string; added_at?: string }[]> {
    const res = await fetch(`${BACKEND_URL}/api/admin/real-trading/whitelist`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Whitelist fetch failed: ${res.status}`)
    return res.json()
  },

  async addToRealTradingWhitelist(email: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/admin/real-trading/whitelist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ email }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Add to whitelist failed: ${res.status}`)
    }
  },

  async removeFromRealTradingWhitelist(email: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/admin/real-trading/whitelist/${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: _authHeaders(),
    })
    if (!res.ok && res.status !== 204) throw new Error(`Remove from whitelist failed: ${res.status}`)
  },

  // ── Live streaming source (admin) ──────────────────────────────────────────

  async getStreamSource(): Promise<{ source: 'fyers' | 'kite' | 'kotak' | 'breeze' }> {
    const res = await fetch(`${BACKEND_URL}/api/admin/stream-source`, {
      headers: _authHeaders(),
    })
    if (!res.ok) return { source: 'kite' }
    return res.json()
  },

  async setStreamSource(source: 'fyers' | 'kite' | 'kotak' | 'breeze'): Promise<{ source: string }> {
    const res = await fetch(`${BACKEND_URL}/api/admin/stream-source`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ source }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Set stream source failed: ${res.status}`)
    }
    return res.json()
  },

  // ── Breeze (ICICI Direct) ─────────────────────────────────────────────────

  async breezeStatus(): Promise<{ authenticated: boolean; broker: string }> {
    const res = await fetch(`${BACKEND_URL}/api/breeze/status`, {
      headers: _authHeaders(),
    })
    if (!res.ok) return { authenticated: false, broker: 'ICICIDirect' }
    return res.json()
  },

  // ── GuardRails ─────────────────────────────────────────────────────────────

  async triggerBlock(session_id: string): Promise<{ status: string; reason: string; until_bar: number }> {
    const res = await fetch(`${BACKEND_URL}/api/guardrails/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ session_id }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `Block failed: ${res.status}`)
    }
    return res.json()
  },

  async getGuardRailStatus(session_id: string): Promise<GuardRailStatusResponse> {
    const res = await fetch(`${BACKEND_URL}/api/guardrails/status?session_id=${session_id}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`GuardRail status failed: ${res.status}`)
    return res.json()
  },

  async getGuardRailSettings(): Promise<GuardRailSettings> {
    const res = await fetch(`${BACKEND_URL}/api/guardrails/settings`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`GuardRail settings failed: ${res.status}`)
    return res.json()
  },

  async updateGuardRailSettings(settings: Partial<GuardRailSettings>): Promise<GuardRailSettings> {
    const res = await fetch(`${BACKEND_URL}/api/guardrails/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(settings),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.detail || `GuardRail settings update failed: ${res.status}`)
    }
    return res.json()
  },

  // ── AI Helper ──────────────────────────────────────────────────────────────

  async aiChat(req: AIChatRequest): Promise<AIChatResponse> {
    const res = await fetch(`${AI_HELPER_URL}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    })
    if (!res.ok) throw new Error(`AI chat failed: ${res.status}`)
    return res.json()
  },

  async aiGetDecisions(sessionId: string, since?: string | null): Promise<DecisionItem[]> {
    let url = `${AI_HELPER_URL}/ai/session/${encodeURIComponent(sessionId)}/decisions`
    if (since) url += `?since=${encodeURIComponent(since)}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`AI decisions fetch failed: ${res.status}`)
    return res.json()
  },

  async aiGetStrategies(userId: string): Promise<StrategyItem[]> {
    const res = await fetch(`${AI_HELPER_URL}/ai/strategies?user_id=${encodeURIComponent(userId)}`)
    if (!res.ok) throw new Error(`AI strategies fetch failed: ${res.status}`)
    const data = await res.json()
    return (data.strategies ?? []) as StrategyItem[]
  },

  async aiDeleteStrategy(userId: string, hotword: string): Promise<void> {
    const res = await fetch(
      `${AI_HELPER_URL}/ai/strategies/${encodeURIComponent(hotword)}?user_id=${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error(`AI strategy delete failed: ${res.status}`)
  },

  async aiGetCommands(sessionId: string): Promise<CommandItem[]> {
    const res = await fetch(`${AI_HELPER_URL}/ai/session/${encodeURIComponent(sessionId)}/commands`)
    if (!res.ok) throw new Error(`AI commands fetch failed: ${res.status}`)
    return res.json()
  },

  async aiCancelCommand(commandId: string, userId: string): Promise<void> {
    const res = await fetch(
      `${AI_HELPER_URL}/ai/commands/${encodeURIComponent(commandId)}?user_id=${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    )
    if (!res.ok) throw new Error(`AI command cancel failed: ${res.status}`)
  },

  // ── Pattern Library ────────────────────────────────────────────────────────

  async patternListStrategies(): Promise<{ strategies: string[] }> {
    const res = await fetch(`${BACKEND_URL}/api/pattern/strategies`, { headers: _authHeaders() })
    if (!res.ok) throw new Error(`List strategies failed: ${res.status}`)
    return res.json()
  },

  async patternListCategories(): Promise<{ categories: string[] }> {
    const res = await fetch(`${BACKEND_URL}/api/pattern/categories`, { headers: _authHeaders() })
    if (!res.ok) throw new Error(`List categories failed: ${res.status}`)
    return res.json()
  },

  async patternListCharts(strategy?: string, category?: string): Promise<{ charts: PatternChartMeta[] }> {
    const params = new URLSearchParams()
    if (strategy) params.set('strategy', strategy)
    if (category) params.set('category', category)
    const q = params.toString() ? `?${params.toString()}` : ''
    const res = await fetch(`${BACKEND_URL}/api/pattern/charts${q}`, { headers: _authHeaders() })
    if (!res.ok) throw new Error(`List charts failed: ${res.status}`)
    return res.json()
  },

  async patternGetChartByDate(symbol: string, date: string, instrumentType: string, right?: string): Promise<PatternChart | null> {
    const params = new URLSearchParams({ symbol, date, instrument_type: instrumentType })
    if (right) params.set('right', right)
    const res = await fetch(`${BACKEND_URL}/api/pattern/chart/by-date?${params}`, { headers: _authHeaders() })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`Get chart by date failed: ${res.status}`)
    return res.json()
  },

  async patternGetChart(chartId: string): Promise<PatternChart> {
    const res = await fetch(`${BACKEND_URL}/api/pattern/chart/${chartId}`, { headers: _authHeaders() })
    if (!res.ok) throw new Error(`Get chart failed: ${res.status}`)
    return res.json()
  },

  async patternCreateChart(body: {
    symbol: string; date: string; instrument_type: string;
    annotations: PatternAnnotation[]; notes: string;
    right?: string; strike?: number;
  }): Promise<PatternChart> {
    const res = await fetch(`${BACKEND_URL}/api/pattern/chart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Create chart failed: ${res.status}`)
    return res.json()
  },

  async patternUpdateChart(chartId: string, annotations: PatternAnnotation[], notes: string): Promise<PatternChart> {
    const res = await fetch(`${BACKEND_URL}/api/pattern/chart/${chartId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify({ annotations, notes }),
    })
    if (!res.ok) throw new Error(`Update chart failed: ${res.status}`)
    return res.json()
  },

  async patternDeleteChart(chartId: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/pattern/chart/${chartId}`, {
      method: 'DELETE',
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Delete chart failed: ${res.status}`)
  },

  async patternOhlcEquity(symbol: string, date: string, intervalMinutes = 3, daysBack?: number): Promise<PatternOHLCResponse> {
    let url = `${BACKEND_URL}/api/pattern/ohlc/equity?symbol=${encodeURIComponent(symbol)}&date=${date}&interval_minutes=${intervalMinutes}`
    if (daysBack) url += `&days_back=${daysBack}`
    const res = await fetch(url, { headers: _authHeaders() })
    if (!res.ok) throw new Error(`OHLC equity failed: ${res.status}`)
    return res.json()
  },

  async patternOhlcOptions(
    symbol: string, date: string, strike: number, expiry: string, right: string, intervalMinutes = 3, daysBack?: number,
  ): Promise<PatternOHLCResponse> {
    const params = new URLSearchParams({
      symbol, date, strike: String(strike), expiry, right, interval_minutes: String(intervalMinutes),
    })
    if (daysBack) params.set('days_back', String(daysBack))
    const res = await fetch(`${BACKEND_URL}/api/pattern/ohlc/options?${params}`, { headers: _authHeaders() })
    if (!res.ok) throw new Error(`OHLC options failed: ${res.status}`)
    return res.json()
  },

  // ── Chart Structures (Phase XIII) ──────────────────────────────────────────

  async chartStructureGetTypes(): Promise<{
    opening_types: { value: string; label: string }[]
    midday_types: { value: string; label: string }[]
    closing_types: { value: string; label: string }[]
  }> {
    const res = await fetch(`${BACKEND_URL}/api/chart-structures/types`, { headers: _authHeaders() })
    if (!res.ok) throw new Error(`Get structure types failed: ${res.status}`)
    return res.json()
  },

  async chartStructureList(opts: {
    opening_types?: string
    midday_types?: string
    closing_types?: string
    symbol?: string
    start_date?: string
    end_date?: string
  } = {}): Promise<{ structures: ChartStructureItem[] }> {
    const params = new URLSearchParams()
    if (opts.opening_types) params.set('opening_types', opts.opening_types)
    if (opts.midday_types) params.set('midday_types', opts.midday_types)
    if (opts.closing_types) params.set('closing_types', opts.closing_types)
    if (opts.symbol) params.set('symbol', opts.symbol)
    if (opts.start_date) params.set('start_date', opts.start_date)
    if (opts.end_date) params.set('end_date', opts.end_date)
    const res = await fetch(`${BACKEND_URL}/api/chart-structures/structures?${params}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`List structures failed: ${res.status}`)
    return res.json()
  },

  async chartStructureGet(structureId: string): Promise<ChartStructureItem> {
    const res = await fetch(`${BACKEND_URL}/api/chart-structures/structure/${structureId}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Get structure failed: ${res.status}`)
    return res.json()
  },

  async chartStructureGetOHLC(symbol: string, date: string, intervalMinutes = 3): Promise<{
    symbol: string; date: string; interval_minutes: number
    candles: OHLCCandle[]; structure: ChartStructureItem | null
  }> {
    const res = await fetch(
      `${BACKEND_URL}/api/chart-structures/ohlc/${encodeURIComponent(symbol)}/${date}?interval_minutes=${intervalMinutes}`,
      { headers: _authHeaders() },
    )
    if (!res.ok) throw new Error(`Structure OHLC failed: ${res.status}`)
    return res.json()
  },

  async chartStructureCreate(data: {
    symbol: string; date: string; opening_type: string; midday_type: string; closing_type: string
  }): Promise<ChartStructureItem> {
    const res = await fetch(`${BACKEND_URL}/api/chart-structures/structure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`Create structure failed: ${res.status}`)
    return res.json()
  },

  async chartStructureUpdate(structureId: string, data: {
    opening_type: string; midday_type: string; closing_type: string
  }): Promise<ChartStructureItem> {
    const res = await fetch(`${BACKEND_URL}/api/chart-structures/structure/${structureId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`Update structure failed: ${res.status}`)
    return res.json()
  },

  async chartStructureDelete(structureId: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/chart-structures/structure/${structureId}`, {
      method: 'DELETE',
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Delete structure failed: ${res.status}`)
  },

  // ── Event Snapshots ────────────────────────────────────────────────────────

  async saveSnapshot(data: SnapshotPayload): Promise<{ event_id: string }> {
    const res = await fetch(`${BACKEND_URL}/api/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ..._authHeaders() },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error(`Save snapshot failed: ${res.status}`)
    return res.json()
  },

  async getSnapshots(sessionId: string): Promise<EventSnapshot[]> {
    const res = await fetch(`${BACKEND_URL}/api/snapshots?session_id=${encodeURIComponent(sessionId)}`, {
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Get snapshots failed: ${res.status}`)
    return res.json()
  },

  async getSnapshot(eventId: string, sessionId: string): Promise<EventSnapshot> {
    const res = await fetch(
      `${BACKEND_URL}/api/snapshots/${encodeURIComponent(eventId)}?session_id=${encodeURIComponent(sessionId)}`,
      { headers: _authHeaders() },
    )
    if (!res.ok) throw new Error(`Get snapshot failed: ${res.status}`)
    return res.json()
  },

  async deleteSnapshots(sessionId: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/snapshots?session_id=${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: _authHeaders(),
    })
    if (!res.ok) throw new Error(`Delete snapshots failed: ${res.status}`)
  },
}

export default api
