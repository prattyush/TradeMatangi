/** The Analysis Summary (Phase 27, S10 and S11): the shape of `GET /api/analysis/day-summary` and the source every host provides. */
import type { JourneyCurve } from '../dayJourney'
import type { PerformanceFilters } from '../performance'

export interface SummaryTotals {
  trades: number
  wins: number
  losses: number
  win_pct: number | null
  /** Net P&L in rupees. */
  net_pnl: number
  /** The sum of the trades' P&L as a percent of their own capital (null when no trade has a capital). */
  pnl_pct: number | null
  mean_pnl_pct: number | null
  fees: number
}
export interface SummaryStrategy extends SummaryTotals { strategy: string }
export interface SummaryLabels { closed: number; labelled: number; plan_followed: number; plan_not_followed: number; plan_unknown: number }
export interface SummaryTrade {
  cycle_id: string
  session_id: string
  mode: string | null
  symbol: string | null
  right: string | null
  strike: number | null
  direction: 'LONG' | 'SHORT' | null
  entry_time: number | null
  exit_time: number | null
  net_pnl: number
  pnl_pct: number | null
  strategy: string | null
}
export interface SummarySymbol { symbol: string; instrument_type: string | null; trades: number; net_pnl: number; modes: string[]; session_ids: string[] }
/** The Day P&L Journey of one mode of the day (the entry-sizing block is not sent). */
export interface SummaryJourney extends JourneyCurve {
  id: string
  date: string
  mode: string
  net_pnl: number
  net_pnl_pct: number | null
  max_drawdown: number
  max_drawdown_pct: number | null
}
/** One stored day score of a date, for one of the session types the day was traded in. */
export interface SummaryScore { mode: 'sim' | 'stepwise' | 'paper' | 'real'; score: number; limit_source: 'saved' | 'estimated' | null; partial: boolean }
export interface SummaryNote { date: string; went_well: string; to_improve: string; specific_points: string; context: string; updated_at: string | null }
export interface SummaryDay {
  date: string
  symbols: SummarySymbol[]
  open_trades: number
  totals: SummaryTotals
  strategies: SummaryStrategy[]
  labels: SummaryLabels
  best: SummaryTrade | null
  worst: SummaryTrade | null
  journeys: SummaryJourney[]
  /** One per session type the day was traded in that has a stored score (Replay, Stepwise, Paper, Real order); empty when none. */
  scores: SummaryScore[]
  note: SummaryNote | null
}
export interface DaySummary { days: SummaryDay[]; total_days: number; truncated: boolean }

export interface DaySummarySource {
  /** The cards for the filters (the Stats filters), newest first. */
  days: (filters: PerformanceFilters) => Promise<DaySummary>
}
