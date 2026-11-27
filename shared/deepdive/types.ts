/** Patterns Strategy Deep Dive (Phase 26): the data shapes of `/api/deep-dive` and the client every host injects. */
import type { PatternAnnotation } from '../analysis/api'

export type Side = 'buy' | 'sell'
export type Outcome = 'success' | 'failed'
/** How good a successful day was. A failed day has none. */
export type Strength = 'ideal' | 'average' | 'poor'
export type StrikeMode = 'max_price' | 'otm' | 'manual'
/** A tag on one day: marked valid (true), not valid (false), or not looked at yet (absent). */
export type TagValue = boolean
export type TagState = 'valid' | 'not_valid' | 'unmarked'

export interface DiveRef { category: string; strategy: string }
export interface SetupRef extends DiveRef { symbol: string; date: string; side: Side }

export interface DeepDiveTag {
  tag_id: string
  name: string
  status: 'active' | 'archived'
  sort_order: number
  created_at: string
  archived_at: string | null
}

/** One marked day and side of a dive. `tag_values` has an entry only for tags the user has marked. */
export interface DeepDiveSetup extends SetupRef {
  strike_ce: number | null
  strike_pe: number | null
  strike_mode: StrikeMode | null
  interval_minutes: number
  annotations: PatternAnnotation[]
  outcome: Outcome | null
  /** Only with a success; `null` for an older success that was never graded. */
  strength?: Strength | null
  tag_values: Record<string, TagValue>
  notes: string
  created_at: string
  updated_at: string
}

/** A setup as `GET /dive` returns it: with the active tags it has not marked yet. */
export interface DiveSetup extends DeepDiveSetup { missing: string[]; complete: boolean }

export interface Dive extends DiveRef {
  owner_id: string
  can_edit: boolean
  setups: DiveSetup[]
  tags: DeepDiveTag[]
  incomplete_days: number
  unmarked_total: number
}

export interface DiveSummary extends DiveRef {
  owner_id: string
  can_edit: boolean
  days: number
  buy_days: number
  sell_days: number
  tags: number
  incomplete_days: number
}

export interface TagStat {
  tag_id: string
  name: string
  valid: number
  not_valid: number
  /** Days where this tag was marked: the n of the percentage. */
  marked: number
  pct: number | null
  few_days: boolean
}

export interface StatsBlock {
  days: number
  buy_days: number
  sell_days: number
  tags: TagStat[]
  success: number
  failed: number
  with_outcome: number
  success_pct: number | null
  outcome_few_days: boolean
  /** How the successful days were graded (absent from an older server). */
  strength?: StrengthCounts
}

export interface StrengthCounts { ideal: number; average: number; poor: number; ungraded: number }

/** A day's entry and exit as read from its chart marks. `clock` is the IST time of the candle the mark sits on. */
export interface MarkTime { time: number; clock: string; price: number | null; instrument: string }
export interface SetupTimings { entry: MarkTime | null; exit: MarkTime | null; marks: Array<MarkTime & { type: 'entry' | 'exit' }> }

export interface DiveStats extends StatsBlock, DiveRef { owner_id: string; can_edit: boolean; side: Side | null }

/** One strategy's stats for the label forms: `all`, `buy` and `sell` blocks so the form can switch side without a request. */
export interface StatsAllEntry extends DiveRef {
  owner_id: string
  shared: boolean
  all: StatsBlock
  buy: StatsBlock
  sell: StatsBlock
}

/** Only the fields present change; `null` clears outcome, strikes and strike mode. */
export interface SetupFields {
  strike_ce?: number | null
  strike_pe?: number | null
  strike_mode?: StrikeMode | null
  interval_minutes?: number
  annotations?: PatternAnnotation[]
  outcome?: Outcome | null
  /** Grading a day makes it a success; `null` removes the grade and keeps the success; ignored by the server for a failed day. */
  strength?: Strength | null
  notes?: string
}

export interface SaveToPatternsResult { chart_id: string; merged: boolean; added: number }

/** Every deep dive operation. Implemented over the website's fetch and the desktop's patterns transport. */
export interface DeepDiveApi {
  listDives(): Promise<DiveSummary[]>
  getDive(ref: DiveRef, ownerId?: string): Promise<Dive>
  getStats(ref: DiveRef, side?: Side, ownerId?: string): Promise<DiveStats>
  getStatsAll(): Promise<StatsAllEntry[]>
  saveSetup(ref: SetupRef, fields?: SetupFields): Promise<DeepDiveSetup>
  deleteSetup(ref: SetupRef): Promise<boolean>
  setTagValues(ref: SetupRef, tagValues: Record<string, TagValue | null>): Promise<DeepDiveSetup>
  saveToPatterns(ref: SetupRef): Promise<SaveToPatternsResult>
  addTag(ref: DiveRef, name: string): Promise<DeepDiveTag>
  updateTag(ref: DiveRef, tagId: string, name: string): Promise<DeepDiveTag>
  archiveTag(ref: DiveRef, tagId: string): Promise<DeepDiveTag>
  restoreTag(ref: DiveRef, tagId: string): Promise<DeepDiveTag>
}

/** The transport a client runs over: a path under `deep-dive/...` relative to the host's API root. */
export type DeepDiveRequest = <T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown) => Promise<T>
