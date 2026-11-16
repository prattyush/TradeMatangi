/**
 * Regime Switch (spec 5.7): a chain of segments; for each the player picks a playbook, FOLLOW the last 30 seconds, FADE them or STAND
 * ASIDE. The hold then replays and the three playbooks are ranked on their net result (costs included), so there is always a defined best.
 * The regimes change every few segments, and repeating the playbook that just worked after the regime changed is penalised
 * (perseveration). Pure and seeded; the data is the same window as Tick Reader's (a stretch before the decision and a hold after).
 */
import { clamp, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { REGIME_SWITCH } from '../../config/difficulty.market'
import type { RoundPlan } from '../../engine/roundSource'
import { classifyRegime, lastDirection, REGIMES, type Regime, type RegimeInfo } from '../../engine/regime'
import type { WindowData } from '../../engine/series'
import { buildRound, preSeconds, type RoundContext, type TickRound } from '../tick_reader/engine'

export type Playbook = 'follow' | 'fade' | 'aside'
export const PLAYBOOKS: readonly Playbook[] = ['follow', 'fade', 'aside']
export const PLAYBOOK_LABEL: Record<Playbook, string> = { follow: 'FOLLOW', fade: 'FADE', aside: 'STAND ASIDE' }

export interface Segment {
  round: TickRound
  regime: RegimeInfo
  /** The direction of the last 30 seconds: +1 up, -1 down. */
  direction: 1 | -1
  /** Net option points of each playbook, and its rank score (1, 0.5, 0; ties share). */
  outcomes: Record<Playbook, number>
  ranks: Record<Playbook, number>
  best: Playbook
}

export interface SegmentSpec { id: string; symbol: string; date: string; decisionSec: number; segSec: number; holdSec: number }

/** Rank scores of three values (higher is better); equal values share the scores of the places they take. */
export function rankScores(values: Record<Playbook, number>): Record<Playbook, number> {
  const order = [...PLAYBOOKS].sort((a, b) => values[b] - values[a])
  const out = {} as Record<Playbook, number>
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && Math.abs(values[order[j + 1]] - values[order[i]]) < 1e-9) j += 1
    const share = (REGIME_SWITCH.rankScores as readonly number[]).slice(i, j + 1).reduce((s, v) => s + v, 0) / (j - i + 1)
    for (let k = i; k <= j; k++) out[order[k]] = share
    i = j + 1
  }
  return out
}

export function buildSegment(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: SegmentSpec, ctx: RoundContext): Segment | null {
  const round = buildRound(window, { id: spec.id, symbol: spec.symbol, date: spec.date, decisionSec: spec.decisionSec, lookbackSec: spec.segSec, holdSec: spec.holdSec }, ctx)
  if (!round) return null
  const direction = lastDirection(round.lookback, REGIME_SWITCH.directionSec)
  if (direction === 0) return null // no direction in the last 30 seconds: FOLLOW and FADE would mean nothing
  const gross = round.move * REGIME_SWITCH.deltaProxy
  const outcomes: Record<Playbook, number> = { follow: direction * gross - round.costPts, fade: -direction * gross - round.costPts, aside: 0 }
  const ranks = rankScores(outcomes)
  const best = [...PLAYBOOKS].sort((a, b) => outcomes[b] - outcomes[a])[0]
  return { round, regime: classifyRegime(round.lookback, round.volUnit, spec.segSec), direction, outcomes, ranks, best }
}

export interface Previous { regime: Regime; playbook: Playbook }

export interface SegmentResult {
  playbook: Playbook | 'timeout'
  regime: Regime
  /** The regime of the segment before (null for the first). */
  previous: Regime | null
  changed: boolean
  best: Playbook
  correct: boolean
  roundScore: number
  /** The previous playbook, repeated after a change when it was no longer the best. */
  perseveration: boolean
  /** A change where the old playbook was no longer best, so perseveration was possible. */
  chance: boolean
}

/**
 * Rank-based: best 1, second 0.5, worst 0. After a regime change, repeating the previous playbook when it is no longer the best takes
 * 0.25 off (floor 0). A late choice scores 0.
 */
export function scoreSegment(segment: Segment, answer: Playbook | 'timeout', previous: Previous | null): SegmentResult {
  const changed = previous !== null && previous.regime !== segment.regime.regime
  const chance = changed && previous!.playbook !== segment.best
  const common = { regime: segment.regime.regime, previous: previous?.regime ?? null, changed, best: segment.best, chance }
  if (answer === 'timeout') return { ...common, playbook: 'timeout', correct: false, roundScore: 0, perseveration: false }
  const perseveration = chance && answer === previous!.playbook
  return { ...common, playbook: answer, correct: answer === segment.best, roundScore: clamp(segment.ranks[answer] - (perseveration ? REGIME_SWITCH.perseverationPenalty : 0), 0, 1), perseveration }
}

const round2 = (value: number): number => Math.round(value * 100) / 100
const share = (count: number, of: number): number => (of ? round2((count / of) * 100) : 0)

/** `SessionScore = 100 x mean(roundScore)`. Stats: perseveration rate, switch accuracy, and the playbook bias. */
export function summariseRegime(results: SegmentResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((sum, r) => sum + r.roundScore, 0) / n : 0
  const changes = results.filter(r => r.changed)
  const chosen = results.filter(r => r.playbook !== 'timeout')
  return {
    score: toSessionScore(100 * mean),
    stats: {
      segments: n,
      regime_changes: changes.length,
      persev_rate: share(results.filter(r => r.perseveration).length, results.filter(r => r.chance).length),
      switch_accuracy: share(changes.filter(r => r.correct).length, changes.length),
      follow_share: share(chosen.filter(r => r.playbook === 'follow').length, chosen.length),
      fade_share: share(chosen.filter(r => r.playbook === 'fade').length, chosen.length),
      aside_share: share(chosen.filter(r => r.playbook === 'aside').length, chosen.length),
      timeouts: n - chosen.length,
    },
  }
}

/** How long (in segments) the next regime lasts: around `changeEvery`, one less to one more, at least 1. */
export const runLength = (rng: Rng, changeEvery: number): number => Math.max(1, Math.round(changeEvery) - 1 + rng.int(0, 2))

/** The next regime to look for: a different one, weighted so rare spikes are not asked for every time. */
export function nextRegime(rng: Rng, current: Regime | null): Regime {
  const options = REGIMES.filter(r => r !== current)
  const total = options.reduce((s, r) => s + REGIME_SWITCH.nextWeights[r], 0)
  let x = rng.next() * total
  for (const r of options) { x -= REGIME_SWITCH.nextWeights[r]; if (x <= 0) return r }
  return options[options.length - 1]
}

/**
 * What the round source needs. The plan walks a chain of wanted regimes (the same for a whole run of segments, then a change), asks
 * the source for a window of that regime and reports how well a candidate fits; the regime that actually comes back is what the game uses.
 */
export function regimePlan(params: Record<string, number>, ctx: RoundContext): RoundPlan<Segment> {
  const segSec = params.segSec, holdSec = params.holdSec
  let current: Regime | null = null
  let left = 0
  let wanted: Regime = 'range'
  return {
    rules: { preSec: preSeconds(segSec), postSec: holdSec },
    fetchBefore: preSeconds(segSec),
    fetchAfter: holdSec,
    build: (window, pick) => buildSegment(window, { id: pick.id, symbol: pick.symbol, date: pick.date, decisionSec: pick.decisionSec, segSec, holdSec }, ctx),
    wantNoEdge: rng => {
      if (current === null || left <= 0) { wanted = nextRegime(rng, current); current = wanted; left = runLength(rng, params.changeEvery) - 1 } else { wanted = current; left -= 1 }
      return false
    },
    misfit: segment => (segment.regime.regime === wanted ? 0 : 1),
  }
}
