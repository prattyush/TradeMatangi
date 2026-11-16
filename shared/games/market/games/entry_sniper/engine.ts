/**
 * Entry Sniper (spec 5.2): timing an entry inside a stated setup instead of chasing. The game says LONG or SHORT, a stop S and a
 * target T = rr x S (in points, S from the volUnit); the chart forms second by second over `windowSec` seconds and the player presses
 * ENTER once (or PASS). The trade then runs to the stop, the target or the horizon.
 *
 * Everything the result screen needs is computed here from the same bars: the result of entering at each second of the window, the best
 * of them (R_opt), and whether the window is a trap (no entry in it is worth taking).
 */
import { clamp, toSessionScore } from '../../../core/scoring'
import { hashSeed } from '../../../core/rng'
import type { SessionSummary } from '../../../core/types'
import { ENTRY_SNIPER } from '../../config/difficulty.market'
import { costPoints, type CostSettings } from '../../engine/costModel'
import type { RoundPlan } from '../../engine/roundSource'
import { barsFromWindow, closeAtOrBefore, coverage, rebase, sliceBars, type Bars, type WindowData } from '../../engine/series'
import { costInR, netR, simulateTrade, type Direction, type TradeOutcome } from '../../engine/tradeSim'
import { volUnit, VOL_WINDOW_SEC } from '../../engine/volUnit'

export interface SniperRound {
  id: string
  symbol: string
  date: string
  /** The second of the day the window starts at. */
  startSec: number
  direction: Direction
  /** Stop and target distances in points, and the cost of the trade in R. */
  stop: number
  target: number
  costR: number
  costPts: number
  windowSec: number
  horizonSec: number
  base: number
  /** The minute before the window and the window plus the horizon, in points from `base`. */
  context: Bars
  path: Bars
  volUnit: number
  /** Net R of entering at the close of each second of the window (null where the second has no price). */
  netByOffset: Array<number | null>
  outcomeByOffset: Array<TradeOutcome | null>
  /** The best entry: its offset in the window and its net R (null offset when nothing could be entered). */
  bestOffset: number | null
  bestR: number
  trap: boolean
}

export interface SniperSpec { id: string; symbol: string; date: string; startSec: number; windowSec: number; horizonSec: number; stopMult: number; rr: number; /** The stated direction; by default a fixed function of the window id. */ direction?: Direction }
export interface SniperContext { lotSizeOf(symbol: string): number | undefined; cost: CostSettings; slipMult: number }

/** Seconds of data needed before the window (volUnit reads five minutes) and after its start. */
export const SNIPER_PRE_SEC = VOL_WINDOW_SEC

/** The stated direction is a fixed function of the window, so the same window always asks the same question. */
export const directionOf = (id: string): Direction => (hashSeed(id) % 2 === 0 ? 1 : -1)

export function buildSniperRound(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: SniperSpec, ctx: SniperContext): SniperRound | null {
  const all = barsFromWindow(window)
  const { startSec, windowSec, horizonSec } = spec
  const end = startSec + windowSec + horizonSec
  const base = closeAtOrBefore(all, startSec - 1)
  if (base === undefined || !(base > 0)) return null
  if (coverage(all, startSec - ENTRY_SNIPER.contextSec, startSec) < ENTRY_SNIPER.minCoverage) return null
  if (coverage(all, startSec, startSec + windowSec) < ENTRY_SNIPER.minCoverage) return null
  const vol = volUnit(all, startSec, base)
  // The stop is stopMult x volUnit scaled to the trade's horizon (volUnit is a 5 second range, which is smaller than the cost of a trade; C34).
  const stop = spec.stopMult * vol * Math.sqrt(horizonSec / 5)
  const target = spec.rr * stop
  const costPts = costPoints(ctx.cost, ctx.lotSizeOf(spec.symbol), ctx.slipMult)
  const costR = costInR(costPts, ENTRY_SNIPER.deltaProxy, stop)
  const direction = spec.direction ?? directionOf(spec.id)
  const path = sliceBars(all, startSec, end)
  const byTime = new Map<number, number>()
  path.t.forEach((t, i) => byTime.set(t, i))

  const netByOffset: Array<number | null> = []
  const outcomeByOffset: Array<TradeOutcome | null> = []
  let bestOffset: number | null = null
  let bestR = Number.NEGATIVE_INFINITY
  for (let k = 0; k < windowSec; k++) {
    const index = byTime.get(startSec + k)
    if (index === undefined) { netByOffset.push(null); outcomeByOffset.push(null); continue }
    const outcome = simulateTrade(path, { direction, entrySec: startSec + k, entryPrice: path.c[index], stop, target, endSec: Math.min(end, startSec + k + horizonSec) })
    const net = netR(outcome, costR)
    netByOffset.push(net); outcomeByOffset.push(outcome)
    if (net > bestR) { bestR = net; bestOffset = k }
  }
  if (bestOffset === null) return null
  return {
    id: spec.id, symbol: spec.symbol, date: spec.date, startSec, direction, stop, target, costR, costPts, windowSec, horizonSec, base,
    context: rebase(sliceBars(all, startSec - ENTRY_SNIPER.contextSec, startSec), base), path: rebase(path, base), volUnit: vol,
    netByOffset, outcomeByOffset, bestOffset, bestR, trap: bestR < ENTRY_SNIPER.trapBelowR,
  }
}

export type SniperAnswer = { kind: 'enter'; offset: number } | { kind: 'pass' } | { kind: 'timeout' }

export interface SniperResult {
  roundId: string
  kind: 'enter' | 'pass' | 'timeout'
  offset: number | null
  /** Net R of the player's entry (0 when none), and of the best entry. */
  userR: number
  bestR: number
  bestOffset: number | null
  trap: boolean
  early: boolean
  exit: TradeOutcome['kind'] | null
  roundScore: number
}

export function scoreSniper(round: SniperRound, answer: SniperAnswer): SniperResult {
  const common = { roundId: round.id, bestR: round.bestR, bestOffset: round.bestOffset, trap: round.trap }
  if (answer.kind === 'enter') {
    const offset = clamp(Math.round(answer.offset), 0, round.windowSec - 1)
    const net = round.netByOffset[offset]
    // An entry on a second without a price cannot happen in the game (the chart only shows seconds that have one); score it as a pass.
    if (net === null) return { ...common, kind: 'pass', offset: null, userR: 0, early: false, exit: null, roundScore: round.trap ? ENTRY_SNIPER.passCredit : 0 }
    return {
      ...common, kind: 'enter', offset, userR: net, early: offset < ENTRY_SNIPER.earlySec, exit: round.outcomeByOffset[offset]?.kind ?? null,
      roundScore: clamp(net / Math.max(round.bestR, ENTRY_SNIPER.optFloorR), -1, 1),
    }
  }
  return { ...common, kind: answer.kind, offset: null, userR: 0, early: false, exit: null, roundScore: round.trap ? ENTRY_SNIPER.passCredit : 0 }
}

const round2 = (value: number): number => Math.round(value * 100) / 100

/** `SessionScore = clamp(50 + 50 x mean(roundScore), 0, 100)`: 50 is break-even skill (spec 2). */
export function summariseSniper(results: SniperResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((sum, r) => sum + r.roundScore, 0) / n : 0
  const entries = results.filter(r => r.kind === 'enter')
  const traps = results.filter(r => r.trap)
  return {
    score: toSessionScore(50 + 50 * mean),
    stats: {
      rounds: n,
      entries: entries.length,
      mean_efficiency: entries.length ? round2((entries.reduce((s, r) => s + clamp(r.userR / Math.max(r.bestR, ENTRY_SNIPER.optFloorR), -1, 1), 0) / entries.length) * 100) : 0,
      mean_r: entries.length ? round2(entries.reduce((s, r) => s + r.userR, 0) / entries.length) : 0,
      early_entry_rate: entries.length ? round2((entries.filter(r => r.early).length / entries.length) * 100) : 0,
      trap_rounds: traps.length,
      trap_pass_rate: traps.length ? round2((traps.filter(r => r.kind !== 'enter').length / traps.length) * 100) : 0,
      stop_out_rate: entries.length ? round2((entries.filter(r => r.exit === 'stop').length / entries.length) * 100) : 0,
      timeouts: results.filter(r => r.kind === 'timeout').length,
    },
  }
}

/**
 * The round for a window with the stated direction chosen to match what the level wants (spec 5.2 "Traps": the window is chosen so
 * that the stated direction fails in the configured share of rounds). Both directions are simulated on the same bars: a trap round
 * states the one that never offers an entry worth taking, any other the one that does. When the window cannot give the wanted kind in
 * either direction, the closer one is returned and the round source sees the misfit.
 */
export function buildSniperRoundFor(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: SniperSpec, ctx: SniperContext, wantTrap: boolean): SniperRound | null {
  const up = buildSniperRound(window, { ...spec, direction: 1 }, ctx)
  const down = buildSniperRound(window, { ...spec, direction: -1 }, ctx)
  if (!up || !down) return up ?? down
  const first = wantTrap ? (up.bestR <= down.bestR ? up : down) : (up.bestR >= down.bestR ? up : down)
  return first
}

/** What the round source needs: a window to fetch, how to build the round, and how well it matches the level (trap or a round with an entry). */
export function sniperPlan(params: Record<string, number>, ctx: SniperContext): RoundPlan<SniperRound> {
  const windowSec = params.windowSec, horizonSec = params.horizonSec
  let wantTrap = false
  return {
    rules: { preSec: SNIPER_PRE_SEC, postSec: windowSec + horizonSec },
    fetchBefore: SNIPER_PRE_SEC,
    fetchAfter: windowSec + horizonSec,
    build: (window, pick) => buildSniperRoundFor(window, { id: pick.id, symbol: pick.symbol, date: pick.date, startSec: pick.decisionSec, windowSec, horizonSec, stopMult: params.stopMult, rr: params.rr }, ctx, wantTrap),
    // "wantNoEdge" is the trap flag here: drawn once per round, remembered for `build`.
    wantNoEdge: rng => { wantTrap = rng.chance(params.trapShare); return wantTrap },
    misfit: (round, wanted) => (round.trap === wanted ? 0 : 1),
  }
}
