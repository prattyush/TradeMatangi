import type { BehaviorQuestion } from '../api'

/**
 * One closed, own, intraday trade with the habits (behavior marks) it carries. Built by the backend
 * (`GET /api/behavior/habit-ledger`); every Habits statistic is computed from these rows.
 */
export interface LedgerTrade {
  cycle_id: string
  session_id: string
  date: string
  /** When the session was run (UTC epoch ms) and that IST day; absent/null for sessions without a wall-clock creation time. */
  created_at?: number | null
  created_date?: string | null
  /** 0-based position of the trade's session in the order the sessions were run. */
  session_seq?: number
  entry_time: number
  exit_time: number | null
  symbol: string
  right: string | null
  strike: number | null
  direction: string
  net_pnl: number
  /** Net P&L as % of the session capital. */
  pnl_pct: number | null
  /** Total capital deployed (sum of the entries' allocation), % of the session capital; null when unavailable. */
  capital_pct: number | null
  risk_pct: number | null
  entries: number
  exits: number
  holding_seconds: number | null
  /** Candles touched; entering and exiting inside one candle is 1. */
  bars: number | null
  r_multiple: number | null
  entry_method: string | null
  habits: string[]
}

export interface LedgerCoverage {
  closed_trades: number
  marked_trades: number
  marks: number
  unmatched_marks: number
  open_marked_trades: number
  trades_without_capital: number
  trades_without_bars: number
  truncated: boolean
}

export interface HabitLedger {
  questions: BehaviorQuestion[]
  trades: LedgerTrade[]
  coverage: LedgerCoverage
}
