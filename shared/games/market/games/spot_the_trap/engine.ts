/**
 * Spot the Trap (spec 5.9): telling a real breakout from a fake-out, and finding setups quickly in clutter.
 *
 *  - Mode A, breakout verdict: the chart stops at a bar that closes beyond the range of the last 24 bars; call it REAL or FAKE. The truth comes from the next
 *    minute (see `breakoutTruth`): REAL if it goes 2 volUnits beyond the level before coming back half a volUnit inside it.
 *  - Mode B, pattern hunt (from level 6): 60 bars, a named pattern, click every occurrence; scored by the F1 of the clicks (a click within a bar counts).
 *
 * Pure: the rounds are built from the 5 second bars of a fetched window with the deterministic detectors of `engine/patterns.ts`.
 */
import { toSessionScore } from '../../../core/scoring'
import { hashSeed, type Rng } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { SPOT_THE_TRAP } from '../../config/difficulty.market'
import { breakoutTruth, detectPattern, findBreakouts, huntF1, nearMisses, PATTERN_KINDS, type Breakout, type PatternKind } from '../../engine/patterns'
import type { RoundPlan } from '../../engine/roundSource'
import { aggregate, barsFromWindow, type Bars, type WindowData } from '../../engine/series'
import { median } from '../../engine/volUnit'

export type Verdict = 'real' | 'fake'

const FIVE = 5
const slice = (bars: Bars, from: number, to: number): Bars => ({ t: bars.t.slice(from, to), o: bars.o.slice(from, to), h: bars.h.slice(from, to), l: bars.l.slice(from, to), c: bars.c.slice(from, to) })
const shift = (bars: Bars, by: number): Bars => ({ t: bars.t, o: bars.o.map(v => v - by), h: bars.h.map(v => v - by), l: bars.l.map(v => v - by), c: bars.c.map(v => v - by) })
/** The median 5 second high-low range of a stretch: the volUnit of the round, measured on what the player can see. */
export const stretchVol = (bars: Bars): number => median(bars.t.map((_, i) => bars.h[i] - bars.l[i]))

export interface BreakoutRound {
  id: string
  symbol: string
  date: string
  /** The second of the day of the breakout bar. */
  breakoutSec: number
  direction: 1 | -1
  vol: number
  /** The bars on screen (the last one is the breakout bar) and the bars after it, in points from the level (the level is 0). */
  shown: Bars
  after: Bars
  ext: number
  ret: number
  real: boolean
  maxExtension: number
  extendedAt: number
  returnedAt: number
  /** How close the furthest extension came to the threshold, as a share of it (0 = exactly on the boundary). */
  margin: number
}

export interface BreakoutSpec { id: string; symbol: string; date: string; bars: number }
export interface BreakoutWant { real: boolean; ambiguous: boolean }

/** The five second bars of a window of one second bars. */
const fiveSecond = (window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>): Bars => aggregate(barsFromWindow(window), FIVE)

/** A breakout round from the window, the candidate best matching what is wanted (REAL or FAKE, near the boundary or clear). */
export function buildBreakoutRound(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: BreakoutSpec, want: BreakoutWant): BreakoutRound | null {
  const five = fiveSecond(window)
  const first = Math.max(spec.bars - 1, SPOT_THE_TRAP.lookback, SPOT_THE_TRAP.minBarsBeforeBreakout)
  const candidates: Array<{ b: Breakout; round: BreakoutRound }> = []
  const start = hashSeed(spec.id) % 7
  const all = findBreakouts(five, SPOT_THE_TRAP.lookback).filter(b => b.index >= first && b.index + SPOT_THE_TRAP.horizonBars < five.t.length)
  for (let k = 0; k < all.length; k++) {
    const b = all[(k + start) % all.length]
    const shownRaw = slice(five, b.index + 1 - spec.bars, b.index + 1)
    const vol = stretchVol(shownRaw)
    if (!(vol > 0)) continue
    const ext = SPOT_THE_TRAP.extMult * vol, ret = SPOT_THE_TRAP.retMult * vol
    const truth = breakoutTruth(five, b, ext, ret, SPOT_THE_TRAP.horizonBars)
    const margin = Math.abs(truth.maxExtension / ext - 1)
    candidates.push({ b, round: {
      id: spec.id, symbol: spec.symbol, date: spec.date, breakoutSec: five.t[b.index], direction: b.direction, vol,
      shown: shift(shownRaw, b.level), after: shift(slice(five, b.index + 1, b.index + 1 + SPOT_THE_TRAP.horizonBars), b.level), ext, ret, real: truth.real,
      maxExtension: truth.maxExtension, extendedAt: truth.extendedAt, returnedAt: truth.returnedAt, margin,
    } })
  }
  const fits = (c: { round: BreakoutRound }, strict: boolean) => c.round.real === want.real && (!strict || (c.round.margin <= SPOT_THE_TRAP.boundaryMargin) === want.ambiguous)
  return (candidates.find(c => fits(c, true)) ?? candidates.find(c => fits(c, false)) ?? candidates[0])?.round ?? null
}

export interface BreakoutResult { kind: 'breakout'; verdict: Verdict | 'timeout'; real: boolean; correct: boolean; roundScore: number }

/** 1 for the right call, 0 for the wrong one or a late one. */
export function scoreBreakout(round: BreakoutRound, verdict: Verdict | 'timeout'): BreakoutResult {
  const correct = verdict !== 'timeout' && (verdict === 'real') === round.real
  return { kind: 'breakout', verdict, real: round.real, correct, roundScore: correct ? 1 : 0 }
}

export interface HuntRound {
  id: string
  symbol: string
  date: string
  pattern: PatternKind
  startSec: number
  vol: number
  /** The bars on screen (60) in points from the first bar's open. */
  bars: Bars
  /** Indices of the true occurrences and of the near misses. */
  truth: number[]
  near: number[]
}

export interface HuntSpec { id: string; symbol: string; date: string; pattern: PatternKind; distractors: number }

/** A 60 bar stretch with 1 to 6 true occurrences of the pattern and at least `distractors` near misses (relaxed to what the window has). */
export function buildHuntRound(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: HuntSpec): HuntRound | null {
  const five = fiveSecond(window)
  const n = SPOT_THE_TRAP.huntBars
  if (five.t.length < n + 4) return null
  const options: HuntRound[] = []
  const start = hashSeed(spec.id) % 11
  const last = five.t.length - n
  for (let k = 0; k <= last; k += 3) {
    const from = (k + start * 3) % (last + 1)
    const stretch = slice(five, from, from + n)
    const vol = stretchVol(stretch)
    if (!(vol > 0)) continue
    const truth = detectPattern(spec.pattern, stretch, vol)
    if (truth.length < 1 || truth.length > SPOT_THE_TRAP.maxOccurrences) continue
    options.push({ id: spec.id, symbol: spec.symbol, date: spec.date, pattern: spec.pattern, startSec: stretch.t[0], vol, bars: shift(stretch, stretch.o[0]), truth, near: nearMisses(spec.pattern, stretch, vol) })
  }
  if (!options.length) return null
  return options.find(o => o.near.length >= spec.distractors) ?? options.sort((a, b) => b.near.length - a.near.length)[0]
}

export interface HuntResult { kind: 'hunt'; pattern: PatternKind; precision: number; recall: number; roundScore: number; clicks: number; truth: number; timedOut: boolean }

/** `roundScore = F1` of the clicks against the true occurrences (a click within one bar counts). */
export function scoreHunt(round: HuntRound, clicks: number[], timedOut = false): HuntResult {
  const f = huntF1(clicks, round.truth, 1)
  return { kind: 'hunt', pattern: round.pattern, precision: f.precision, recall: f.recall, roundScore: f.f1, clicks: clicks.length, truth: round.truth.length, timedOut }
}

export type SpotResult = BreakoutResult | HuntResult

const round2 = (value: number): number => Math.round(value * 100) / 100
const share = (count: number, of: number): number => (of ? round2((count / of) * 100) : 0)

/** `SessionScore = 100 x mean(roundScore)`. Stats: fake-out detection, real-breakout hesitation, per-pattern recall and precision. */
export function summariseSpot(results: SpotResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((s, r) => s + r.roundScore, 0) / n : 0
  const a = results.filter((r): r is BreakoutResult => r.kind === 'breakout'), b = results.filter((r): r is HuntResult => r.kind === 'hunt')
  const fakes = a.filter(r => !r.real), reals = a.filter(r => r.real)
  const stats: Record<string, number> = {
    rounds: n, breakouts: a.length, hunts: b.length,
    fake_accuracy: share(fakes.filter(r => r.correct).length, fakes.length),
    real_hesitation: share(reals.filter(r => r.verdict === 'fake').length, reals.length),
    timeouts: a.filter(r => r.verdict === 'timeout').length + b.filter(r => r.timedOut).length,
  }
  for (const kind of PATTERN_KINDS) {
    const rows = b.filter(r => r.pattern === kind)
    if (rows.length) { stats[`recall_${kind}`] = share(rows.reduce((s, r) => s + r.recall, 0), rows.length); stats[`precision_${kind}`] = share(rows.reduce((s, r) => s + r.precision, 0), rows.length) }
  }
  return { score: toSessionScore(100 * mean), stats }
}

/** Mode of round `index`: from level 6 the hunt alternates in (odd rounds), otherwise every round is a breakout. */
export const modeOf = (index: number, modeB: number): 'breakout' | 'hunt' => (modeB >= 1 && index % 2 === 1 ? 'hunt' : 'breakout')

/** The round source's view of mode A: a window long enough for `bars` bars before a breakout and the minute after it. */
export function breakoutPlan(params: Record<string, number>): RoundPlan<BreakoutRound> {
  const bars = params.bars
  let want: BreakoutWant = { real: true, ambiguous: false }
  return {
    rules: { preSec: Math.max(300, bars * FIVE), postSec: 420 },
    fetchBefore: Math.max(300, bars * FIVE),
    fetchAfter: 420,
    build: (window, pick) => buildBreakoutRound(window, { id: pick.id, symbol: pick.symbol, date: pick.date, bars }, want),
    wantNoEdge: (rng: Rng) => { want = { real: rng.chance(0.5), ambiguous: rng.chance(params.ambiguity) }; return want.real },
    misfit: round => (round.real === want.real ? 0 : 1) + ((round.margin <= SPOT_THE_TRAP.boundaryMargin) === want.ambiguous ? 0 : 0.4),
  }
}

/** The round source's view of mode B: the pattern is drawn from the level's pool once per round. */
export function huntPlan(params: Record<string, number>): RoundPlan<HuntRound> {
  const pool = PATTERN_KINDS.slice(0, Math.max(2, Math.min(PATTERN_KINDS.length, Math.round(params.patternPool))))
  let pattern: PatternKind = pool[0]
  return {
    rules: { preSec: 300, postSec: 360 },
    fetchBefore: 300,
    fetchAfter: 360,
    build: (window, pick) => buildHuntRound(window, { id: pick.id, symbol: pick.symbol, date: pick.date, pattern, distractors: Math.round(params.distractors) }),
    wantNoEdge: rng => { pattern = rng.pick(pool); return false },
    misfit: round => (round.near.length >= Math.round(params.distractors) ? 0 : 0.5),
  }
}
