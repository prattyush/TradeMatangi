/**
 * Pure models behind the Dashboard (spec 7.1, 17.8): per-game rows, the Brain / Market / All filter, the warm-up streak and the
 * brain trend panels. The server keeps the last 20 scores and only the latest `stats` of each game, so a trend of a stat
 * (Stroop effect, switch cost...) comes from the sessions kept on this device (`data/sessionLog.ts`). That also fits spec 17.3 rule 6:
 * reaction times are only compared on the device they were measured on.
 */
import { catalogueEntry, gamesIn, type Category, type GameId, type Pool } from './ids'
import { daysBetween, shiftDate } from './dates'
import type { ProgressState, TotalsRecord } from './progress'
import type { ReviewRow } from './trial'
import type { SessionMode } from './types'

/** Warm-up length and the number of steps that keep the streak alive (spec 7.2). */
export const WARMUP_STEPS = 5
export const WARMUP_MIN_FOR_STREAK = 4

export type PoolFilter = Pool | 'all'

export interface GameRow {
  id: GameId
  title: string
  category: Category
  pool: Pool
  level: number
  sessions: number
  practice: number
  best: number | undefined
  rating: number | undefined
  /** Last scores, oldest first (the server keeps 20). */
  scores: number[]
  lastPlayed: string | undefined
}

export function gameRows(state: ProgressState, filter: PoolFilter): GameRow[] {
  return gamesIn(filter).map(entry => {
    const record = state.games[entry.id]
    return {
      id: entry.id, title: entry.title, category: entry.category, pool: entry.pool,
      level: record?.level ?? 1, sessions: record?.sessions ?? 0, practice: record?.practice ?? 0,
      best: record?.best, rating: record?.emaScore, scores: record?.lastScores ?? [], lastPlayed: record?.lastPlayed,
    }
  })
}

/** Steps of the warm-up finished on a day. `true` (a boolean from an older client) means the whole routine. */
export function warmupCount(day: TotalsRecord | undefined): number {
  const done = day?.warmupDone
  if (done === true) return WARMUP_STEPS
  if (typeof done === 'number' && Number.isFinite(done)) return Math.max(0, Math.min(WARMUP_STEPS, Math.floor(done)))
  return 0
}
export const warmupKept = (day: TotalsRecord | undefined): boolean => warmupCount(day) >= WARMUP_MIN_FOR_STREAK

export interface Streak { current: number; best: number; doneToday: boolean }

/** Consecutive days with a kept warm-up. The streak is still alive today if yesterday was kept and today is not done yet. */
export function warmupStreak(days: Record<string, TotalsRecord>, today: string): Streak {
  const kept = Object.keys(days).filter(date => warmupKept(days[date])).sort()
  let best = 0, run = 0, previous: string | null = null
  for (const date of kept) {
    run = previous !== null && daysBetween(previous, date) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    previous = date
  }
  const set = new Set(kept)
  const doneToday = set.has(today)
  let cursor = doneToday ? today : shiftDate(today, -1)
  let current = 0
  while (set.has(cursor)) { current += 1; cursor = shiftDate(cursor, -1) }
  return { current, best, doneToday }
}

/** One finished session as kept on this device. `review` is only kept for the newest sessions. */
export interface LocalSession {
  id: string
  gameId: GameId
  date: string
  level: number
  mode: SessionMode
  seed: number
  score: number
  stats?: Record<string, number>
  playedAt: string
  review?: ReviewRow[]
}

export interface TrendPanel {
  id: string
  title: string
  gameId: GameId
  key: string
  unit: string
  better: 'lower' | 'higher'
  /** One line on what the number means. */
  note: string
}

/** The trend panels of spec 17.8 and 7.1: brain stats, and the market ones (expectancy; capture ratio and the rest join with their games). */
export const TREND_PANELS: readonly TrendPanel[] = [
  { id: 'stroop', title: 'Colour interference', gameId: 'colour_clash', key: 'stroop_effect', unit: 'ms', better: 'lower', note: 'How much slower you are when the word and the ink disagree.' },
  { id: 'flanker', title: 'Flanker interference', gameId: 'flanker_flock', key: 'flanker_effect', unit: 'ms', better: 'lower', note: 'How much slower you are when the side arrows point the other way.' },
  { id: 'switch', title: 'Switch cost', gameId: 'rule_switch', key: 'switch_cost_ms', unit: 'ms', better: 'lower', note: 'How much slower a trial is when the rule just changed.' },
  { id: 'adapt', title: 'Adaptation cost', gameId: 'flip_map', key: 'adaptation_cost_pct', unit: '%', better: 'lower', note: 'The accuracy lost on the first trials after the keys change meaning.' },
  { id: 'span_grid', title: 'Peak span, Grid Recall', gameId: 'grid_recall', key: 'peak_span', unit: 'tiles', better: 'higher', note: 'The longest pattern you reproduced.' },
  { id: 'span_seq', title: 'Peak span, Sequence Echo', gameId: 'sequence_echo', key: 'peak_span', unit: 'items', better: 'higher', note: 'The longest sequence you repeated.' },
  { id: 'nback', title: 'N reached', gameId: 'n_back_stream', key: 'n_reached', unit: 'back', better: 'higher', note: 'The n the block ended on.' },
  { id: 'tick_expectancy', title: 'Tick Reader expectancy', gameId: 'tick_reader', key: 'expectancy_pts', unit: 'pts', better: 'higher', note: 'Average net option points per trade after costs.' },
  { id: 'persev', title: 'Perseveration rate', gameId: 'card_sorter', key: 'persev_error_pct', unit: '%', better: 'lower', note: 'Errors that keep using the rule that just stopped working.' },
]

/** Values of a stat over the Progress sessions kept on this device, oldest first. A missing stat is skipped. */
export function trendSeries(sessions: LocalSession[], gameId: GameId, key: string, max = 30): number[] {
  const values = sessions
    .filter(entry => entry.gameId === gameId && entry.mode === 'progress' && typeof entry.stats?.[key] === 'number' && Number.isFinite(entry.stats[key]))
    .sort((a, b) => a.playedAt.localeCompare(b.playedAt))
    .map(entry => entry.stats![key])
  return values.slice(-max)
}

/** Direction of a series for the label next to its line: compares the average of the first and the last third. */
export function trendDirection(values: number[], better: 'lower' | 'higher'): 'better' | 'worse' | 'steady' | 'unknown' {
  if (values.length < 4) return 'unknown'
  const third = Math.max(1, Math.floor(values.length / 3))
  const mean = (part: number[]) => part.reduce((a, b) => a + b, 0) / part.length
  const delta = mean(values.slice(-third)) - mean(values.slice(0, third))
  const spread = Math.max(...values) - Math.min(...values)
  if (spread === 0 || Math.abs(delta) < spread * 0.1) return 'steady'
  return (delta < 0) === (better === 'lower') ? 'better' : 'worse'
}

export const titleOf = (id: GameId): string => catalogueEntry(id).title
