/** Traded patterns (Phase 26, S10): the user's labelled trades as pattern material. Shapes of `/api/pattern/traded`. */
import type { DeepDiveRequest, Side } from '../deepdive/types'

export interface TradedStrategy {
  category: string
  strategy: string
  /** Distinct labelled trades (a trade labelled expected and actual with the same strategy counts once). */
  trades: number
  expected: number
  actual: number
  last_date: string
  sessions: number
}

export interface TradedLeg { time: number; price: number; quantity: number }
export interface TradedPattern { category: string; strategy: string }

export interface TradedTrade {
  session_id: string
  round_trip_index: number
  date: string
  symbol: string
  session_type: string
  instrument_type: string
  right: 'CE' | 'PE' | null
  strike: number | null
  expiry: string | null
  /** The order that opened the position. */
  action: 'BUY' | 'SELL'
  /** The side the position profits from (long equity, CE bought, PE sold = buy), null when unknown. */
  side: Side | null
  state: string
  entry: TradedLeg
  exit: TradedLeg | null
  pnl: number
  pnl_pct: number | null
  expected: TradedPattern
  actual: TradedPattern
  matched_as: 'expected' | 'actual' | 'both'
}

export interface TradedList {
  category: string
  strategy: string
  trades: TradedTrade[]
  total: number
  truncated: boolean
  unavailable: number
}

export interface SaveTradedResult { chart_id: string; merged: boolean; added: number }

export interface TradedApi {
  summary(range?: { start?: string; end?: string }): Promise<TradedStrategy[]>
  list(ref: { category: string; strategy: string }, options?: { start?: string; end?: string; limit?: number }): Promise<TradedList>
  save(trade: Pick<TradedTrade, 'session_id' | 'round_trip_index'>, ref: { category: string; strategy: string }): Promise<SaveTradedResult>
}

export type TradedRequest = DeepDiveRequest
