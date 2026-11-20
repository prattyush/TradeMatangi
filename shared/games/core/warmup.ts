/**
 * The Daily Warm-up plan (spec 7.2, 17.8). Pure and deterministic: the same user, date, pool setting, progress and set of
 * playable games always give the same five steps, so reopening the tab never reshuffles the routine.
 *
 * As built (B6): the games run at their normal length (no "short version" switch in any View), so the fifth step is drawn from
 * games whose block is short (`WARMUP_QUICK`), and the Number Sprint step is the usual 90 s block. Market games are not playable
 * until Track G ships; `market` and `both` then fall back to brain games and say so in `notice`.
 */
import { CATEGORIES, catalogueEntry, type Category, type GameId, type Pool } from './ids'
import { daysBetween } from './dates'
import { createRng, hashSeed, type Rng } from './rng'
import type { ProgressState } from './progress'
import type { WarmupPool } from './settings'

export type WarmupRole = 'physical' | 'weakest' | 'second' | 'math' | 'random'
export interface WarmupStep { index: number; role: WarmupRole; gameId: GameId; reason: string }
export interface WarmupPlan { steps: WarmupStep[]; pool: WarmupPool; notice?: string }

/** Games short enough for the closing step. Block length or round count of each is in `brain/config/difficulty.brain.ts`. */
export const WARMUP_QUICK: readonly GameId[] = ['quick_match', 'colour_clash', 'green_light', 'flanker_flock', 'rule_switch', 'flip_map', 'needle_finder']

const NEVER_PLAYED = 100_000

/** A game counts as "played recently" when its last session was today or yesterday. */
export const RECENT_DAYS = 2

export interface WarmupInput {
  userId: string
  /** Local date `YYYY-MM-DD`. */
  date: string
  pool: WarmupPool
  /** Ids of the games that can be played now (the registry). */
  playable: readonly GameId[]
  state: Pick<ProgressState, 'games'>
}

const poolOf = (id: GameId): Pool => catalogueEntry(id).pool
const categoryOf = (id: GameId): Category => catalogueEntry(id).category

function lastPlayedDay(state: WarmupInput['state'], id: GameId): string | undefined {
  const stamp = state.games[id]?.lastPlayed
  return typeof stamp === 'string' && stamp.length >= 10 ? stamp.slice(0, 10) : undefined
}

export function buildWarmup(input: WarmupInput): WarmupPlan {
  const rng = createRng(hashSeed(`${input.userId}|${input.date}|warmup`))
  const playable = new Set(input.playable)
  const marketReady = [...playable].some(id => poolOf(id) === 'market')
  const wantsMarket = input.pool !== 'brain'
  const allowed = (id: GameId) => playable.has(id) && (poolOf(id) === 'brain' || (wantsMarket && marketReady))
  const notice = wantsMarket && !marketReady ? 'The market games are not available yet, so this warm-up uses brain games.' : undefined
  const effectivePool: WarmupPool = marketReady ? input.pool : 'brain'
  const candidates = [...playable].filter(allowed)

  const used = new Set<GameId>()
  const steps: WarmupStep[] = []
  const add = (role: WarmupRole, gameId: GameId, reason: string) => { used.add(gameId); steps.push({ index: steps.length + 1, role, gameId, reason }) }

  // Rating of a category within one pool (undefined = never played): the lower, the more it needs the practice.
  const ratingIn = (category: Category, pool: Pool): number | undefined => {
    const values = candidates.filter(id => categoryOf(id) === category && poolOf(id) === pool)
      .map(id => input.state.games[id]?.emaScore).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined
  }
  const ratingAll = (category: Category): number | undefined => {
    const values = candidates.filter(id => categoryOf(id) === category)
      .map(id => input.state.games[id]?.emaScore).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined
  }

  // 1. Physical warm-up.
  const physical: GameId = allowed('hotkey_drill') && effectivePool !== 'brain' ? 'hotkey_drill' : 'quick_match'
  if (allowed(physical)) add('physical', physical, physical === 'hotkey_drill' ? 'Warms up the hands on the order keys.' : 'A one-minute speed warm-up.')

  // Two weakest categories that have an unused game to play. A category never played counts as the weakest.
  const withGames = CATEGORIES.filter(category => candidates.some(id => categoryOf(id) === category && !used.has(id)))
  const tieBreak = new Map<Category, number>(withGames.map(category => [category, rng.next()]))
  const ranked = [...withGames].sort((a, b) => (ratingAll(a) ?? -1) - (ratingAll(b) ?? -1) || (tieBreak.get(a) ?? 0) - (tieBreak.get(b) ?? 0))

  let lastPool: Pool | null = physical && allowed(physical) ? poolOf(physical) : null
  const pickFrom = (category: Category, role: WarmupRole, preferOther: boolean, why: string) => {
    const available = candidates.filter(id => categoryOf(id) === category && !used.has(id))
    if (!available.length) return false
    const pools = [...new Set(available.map(poolOf))]
    let chosenPool: Pool = pools[0]
    if (pools.length > 1) {
      const brainRating = ratingIn(category, 'brain') ?? -1
      const marketRating = ratingIn(category, 'market') ?? -1
      chosenPool = marketRating < brainRating ? 'market' : 'brain'
      if (preferOther && lastPool && pools.includes(lastPool === 'brain' ? 'market' : 'brain')) chosenPool = lastPool === 'brain' ? 'market' : 'brain'
    }
    const inPool = available.filter(id => poolOf(id) === chosenPool)
    const game = leastRecent(inPool, input, rng)
    add(role, game, why)
    lastPool = chosenPool
    return true
  }

  const [first, second] = ranked
  if (first) pickFrom(first, 'weakest', false, `${labelOf(first)} is your weakest category.`)
  if (second) pickFrom(second, 'second', true, `${labelOf(second)} is your second weakest category.`)

  // 4. Arithmetic.
  const math: GameId = allowed('risk_calculator') && effectivePool !== 'brain' ? 'risk_calculator' : 'number_sprint'
  if (allowed(math) && !used.has(math)) add('math', math, math === 'risk_calculator' ? 'Position sizing, six questions.' : 'Quick mental arithmetic.')

  // 5. One more, short. Draw from the pool used least so far.
  const quick = candidates.filter(id => !used.has(id) && (poolOf(id) === 'market' || WARMUP_QUICK.includes(id)))
  if (quick.length) {
    const count = (pool: Pool) => steps.filter(step => poolOf(step.gameId) === pool).length
    const pools = [...new Set(quick.map(poolOf))].sort((a, b) => count(a) - count(b) || (a < b ? -1 : 1))
    const inPool = quick.filter(id => poolOf(id) === pools[0])
    add('random', rng.pick(inPool), 'A short extra game picked for the day.')
  }
  steps.forEach((step, i) => { step.index = i + 1 })
  return { steps, pool: effectivePool, notice }
}

const labelOf = (category: Category): string => category.charAt(0).toUpperCase() + category.slice(1)

/** The game of a list that has gone longest without being played (never played first, then the oldest day); ties by the seeded stream. */
function leastRecent(ids: GameId[], input: WarmupInput, rng: Rng): GameId {
  const keyed = ids.map(id => {
    const day = lastPlayedDay(input.state, id)
    const age = day === undefined ? NEVER_PLAYED : daysBetween(day, input.date)
    return { id, age, tie: rng.next() }
  })
  // "Not played in the last 2 days" first; among those the one longest ago; otherwise the least recent of the rest.
  keyed.sort((a, b) => (b.age >= RECENT_DAYS ? 1 : 0) - (a.age >= RECENT_DAYS ? 1 : 0) || b.age - a.age || a.tie - b.tie)
  return keyed[0].id
}
