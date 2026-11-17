/** Strategy Practice (Phase 26, S15): the data shapes of `/api/deep-dive/practice/*` and the client every host injects. */
import type { PatternAnnotation } from '../analysis/api'
import type { DeepDiveRequest, Outcome, Side, SetupTimings, Strength } from '../deepdive/types'

/** What a marked day can be filtered on: a grade, `ungraded` (an older success), `failed`, or `open` (no outcome). */
export type Grade = Strength | 'ungraded' | 'failed' | 'open'
export const GRADES: readonly Grade[] = ['ideal', 'average', 'poor', 'ungraded', 'failed', 'open']

export interface PracticeStrategy {
  category: string
  strategy: string
  /** Days (a day and symbol) with an Entry mark. */
  days: number
  grades: Record<Grade, number>
  symbols: Array<{ symbol: string; days: number }>
}

export interface PracticePick { symbol?: string; grades?: Grade[] }

/** The marker the replay start carries (the server resolves the rest from the user's own Deep Dive day). */
export interface PracticeMarker { category: string; strategy: string; start_offset_min: number }

/** A chosen day and replay start. Carries no side and no marks: those stay hidden until the session is stopped. */
export interface PracticePlan {
  symbol: string
  date: string
  /** `HH:MM:SS`, a few whole minutes before the first recorded Entry. */
  start_time: string
  interval_minutes: number
  instrument_type: 'equity' | 'options'
  strike_ce: number | null
  strike_pe: number | null
  expiry: string | null
  practice: PracticeMarker
  days_available: number
  repeated: boolean
}

export interface RunSummary {
  traded: boolean
  side?: Side
  entry_delta_min?: number | null
  exit_delta_min?: number | null
  capture_pct?: number | null
  points?: number | null
  theoretical_points?: number | null
}

export interface PracticeRun {
  session_id: string
  category: string
  strategy: string
  symbol: string
  date: string
  start_time: string
  start_offset_min: number
  state: string | null
  ended: boolean
  created_at: number | string | null
  result: RunSummary | null
}

export interface TheoreticalPair {
  instrument: 'underlying' | 'CE' | 'PE'
  strike: number | null
  expiry: string | null
  entry?: { time: number; clock: string; price: number }
  exit?: { time: number; clock: string; price: number }
  points?: number
  pct?: number | null
  unavailable?: string
}

export interface ReviewTrade {
  index: number | null
  instrument: 'underlying' | 'CE' | 'PE'
  right: 'CE' | 'PE' | null
  strike: number | null
  expiry: string | null
  action: 'BUY' | 'SELL'
  side: Side | null
  state: string
  quantity: number
  pnl: number
  pnl_pct: number | null
  entry: { time: number; price: number }
  exit: { time: number; price: number } | null
  points: number | null
  entry_delta_min: number | null
  exit_delta_min: number | null
  capture_pct: number | null
  theoretical_points: number | null
  theoretical_rupees: number | null
}

export interface ReviewSetup {
  side: Side
  interval_minutes: number
  outcome: Outcome | null
  strength: Strength | null
  strike_ce: number | null
  strike_pe: number | null
  annotations: PatternAnnotation[]
  recorded: SetupTimings
  theoretical: TheoreticalPair[]
  trades: ReviewTrade[]
}

export interface PracticeReview {
  session_id: string
  category: string
  strategy: string
  symbol: string
  date: string
  start_time: string
  start_offset_min: number
  setups: ReviewSetup[]
  other_trades: ReviewTrade[]
  summary: RunSummary
}

/** Every Strategy Practice operation. Implemented over the website's fetch and the desktop's patterns transport. */
export interface PracticeApi {
  strategies(): Promise<PracticeStrategy[]>
  pick(ref: { category: string; strategy: string }, filter?: PracticePick): Promise<PracticePlan>
  runs(): Promise<PracticeRun[]>
  /** Refused with a 409 sentence while the session still runs. */
  evaluate(sessionId: string): Promise<PracticeReview>
}

export type PracticeRequest = DeepDiveRequest
