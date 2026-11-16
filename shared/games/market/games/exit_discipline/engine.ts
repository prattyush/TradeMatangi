/**
 * Exit Discipline (spec 5.3): managing a trade that is already on. The trade is entered at time 0 in a given direction; the player
 * sets a plan (stop and target distances), the replay runs, and they may EXIT, TRAIL TO COST (stop to the entry) or LOCK (stop to
 * keep a share of the open profit). The stop and the target are enforced on every second.
 *
 * The result compares what the player did with the plan left alone (`R_plan`) and with the best the horizon offered (`R_mfe`).
 */
import { clamp, clamp01, toSessionScore } from '../../../core/scoring'
import { hashSeed, type Rng } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { EXIT_DISCIPLINE } from '../../config/difficulty.market'
import { costPoints, type CostSettings } from '../../engine/costModel'
import type { RoundPlan } from '../../engine/roundSource'
import { barsFromWindow, closeAtOrBefore, coverage, rebase, sliceBars, type Bars, type WindowData } from '../../engine/series'
import { costInR, simulateTrade, type Direction, type TradeOutcome } from '../../engine/tradeSim'
import { volUnit, VOL_WINDOW_SEC } from '../../engine/volUnit'

export type RoundClass = 'giveback' | 'target' | 'stop' | 'other'

export interface ExitRound {
  id: string
  symbol: string
  date: string
  /** The second of the day the trade starts at (time 0 of the replay). */
  startSec: number
  direction: Direction
  /** The suggested stop and target distances in points (the stop is also the base of the limits on the player's plan). */
  suggestedStop: number
  suggestedTarget: number
  horizonSec: number
  costPts: number
  base: number
  /** The minute before the entry and the replay path, in points from the entry price. */
  context: Bars
  path: Bars
  volUnit: number
  /** How the suggested plan would have gone, which decides the round mix. */
  cls: RoundClass
}

export interface ExitSpec { id: string; symbol: string; date: string; startSec: number; horizonSec: number; stopMult: number; /** The trade's direction; by default a fixed function of the window id. */ direction?: Direction }
export interface ExitContext { lotSizeOf(symbol: string): number | undefined; cost: CostSettings; slipMult: number }

export const EXIT_PRE_SEC = VOL_WINDOW_SEC
/** Half of one standard move over the horizon: with a full one the target (2 R) was almost never reached inside a 3 to 10 minute replay. */
const STOP_SCALE = 0.5
export const directionOf = (id: string): Direction => (hashSeed(`exit|${id}`) % 2 === 0 ? 1 : -1)

/** Classify a window by running the suggested plan on it (spec 5.3 "round mix"). */
export function classify(outcome: TradeOutcome): RoundClass {
  if (outcome.kind === 'target') return 'target'
  if (outcome.kind === 'stop' && outcome.mfeR < 0.5) return 'stop'
  if (outcome.mfeR >= 1 && (outcome.kind === 'stop' || outcome.r < outcome.mfeR * 0.5)) return 'giveback'
  return 'other'
}

export function buildExitRound(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: ExitSpec, ctx: ExitContext): ExitRound | null {
  const all = barsFromWindow(window)
  const { startSec, horizonSec } = spec
  const base = closeAtOrBefore(all, startSec - 1)
  if (base === undefined || !(base > 0)) return null
  if (coverage(all, startSec - EXIT_DISCIPLINE.contextSec, startSec) < EXIT_DISCIPLINE.minCoverage) return null
  if (coverage(all, startSec, startSec + horizonSec) < EXIT_DISCIPLINE.minCoverage) return null
  const vol = volUnit(all, startSec, base)
  // volUnit is a 5 second range; the stop is scaled to the trade's horizon like Tick Reader's volUnitH, or it would be smaller than the cost (C35).
  const suggestedStop = spec.stopMult * vol * Math.sqrt(horizonSec / 5) * STOP_SCALE
  const suggestedTarget = EXIT_DISCIPLINE.rr * suggestedStop
  const direction = spec.direction ?? directionOf(spec.id)
  const path = sliceBars(all, startSec, startSec + horizonSec)
  if (path.t.length < horizonSec * EXIT_DISCIPLINE.minCoverage) return null
  const plan = simulateTrade(path, { direction, entrySec: startSec - 1, entryPrice: base, stop: suggestedStop, target: suggestedTarget, endSec: startSec + horizonSec })
  return {
    id: spec.id, symbol: spec.symbol, date: spec.date, startSec, direction, suggestedStop, suggestedTarget, horizonSec,
    costPts: costPoints(ctx.cost, ctx.lotSizeOf(spec.symbol), ctx.slipMult), base,
    context: rebase(sliceBars(all, startSec - EXIT_DISCIPLINE.contextSec, startSec), base), path: rebase(path, base), volUnit: vol, cls: classify(plan),
  }
}

/**
 * The round for a window with the direction chosen to give the wanted class (spec 5.3 round mix): both directions are classified on the
 * same bars and the one that matches is used. When neither does, the direction with the closer class is returned and the round source
 * sees the misfit and may try another window.
 */
export function buildExitRoundFor(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: ExitSpec, ctx: ExitContext, wanted: RoundClass): ExitRound | null {
  const up = buildExitRound(window, { ...spec, direction: 1 }, ctx)
  const down = buildExitRound(window, { ...spec, direction: -1 }, ctx)
  if (!up || !down) return up ?? down
  if (up.cls === wanted) return up
  if (down.cls === wanted) return down
  // Neither matches: prefer one that is not "other" (a real lesson), else the default direction of the window.
  return up.cls !== 'other' ? up : down.cls !== 'other' ? down : (spec.direction === -1 ? down : up)
}

export interface Plan { stop: number; target: number }

/** The suggested plan, rounded to the 0.05 tick, for the levels where the fields are filled in. */
export const suggestedPlan = (round: ExitRound): Plan => ({ stop: Math.round(round.suggestedStop * 20) / 20, target: Math.round(round.suggestedTarget * 20) / 20 })

/** A plan must have a stop within 0.5x to 1.5x of the suggested one and a target within 0.5x to 6x of the stop; returns a sentence, or null when it is fine. */
export function validatePlan(round: ExitRound, plan: { stop: number; target: number }): string | null {
  const { stop, target } = plan
  if (!Number.isFinite(stop) || !Number.isFinite(target) || stop <= 0 || target <= 0) return 'Enter a stop and a target distance in points.'
  const lo = round.suggestedStop * EXIT_DISCIPLINE.stopMin, hi = round.suggestedStop * EXIT_DISCIPLINE.stopMax
  if (stop < lo - 1e-9 || stop > hi + 1e-9) return `The stop must be between ${lo.toFixed(2)} and ${hi.toFixed(2)} points (half to one and a half times the suggested ${round.suggestedStop.toFixed(2)}).`
  if (target < stop * EXIT_DISCIPLINE.targetMin - 1e-9 || target > stop * EXIT_DISCIPLINE.targetMax + 1e-9) return `The target must be between ${(stop * EXIT_DISCIPLINE.targetMin).toFixed(2)} and ${(stop * EXIT_DISCIPLINE.targetMax).toFixed(2)} points (half to six times your stop).`
  return null
}

/** The most the price moved in the trade's favour over the whole horizon, in points (the opportunity the round offered). */
export function fullMfePts(round: ExitRound): number {
  let best = 0
  for (let i = 0; i < round.path.t.length; i++) best = Math.max(best, round.direction === 1 ? round.path.h[i] : -round.path.l[i])
  return best
}

export interface ExitResult {
  roundId: string
  outcome: TradeOutcome['kind']
  /** Net R of the player's trade, of the plan left alone, and the best the horizon offered. */
  userR: number
  planR: number
  mfeR: number
  capture: number
  overrides: number
  overrode: boolean
  /** Ended worse (better) than the plan after an override. */
  worse: boolean
  better: boolean
  gaveBack: boolean
  holdSec: number
  roundScore: number
  cls: RoundClass
}

/**
 * `capture = clamp((R_user - R_floor) / (R_mfe - R_floor), 0, 1)` with `R_floor = -1`; when the trade never went into profit
 * (`R_mfe <= 0`) the capture is 1 unless the player did worse than the stop. An override that ended worse than the plan costs 0.2.
 */
export function scoreExit(round: ExitRound, plan: Plan, outcome: TradeOutcome, overrides: number, ctx: { deltaProxy?: number } = {}): ExitResult {
  const delta = ctx.deltaProxy ?? EXIT_DISCIPLINE.deltaProxy
  const costR = costInR(round.costPts, delta, plan.stop)
  const userR = outcome.r - costR
  const planOutcome = simulateTrade(round.path, { direction: round.direction, entrySec: round.startSec - 1, entryPrice: 0, stop: plan.stop, target: plan.target, endSec: round.startSec + round.horizonSec })
  const planR = planOutcome.r - costR
  const mfeR = fullMfePts(round) / plan.stop
  const floor = -1
  const capture = mfeR <= 0 ? (outcome.r >= floor - 1e-9 ? 1 : 0) : clamp((userR - floor) / (mfeR - floor), 0, 1)
  const overrode = overrides > 0
  const worse = overrode && userR < planR - 1e-9
  const better = overrode && userR > planR + 1e-9
  return {
    roundId: round.id, outcome: outcome.kind, userR, planR, mfeR, capture, overrides, overrode, worse, better,
    gaveBack: outcome.mfeR >= 1 && outcome.r < outcome.mfeR * 0.5,
    holdSec: Math.max(0, outcome.exitSec - (round.startSec - 1)),
    roundScore: clamp01(capture - (worse ? EXIT_DISCIPLINE.overridePenalty : 0)),
    cls: round.cls,
  }
}

const round2 = (value: number): number => Math.round(value * 100) / 100
const share = (count: number, of: number): number => (of ? round2((count / of) * 100) : 0)

/** `SessionScore = 100 x mean(roundScore)`; the stats are the ones the spec keeps. */
export function summariseExit(results: ExitResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((sum, r) => sum + r.roundScore, 0) / n : 0
  const overridden = results.filter(r => r.overrode)
  return {
    score: toSessionScore(100 * mean),
    stats: {
      rounds: n,
      capture_ratio: share(results.reduce((s, r) => s + r.capture, 0), n),
      override_rate: share(overridden.length, n),
      override_regret_rate: share(overridden.filter(r => r.worse).length, overridden.length),
      give_back_rate: share(results.filter(r => r.gaveBack).length, n),
      avg_hold_sec: n ? Math.round(results.reduce((s, r) => s + r.holdSec, 0) / n) : 0,
      mean_r: n ? round2(results.reduce((s, r) => s + r.userR, 0) / n) : 0,
    },
  }
}

/** Draw the round's wanted class from the spec's 40 / 30 / 30 mix. */
export function wantedClass(rng: Rng): RoundClass {
  const x = rng.next()
  return x < EXIT_DISCIPLINE.mix.giveback ? 'giveback' : x < EXIT_DISCIPLINE.mix.giveback + EXIT_DISCIPLINE.mix.target ? 'target' : 'stop'
}

export function exitPlan(params: Record<string, number>, ctx: ExitContext): RoundPlan<ExitRound> {
  const horizonSec = params.horizonSec
  let wanted: RoundClass = 'giveback'
  return {
    rules: { preSec: EXIT_PRE_SEC, postSec: horizonSec },
    fetchBefore: EXIT_PRE_SEC,
    fetchAfter: horizonSec,
    build: (window, pick) => buildExitRoundFor(window, { id: pick.id, symbol: pick.symbol, date: pick.date, startSec: pick.decisionSec, horizonSec, stopMult: params.stopMult }, ctx, wanted),
    // The source asks "wantNoEdge" once per round; here it draws the wanted class and remembers it for `build` and `misfit`.
    wantNoEdge: rng => { wanted = wantedClass(rng); return false },
    misfit: round => (round.cls === wanted ? 0 : round.cls === 'other' ? 1 : 0.6),
  }
}
