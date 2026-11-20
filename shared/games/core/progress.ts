/** Progress records (mirror of the server's `GameProfiles` items, spec 8.5) and the pure rules that update them. */
import { CATEGORIES, catalogueEntry, type Category, type GameId } from './ids'
import { applyLevelRule, clampLevel, DEFAULT_LEVEL_RULES, INITIAL_LEVEL_STATE, type LevelRules } from './difficulty'
import { nextEma, ratedScore } from './scoring'
import { warmupCount, WARMUP_STEPS } from './dashboard'
import type { SessionMode, SessionSummary } from './types'

export interface Versioned { revision: number; last_mutation_id?: string; updated_at?: string }
export interface GameRecord extends Versioned {
  level?: number; consecutiveHigh?: number; consecutiveLow?: number; sessions?: number; practice?: number
  best?: number; emaScore?: number; lastScores?: number[]; stats?: Record<string, number>; lastPlayed?: string
}
export interface DayGameTotals { n?: number; avg?: number; best?: number }
export interface TotalsRecord extends Versioned {
  games?: Partial<Record<GameId, DayGameTotals>>; warmupDone?: boolean | number; minutes?: number
  categoryScores?: Partial<Record<Category, number>>; expectancyR?: number; discipline?: number; days?: number
}
export interface ProfileRecord extends Versioned { settings?: Record<string, unknown>; createdAt?: string; version?: number }

export interface ProgressState {
  version: number
  user_id?: string
  profile: ProfileRecord | null
  games: Partial<Record<GameId, GameRecord>>
  days: Record<string, TotalsRecord>
  months: Record<string, TotalsRecord>
}
export const EMPTY_STATE: ProgressState = { version: 1, profile: null, games: {}, days: {}, months: {} }

/** One finished session, kept in the outbox until the server has it. `id` doubles as the server `mutation_id`. */
export interface SessionResult {
  id: string
  gameId: GameId
  mode: SessionMode
  /** Level the session was played at. */
  level: number
  /** Local date `YYYY-MM-DD`. */
  date: string
  minutes: number
  summary: SessionSummary
  /** ISO time the session ended. */
  playedAt: string
  /** Set when the session finished one step of the Daily Warm-up: the day record then counts it in `warmupDone`. */
  warmup?: { step: number }
}

interface PutEntry { revision: number; item: Record<string, unknown> }
export interface PutBody {
  mutation_id: string
  game?: PutEntry & { id: GameId }
  day?: PutEntry & { date: string }
  month?: PutEntry & { month: string }
  profile?: PutEntry
}

const SERVER_FIELDS = ['revision', 'last_mutation_id', 'updated_at'] as const
/** The server rejects fields it does not know, so drop the bookkeeping fields before sending a record back. */
export function itemOf<T extends Versioned>(record: T | null | undefined): Omit<T, keyof Versioned> {
  const out: Record<string, unknown> = { ...(record ?? {}) }
  for (const key of SERVER_FIELDS) delete out[key]
  return out as Omit<T, keyof Versioned>
}
/** A totals record without server bookkeeping: what the client sends. */
export type TotalsItem = Omit<TotalsRecord, keyof Versioned>
const round1 = (value: number): number => Math.round(value * 10) / 10

/** Fold one session into a totals record (day or month). */
function addToTotals(prev: TotalsRecord | undefined, result: SessionResult, newDay: boolean): TotalsItem {
  const item: TotalsItem = itemOf(prev)
  const games = { ...(item.games ?? {}) }
  const old = games[result.gameId] ?? {}
  const n = (old.n ?? 0) + 1
  const score = result.summary.score
  games[result.gameId] = { n, avg: round1(((old.avg ?? 0) * (n - 1) + score) / n), best: Math.max(old.best ?? 0, score) }
  const out: TotalsItem = { ...item, games, minutes: round1((item.minutes ?? 0) + Math.max(0, result.minutes)) }
  if (newDay) out.days = (item.days ?? 0) + 1
  return out
}

/** Category scores of a day: the mean of the day's per-game averages in each category. */
export function dayCategoryScores(games: TotalsRecord['games']): Partial<Record<Category, number>> {
  const buckets: Partial<Record<Category, number[]>> = {}
  for (const [id, totals] of Object.entries(games ?? {})) {
    const entry = catalogueEntry(id as GameId)
    if (!entry || totals?.avg === undefined) continue
    ;(buckets[entry.category] ??= []).push(totals.avg)
  }
  const out: Partial<Record<Category, number>> = {}
  for (const category of CATEGORIES) {
    const values = buckets[category]
    if (values?.length) out[category] = round1(values.reduce((a, b) => a + b, 0) / values.length)
  }
  return out
}

/** The day record of a warm-up step finished in Practice mode: the other fields stay as they are, only `warmupDone` grows. */
function warmupDayItem(day: TotalsRecord | undefined): TotalsItem {
  const item = itemOf(day)
  delete item.days
  item.warmupDone = Math.min(WARMUP_STEPS, warmupCount(day) + 1)
  return item
}

/**
 * Build the PUT body for one session on top of the latest server state (spec 8.4). Pure: call it again with a fresh
 * state after a 409 to "re-apply the session on top". A Practice session only bumps the practice counter.
 */
export function buildSessionPut(state: ProgressState, result: SessionResult, rules: LevelRules = DEFAULT_LEVEL_RULES): PutBody {
  const prev = state.games[result.gameId]
  const lastPlayed = result.playedAt.slice(0, 19)
  if (result.mode === 'practice') {
    const item = { ...itemOf(prev), practice: (prev?.practice ?? 0) + 1, lastPlayed }
    const practiceBody: PutBody = { mutation_id: result.id, game: { id: result.gameId, revision: prev?.revision ?? 0, item } }
    if (result.warmup) {
      const day = state.days[result.date]
      practiceBody.day = { date: result.date, revision: day?.revision ?? 0, item: warmupDayItem(day) }
    }
    return practiceBody
  }
  const score = result.summary.score
  const levelState = applyLevelRule({
    level: prev?.level ?? INITIAL_LEVEL_STATE.level,
    consecutiveHigh: prev?.consecutiveHigh ?? 0,
    consecutiveLow: prev?.consecutiveLow ?? 0,
  }, score, rules)
  const playedLevel = clampLevel(result.level)
  const item: Record<string, unknown> = {
    ...itemOf(prev),
    level: levelState.level,
    consecutiveHigh: levelState.consecutiveHigh,
    consecutiveLow: levelState.consecutiveLow,
    sessions: (prev?.sessions ?? 0) + 1,
    best: Math.max(prev?.best ?? 0, score),
    emaScore: nextEma(prev?.emaScore, ratedScore(score, playedLevel)),
    lastScores: [...(prev?.lastScores ?? []), score].slice(-20),
    lastPlayed,
  }
  if (result.summary.stats) item.stats = result.summary.stats
  const body: PutBody = { mutation_id: result.id, game: { id: result.gameId, revision: prev?.revision ?? 0, item } }

  const day = state.days[result.date]
  const dayItem = addToTotals(day, result, !day)
  dayItem.categoryScores = dayCategoryScores(dayItem.games)
  if (result.summary.expectancyR !== undefined) dayItem.expectancyR = result.summary.expectancyR
  if (result.summary.discipline !== undefined) dayItem.discipline = result.summary.discipline
  delete dayItem.days
  if (result.warmup) dayItem.warmupDone = Math.min(WARMUP_STEPS, warmupCount(day) + 1)
  body.day = { date: result.date, revision: day?.revision ?? 0, item: dayItem }

  const monthKey = result.date.slice(0, 7)
  const month = state.months[monthKey]
  const monthItem = addToTotals(month, result, !day)
  body.month = { month: monthKey, revision: month?.revision ?? 0, item: monthItem }
  return body
}

/** True when the server already holds this session (a retry after a lost response). */
export function alreadyApplied(state: ProgressState, result: SessionResult): boolean {
  if (state.games[result.gameId]?.last_mutation_id === result.id) return true
  return false
}
