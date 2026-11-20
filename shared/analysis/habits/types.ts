import type { BehaviorKind, BehaviorQuestion } from '../api'

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

/** The kind of a habit in the ledger: the user's own entry and exit questions, and the `system` habits the server calculates from the day (Phase 27). */
export type HabitKind = BehaviorKind | 'system'

/** A habit as the ledger lists it. A system habit (`sys:repeat_entry`, ...) is never marked, archived or edited: it is worked out from the day's trades. */
export interface LedgerQuestion extends Omit<BehaviorQuestion, 'kind'> {
  kind: HabitKind
  system?: boolean
}

/** `Entry`, `Exit` or `System`: the label beside a habit. */
export const kindLabel = (kind: HabitKind) => (kind === 'entry' ? 'Entry' : kind === 'exit' ? 'Exit' : 'System')

export interface HabitLedger {
  questions: LedgerQuestion[]
  trades: LedgerTrade[]
  coverage: LedgerCoverage
}
