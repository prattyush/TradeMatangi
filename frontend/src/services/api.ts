import { BACKEND_URL } from '../config'

export interface OHLCCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
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
  right?: string   // "CE" or "PE" for options orders
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
}

export interface WalletResponse {
  user_id: string
  date: string
  balance: number
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
  right?: string   // "CE" or "PE" for options trades
}

export interface Position {
  symbol: string
  quantity: number
  avg_entry_price: number
  side: 'LONG' | 'SHORT' | 'FLAT'
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

  async getHistorical(symbol = 'NIFTY', tradingDate?: string, intervalMinutes?: number): Promise<HistoricalDataResponse> {
    let url = `${BACKEND_URL}/api/data/historical?symbol=${encodeURIComponent(symbol)}`
    if (tradingDate) url += `&trading_date=${tradingDate}`
    if (intervalMinutes) url += `&interval_minutes=${intervalMinutes}`
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
  ): Promise<HistoricalDataResponse> {
    let url = `${BACKEND_URL}/api/data/options-historical`
      + `?symbol=${encodeURIComponent(symbol)}`
      + `&date=${date}`
      + `&strike=${strike}`
      + `&expiry=${expiry}`
      + `&right=${right}`
    if (intervalMinutes) url += `&interval_minutes=${intervalMinutes}`
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
    if (!res.ok) throw new Error(`Price-at fetch failed: ${res.status}`)
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    })
  },

  async pauseSimulation(session_id: string): Promise<void> {
    await fetch(`${BACKEND_URL}/api/simulation/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    })
  },

  async resumeSimulation(session_id: string): Promise<void> {
    await fetch(`${BACKEND_URL}/api/simulation/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    })
  },

  async buy(session_id: string, right?: string): Promise<Trade> {
    const res = await fetch(`${BACKEND_URL}/api/trades/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, ...(right ? { right } : {}) }),
    })
    if (!res.ok) throw new Error(`Buy failed: ${res.status}`)
    return res.json()
  },

  async sell(session_id: string, right?: string): Promise<Trade> {
    const res = await fetch(`${BACKEND_URL}/api/trades/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, ...(right ? { right } : {}) }),
    })
    if (!res.ok) throw new Error(`Sell failed: ${res.status}`)
    return res.json()
  },

  async getTrades(session_id: string): Promise<Trade[]> {
    const res = await fetch(`${BACKEND_URL}/api/trades?session_id=${session_id}`)
    if (!res.ok) throw new Error(`Get trades failed: ${res.status}`)
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
    opts: { is_stoploss?: boolean; funds_ratio_pct?: number; right?: string } = {},
  ): Promise<Order> {
    const body: Record<string, unknown> = { session_id, side, order_type, ...opts }
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
    const res = await fetch(`${BACKEND_URL}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 402) {
      const data = await res.json().catch(() => ({}))
      throw new InsufficientFundsError(data.detail || 'Insufficient funds')
    }
    if (!res.ok) throw new Error(`Place order failed: ${res.status}`)
    return res.json()
  },

  async getWallet(date: string): Promise<WalletResponse> {
    const res = await fetch(`${BACKEND_URL}/api/wallet?date=${encodeURIComponent(date)}`)
    if (!res.ok) throw new Error(`Wallet fetch failed: ${res.status}`)
    return res.json()
  },

  async resetWallet(date: string, amount?: number): Promise<WalletResponse> {
    const res = await fetch(`${BACKEND_URL}/api/wallet/reset?date=${encodeURIComponent(date)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount ?? 150000 }),
    })
    if (!res.ok) throw new Error(`Wallet reset failed: ${res.status}`)
    return res.json()
  },

  async getOrders(session_id: string, open_only = true): Promise<Order[]> {
    const res = await fetch(`${BACKEND_URL}/api/orders?session_id=${session_id}&open_only=${open_only}`)
    if (!res.ok) throw new Error(`Get orders failed: ${res.status}`)
    return res.json()
  },

  async cancelOrder(session_id: string, order_id: string): Promise<Order> {
    const res = await fetch(`${BACKEND_URL}/api/orders/${order_id}?session_id=${session_id}`, {
      method: 'DELETE',
    })
    if (!res.ok) throw new Error(`Cancel order failed: ${res.status}`)
    return res.json()
  },

  getSSEUrl(session_id: string): string {
    return `${BACKEND_URL}/api/stream/${session_id}`
  },
}

export default api
