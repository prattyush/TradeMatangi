/**
 * Window picking (spec 4.3). Pure: the caller supplies the availability list (from `GET /availability`), a seeded stream and the
 * windows already seen; this returns which `(symbol, date, second)` to fetch. Nothing is fetched here.
 */
import type { Rng } from '../../core/rng'

/** The shape of `GET /availability` that the games read. */
export interface Availability {
  index_missing?: boolean
  symbols: Record<string, { lot_size?: number | null; strike_step?: number | null; dates: string[]; options?: Record<string, unknown> }>
}

export const SESSION_OPEN_SEC = 9 * 3600 + 15 * 60
export const SESSION_CLOSE_SEC = 15 * 3600 + 30 * 60
/** Decision points sit on this grid, so a window id repeats exactly or not at all. */
export const GRID_SEC = 30
export const DEFAULT_NO_REPEAT_DAYS = 30

export interface PickRules {
  /** Seconds of data needed before the decision point (the longer of the lookback and the 5 minutes volUnit reads). */
  preSec: number
  /** Seconds needed after it (the hold). */
  postSec: number
  /** Keep this far from the open and the close. */
  avoidOpenSec?: number
  avoidCloseSec?: number
}

export interface WindowPick { symbol: string; date: string; decisionSec: number; id: string }

/** `symbol|date|startSecond` (spec 2): the start second here is the decision point. */
export const windowId = (symbol: string, date: string, startSec: number): string => `${symbol}|${date}|${startSec}`

/** Every `(symbol, date)` pair the server lists, restricted to `symbols` when given. */
export function listDays(availability: Availability, symbols?: readonly string[]): Array<{ symbol: string; date: string }> {
  const out: Array<{ symbol: string; date: string }> = []
  for (const [symbol, entry] of Object.entries(availability.symbols ?? {})) {
    if (symbols && !symbols.includes(symbol)) continue
    for (const date of entry.dates ?? []) out.push({ symbol, date })
  }
  return out
}

/** The earliest and latest decision second a window may have, or null when the session is too short for the rules. */
export function decisionRange(rules: PickRules): { first: number; last: number } | null {
  const first = Math.ceil((SESSION_OPEN_SEC + (rules.avoidOpenSec ?? 600) + rules.preSec) / GRID_SEC) * GRID_SEC
  const last = Math.floor((SESSION_CLOSE_SEC - (rules.avoidCloseSec ?? 300) - rules.postSec) / GRID_SEC) * GRID_SEC
  return last >= first ? { first, last } : null
}

/**
 * One window, drawn uniformly over the listed days and over the allowed decision seconds. A window in `seen` (played in the last
 * `noRepeatDays`) or in `excluded` (failed or used this session) is redrawn; after `attempts` tries it gives up and returns null.
 */
export function pickWindow(rng: Rng, availability: Availability, rules: PickRules, seen: ReadonlySet<string>, excluded: ReadonlySet<string> = new Set(),
  options: { symbols?: readonly string[]; attempts?: number } = {}): WindowPick | null {
  const days = listDays(availability, options.symbols)
  const range = decisionRange(rules)
  if (!days.length || !range) return null
  const slots = (range.last - range.first) / GRID_SEC + 1
  for (let attempt = 0; attempt < (options.attempts ?? 60); attempt++) {
    const day = days[rng.int(0, days.length - 1)]
    const decisionSec = range.first + rng.int(0, slots - 1) * GRID_SEC
    const id = windowId(day.symbol, day.date, decisionSec)
    if (seen.has(id) || excluded.has(id)) continue
    return { symbol: day.symbol, date: day.date, decisionSec, id }
  }
  return null
}
