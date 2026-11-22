/** The day score (Phase 27): the shapes of `/api/analysis/day-score` and `/day-scores`, and the source every host provides. */

export type DayScoreStatus = 'scored' | 'pending_labels' | 'no_trades'
export type ScoreRuleKey = 'drawdown' | 'repeat_entry' | 'add_to_loser' | 'clean_day' | 'big_loss_wipes_gains'

export interface ScoreItem {
  key: ScoreRuleKey
  title: string
  /** Points added to the base (negative for a penalty). */
  points: number
  /** A plain sentence about what was found. */
  detail: string
  count: number | null
}

export interface DayScoreDrawdown {
  /** The lowest total P&L of the day (money, negative). */
  worst: number
  worst_pct: number
  /** The drawdown as a share of the guardrail limit (1 = the whole limit). */
  limit_ratio: number
  partial: boolean
  missing_contracts: number
  open_cycles: number
}

/** A day's score. Only `scored` has the score and the items; the others say how far from a score the day is. */
export interface DayScore {
  date: string
  status: DayScoreStatus
  score: number | null
  closed: number
  labelled: number
  sessions: number
  base?: number
  items?: ScoreItem[]
  /** The capital-loss limit (%) the day was scored against and where it came from: `saved` with the session, or `estimated` (a fixed value for older sessions). */
  limit_pct?: number
  limit_source?: 'saved' | 'estimated'
  drawdown?: DayScoreDrawdown
  capital?: number
  /** What the three event rules found, with the time of each (epoch seconds, market wall clock). */
  events?: Partial<Record<'repeat_entry' | 'add_to_loser' | 'big_loss_wipes_gains', Array<{ cycle_id?: string; time?: number }>>>
}

/** One stored score in a range list. */
export interface ScoreRow { date: string; score: number; limit_source: 'saved' | 'estimated' | null; partial: boolean; computed_at: string | null }

export interface ScoreRange { scores: ScoreRow[]; pending: number }

export interface DayScoreSource {
  day(date: string): Promise<DayScore>
  /** Stored scores in a range; `compute` also scores days that have none yet (a bounded number per call: `pending` says how many are left). */
  range(start?: string, end?: string, compute?: boolean): Promise<ScoreRange>
}
