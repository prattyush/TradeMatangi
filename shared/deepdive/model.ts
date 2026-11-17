/** Pure Deep Dive logic shared by every host: day marks, tag gaps, navigation and the percentage wording. */
import type {
  DeepDiveSetup, DeepDiveTag, Dive, DiveSetup, SetupRef, Side, StatsAllEntry, StatsBlock, TagState, TagStat, TagValue,
} from './types'

export const SIDES: Side[] = ['buy', 'sell']
export const MAX_TAG_NAME = 140
/** Fewer marked days than this and a percentage is shown with a warning (the server uses the same number). */
export const FEW_DAYS = 5

export const sideLabel = (side: Side) => (side === 'buy' ? 'Buy' : 'Sell')
/** A Buy setup on the underlying is traded as a CE, a Sell setup as a PE. */
export const strikeLabel = (mode: string) => (mode === 'max_price' ? 'Max Price' : mode === 'otm' ? 'OTM' : mode)
export const optionRight = (side: Side): 'CE' | 'PE' => (side === 'buy' ? 'CE' : 'PE')

/** Plain words for the two sides, for tooltips and hints: a Buy setup is bullish, a Sell setup bearish. */
export const SIDE_MEANING = 'Buy = long / bullish (long equity or index, CE bought, PE sold). Sell = short / bearish (short equity, PE bought, CE sold).'

/**
 * Which side of a deep dive a position belongs to: the direction it profits from. A long equity (or index) position is a Buy
 * setup, a short one a Sell setup. A bought CE is a Buy setup and a bought PE a Sell setup; selling flips both, so a short CE is
 * a Sell setup and a short PE a Buy setup. `action` is the side of the order that opened the position. Null when unknown.
 */
export function setupSideOfTrade(trade: { right?: string | null; action?: string | null }): Side | null {
  const action = (trade.action ?? '').toUpperCase()
  if (action !== 'BUY' && action !== 'SELL') return null
  const long = action === 'BUY'
  const put = (trade.right ?? '').toUpperCase() === 'PE'
  return long !== put ? 'buy' : 'sell'
}

type DayKey = Pick<SetupRef, 'date' | 'symbol' | 'side'>
export const setupId = (setup: DayKey) => `${setup.date}|${setup.symbol}|${setup.side}`

/** Date ascending, a day's Buy before its Sell: the order the in-depth step walks. */
export function orderSetups<T extends DayKey>(setups: readonly T[]): T[] {
  return [...setups].sort((a, b) =>
    a.date.localeCompare(b.date) || SIDES.indexOf(a.side) - SIDES.indexOf(b.side) || a.symbol.localeCompare(b.symbol))
}

// ── Calendar marks ───────────────────────────────────────────────────────────

export interface DayMarks { buy: boolean; sell: boolean }

export function dayMarks(setups: readonly DayKey[], date: string, symbol?: string): DayMarks {
  const day = setups.filter(s => s.date === date && (symbol === undefined || s.symbol === symbol))
  return { buy: day.some(s => s.side === 'buy'), sell: day.some(s => s.side === 'sell') }
}

export function dayMarksByDate(setups: readonly DayKey[]): Map<string, DayMarks> {
  const marks = new Map<string, DayMarks>()
  for (const setup of setups) {
    const current = marks.get(setup.date) ?? { buy: false, sell: false }
    marks.set(setup.date, { ...current, [setup.side]: true })
  }
  return marks
}

/** What un-marking a side would throw away: shown in a confirmation before the day is removed. */
export function removalImpact(setup: Pick<DeepDiveSetup, 'tag_values' | 'annotations' | 'outcome' | 'notes'>) {
  const tagMarks = Object.keys(setup.tag_values).length
  const chartMarks = setup.annotations.length
  const hasOutcome = setup.outcome !== null
  const hasNotes = setup.notes.trim().length > 0
  return { tagMarks, chartMarks, hasOutcome, hasNotes, hasData: tagMarks > 0 || chartMarks > 0 || hasOutcome || hasNotes }
}

// ── Tags: states and gaps ────────────────────────────────────────────────────

export const activeTags = (tags: readonly DeepDiveTag[]) => tags.filter(tag => tag.status === 'active')

export function tagState(setup: Pick<DeepDiveSetup, 'tag_values'>, tagId: string): TagState {
  const value = setup.tag_values[tagId]
  return value === undefined ? 'unmarked' : value ? 'valid' : 'not_valid'
}

/** What the server stores for a state: true valid, false not valid, null back to unmarked. */
export const tagValueOf = (state: TagState): TagValue | null => (state === 'valid' ? true : state === 'not_valid' ? false : null)

/** One tap on a tag chip: the same state again clears it, so a wrong tap is one tap to undo. */
export const toggleTag = (current: TagState, wanted: 'valid' | 'not_valid'): TagState => (current === wanted ? 'unmarked' : wanted)

export function unmarkedTagIds(setup: Pick<DeepDiveSetup, 'tag_values'>, tags: readonly DeepDiveTag[]): string[] {
  return activeTags(tags).filter(tag => !(tag.tag_id in setup.tag_values)).map(tag => tag.tag_id)
}

export const isComplete = (setup: Pick<DeepDiveSetup, 'tag_values'>, tags: readonly DeepDiveTag[]) => unmarkedTagIds(setup, tags).length === 0

/** The "Mark the rest not valid" shortcut: every unmarked active tag becomes Not valid. */
export function restNotValid(setup: Pick<DeepDiveSetup, 'tag_values'>, tags: readonly DeepDiveTag[]): Record<string, false> {
  return Object.fromEntries(unmarkedTagIds(setup, tags).map(id => [id, false as const]))
}

/** Local copy of a setup after `PUT setup/tag-values`, so the screen updates before the server answers. */
export function applyTagValues<T extends Pick<DeepDiveSetup, 'tag_values'>>(setup: T, values: Record<string, TagValue | null>): T {
  const next = { ...setup.tag_values }
  for (const [tagId, value] of Object.entries(values)) {
    if (value === null) delete next[tagId]
    else next[tagId] = value
  }
  return { ...setup, tag_values: next }
}

export interface Gap { id: string; date: string; symbol: string; side: Side; missing: number; tagIds: string[] }

/** The "Needs marking" list: every day with unmarked active tags, in walking order. */
export function gaps(setups: readonly DeepDiveSetup[], tags: readonly DeepDiveTag[]): Gap[] {
  return orderSetups(setups).flatMap(setup => {
    const tagIds = unmarkedTagIds(setup, tags)
    return tagIds.length ? [{ id: setupId(setup), date: setup.date, symbol: setup.symbol, side: setup.side, missing: tagIds.length, tagIds }] : []
  })
}

/** How many marked days have not looked at this tag: shown when a tag is added ("leaves 6 earlier days unmarked"). */
export const unmarkedDaysForTag = (setups: readonly DeepDiveSetup[], tagId: string) => setups.filter(s => !(tagId in s.tag_values)).length

export function validateTagName(name: string, tags: readonly DeepDiveTag[], excludeId?: string): string | null {
  const cleaned = name.split(/\s+/).filter(Boolean).join(' ')
  if (!cleaned) return 'Tag name must not be empty'
  if (cleaned.length > MAX_TAG_NAME) return `Tag name must be at most ${MAX_TAG_NAME} characters`
  const folded = cleaned.toLowerCase()
  if (activeTags(tags).some(tag => tag.tag_id !== excludeId && tag.name.toLowerCase() === folded)) return 'An active tag with this name already exists'
  return null
}

/** A setup as `GET /dive` returns it, computed locally after a save so the screen need not reload the dive. */
export function toDiveSetup(setup: DeepDiveSetup, tags: readonly DeepDiveTag[]): DiveSetup {
  const missing = unmarkedTagIds(setup, tags)
  return { ...setup, missing, complete: missing.length === 0 }
}

/** The dive with a new list of setups: ordered, with the gap counters recomputed. */
export function withSetups(dive: Dive, setups: readonly DiveSetup[]): Dive {
  const ordered = orderSetups(setups)
  return { ...dive, setups: ordered, incomplete_days: ordered.filter(s => !s.complete).length, unmarked_total: ordered.reduce((sum, s) => sum + s.missing.length, 0) }
}

/** The dive with a new tag list (a tag added, archived or restored): every day's gaps are worked out again. */
export function withTags(dive: Dive, tags: readonly DeepDiveTag[]): Dive {
  return withSetups({ ...dive, tags: [...tags] }, dive.setups.map(setup => toDiveSetup(setup, tags)))
}

// ── Walking the days ─────────────────────────────────────────────────────────

export const stepIndex = (index: number, delta: number, length: number) => (length <= 0 ? 0 : Math.min(length - 1, Math.max(0, index + delta)))

/** The next day after ``from`` that still has unmarked tags, wrapping to the start; -1 when everything is marked. */
export function nextGapIndex(setups: readonly DeepDiveSetup[], tags: readonly DeepDiveTag[], from: number): number {
  const count = setups.length
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (from + offset) % count
    if (!isComplete(setups[index], tags)) return index
  }
  return -1
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `2026-03-11` as `11 Mar 2026`, without going through a time zone. */
export function formatDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return MONTHS[month - 1] ? `${day} ${MONTHS[month - 1]} ${year}` : date
}

/** `3 / 12 · 11 Mar 2026 · BUY`; with `omitYear` the year of that value is left out (`11 Mar`), to keep the header row short. */
export const positionLabel = (index: number, setups: readonly DayKey[], omitYear?: number) => {
  if (!setups.length) return 'No days marked'
  const day = formatDay(setups[index].date)
  return `${index + 1} / ${setups.length} · ${omitYear !== undefined && day.endsWith(` ${omitYear}`) ? day.slice(0, -5) : day} · ${setups[index].side.toUpperCase()}`
}

// ── Percentages ──────────────────────────────────────────────────────────────

export const formatPct = (pct: number | null) => (pct === null ? '—' : `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`)
export const nLabel = (marked: number) => `n=${marked}`

/** `Double top: 70% (n=14)` */
export const tagLine = (stat: TagStat) => `${stat.name}: ${formatPct(stat.pct)} (${nLabel(stat.marked)})`

/** Why a percentage should not be trusted yet, or null when the sample is big enough. */
export function thinNote(marked: number): string | null {
  if (marked === 0) return 'Not marked on any day yet'
  return marked < FEW_DAYS ? `Only ${marked} ${marked === 1 ? 'day' : 'days'} marked` : null
}

/**
 * One decimal, ties to even like the server's Python `round(x, 1)`, so a percentage reads the same here and in a label form
 * (6.25 is 6.2 on both, not 6.3).
 */
export function roundTenth(value: number): number {
  const scaled = value * 10
  const floor = Math.floor(scaled)
  const tie = Math.abs(scaled - floor - 0.5) < 1e-9
  return (tie ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(scaled)) / 10
}

/**
 * Frequency percentages of a dive from its days, the same arithmetic as the server's `compute_stats`: a tag's percentage is
 * valid / the days where THAT tag was marked, an archived tag is left out, the success rate is over days with an outcome.
 */
export function computeStats(setups: readonly DeepDiveSetup[], tags: readonly DeepDiveTag[], side: Side | null = null): StatsBlock {
  const days = setups.filter(setup => side === null || setup.side === side)
  const rows: TagStat[] = activeTags(tags).map(tag => {
    const marks = days.filter(day => tag.tag_id in day.tag_values).map(day => day.tag_values[tag.tag_id])
    const valid = marks.filter(Boolean).length
    return {
      tag_id: tag.tag_id, name: tag.name, valid, not_valid: marks.length - valid, marked: marks.length,
      pct: marks.length ? roundTenth((100 * valid) / marks.length) : null, few_days: marks.length < FEW_DAYS,
    }
  })
  const withOutcome = days.filter(day => day.outcome)
  const success = withOutcome.filter(day => day.outcome === 'success').length
  return {
    days: days.length, buy_days: days.filter(d => d.side === 'buy').length, sell_days: days.filter(d => d.side === 'sell').length,
    tags: rows, success, failed: withOutcome.length - success, with_outcome: withOutcome.length,
    success_pct: withOutcome.length ? roundTenth((100 * success) / withOutcome.length) : null, outcome_few_days: withOutcome.length < FEW_DAYS,
  }
}

/** One dot per active tag for a day's row: its name and state, in tag order. */
export const tagDots = (setup: Pick<DeepDiveSetup, 'tag_values'>, tags: readonly DeepDiveTag[]) =>
  activeTags(tags).map(tag => ({ tag_id: tag.tag_id, name: tag.name, state: tagState(setup, tag.tag_id) }))

/** Tags with the most frequent first; tags nobody has marked sink to the bottom. */
export function sortTagStats(rows: readonly TagStat[]): TagStat[] {
  return [...rows].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.marked - a.marked || a.name.localeCompare(b.name))
}

export const successLine = (block: Pick<StatsBlock, 'success' | 'with_outcome' | 'success_pct'>) =>
  block.with_outcome ? `Success ${block.success} of ${block.with_outcome} (${formatPct(block.success_pct)})` : 'No outcome marked yet'

export const blockFor = (entry: StatsAllEntry, side: Side | 'all'): StatsBlock => entry[side]

/** The side a label form opens on: the position's direction (see `setupSideOfTrade`), or All when it cannot be told. */
export const defaultSideForTrade = (trade: { right?: string | null; action?: string | null }): Side | 'all' => setupSideOfTrade(trade) ?? 'all'

/** The stats of one strategy for a label form, or null when the strategy has no marked days. */
export function findStats(entries: readonly StatsAllEntry[], category: string, strategy: string): StatsAllEntry | null {
  return entries.find(entry => entry.category === category && entry.strategy === strategy && entry.all.days > 0) ?? null
}
