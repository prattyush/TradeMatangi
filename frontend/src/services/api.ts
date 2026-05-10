import { BACKEND_URL } from '../config'

export interface OHLCCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
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
}

export interface SimulationStartResponse {
  session_id: string
  symbol: string
  date: string
  start_time: string
  speed: number
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
}

export interface Position {
  symbol: string
  quantity: number
  avg_entry_price: number
  side: 'LONG' | 'SHORT' | 'FLAT'
}

const api = {
  async getHistorical(symbol = 'NIFTY'): Promise<HistoricalDataResponse> {
    const res = await fetch(`${BACKEND_URL}/api/data/historical?symbol=${symbol}`)
    if (!res.ok) throw new Error(`Historical data fetch failed: ${res.status}`)
    return res.json()
  },

  async startSimulation(req: SimulationStartRequest = {}): Promise<SimulationStartResponse> {
    const body = { symbol: 'NIFTY', date: '2026-05-06', start_time: '09:15:00', speed: 1.0, ...req }
    const res = await fetch(`${BACKEND_URL}/api/simulation/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Start simulation failed: ${res.status}`)
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

  async buy(session_id: string): Promise<Trade> {
    const res = await fetch(`${BACKEND_URL}/api/trades/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    })
    if (!res.ok) throw new Error(`Buy failed: ${res.status}`)
    return res.json()
  },

  async sell(session_id: string): Promise<Trade> {
    const res = await fetch(`${BACKEND_URL}/api/trades/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    })
    if (!res.ok) throw new Error(`Sell failed: ${res.status}`)
    return res.json()
  },

  async getTrades(session_id: string): Promise<Trade[]> {
    const res = await fetch(`${BACKEND_URL}/api/trades?session_id=${session_id}`)
    if (!res.ok) throw new Error(`Get trades failed: ${res.status}`)
    return res.json()
  },

  async getPosition(session_id: string): Promise<Position> {
    const res = await fetch(`${BACKEND_URL}/api/trades/position?session_id=${session_id}`)
    if (!res.ok) throw new Error(`Get position failed: ${res.status}`)
    return res.json()
  },

  getSSEUrl(session_id: string): string {
    return `${BACKEND_URL}/api/stream/${session_id}`
  },
}

export default api
