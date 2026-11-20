/**
 * Tick Reader (spec 5.1): read the last `lookbackSec` seconds, then go long (CE), short (PE) or skip within `decisionSec`; the next
 * `holdSec` seconds decide the result. Pure: rounds are built from a fetched window and scored without any clock or network.
 *
 * Decisions made here (as built, G3b): the chart stands still while the player decides, so the entry price is the last price shown
 * (no drift between the picture and the fill); the trade exits at the hold's last observed second.
 */
import { clamp, toSessionScore } from '../../../core/scoring'
import { TICK_READER } from '../../config/difficulty.market'
import type { SessionSummary } from '../../../core/types'
import { costPoints, type CostSettings } from '../../engine/costModel'
import { barsFromWindow, closeAtOrBefore, coverage, efficiencyRatio, rebase, sliceBars, type Bars, type WindowData } from '../../engine/series'
import type { RoundPlan } from '../../engine/roundSource'
import { VOL_WINDOW_SEC, volUnit } from '../../engine/volUnit'

export type TickAnswer = 'long' | 'short' | 'skip' | 'timeout'

export interface TickRound {
  id: string
  symbol: string
  date: string
  decisionSec: number
  /** One-second bars of the lookback and of the hold, in points from the entry price. */
  lookback: Bars
  future: Bars
  /** The price at the decision point (the zero of the chart). */
  base: number
  lookbackSec: number
  holdSec: number
  /** Underlying points from the entry to the exit. */
  move: number
  volUnit: number
  costPts: number
  edgeThreshold: number
  /** True when the move was worth trading after costs. */
  edge: boolean
  /** Efficiency ratio of the lookback (choppiness). */
  er: number
}

export interface RoundSpec { id: string; symbol: string; date: string; decisionSec: number; lookbackSec: number; holdSec: number }
/** `lotSizeOf` comes from the server's availability list (the Sensex and NIFTY differ), never from a copy of the config. */
export interface RoundContext { lotSizeOf(symbol: string): number | undefined; cost: CostSettings; slipMult: number }

/** Seconds before the decision point a window must cover so that both the lookback and volUnit have data. */
export const preSeconds = (lookbackSec: number): number => Math.max(lookbackSec, VOL_WINDOW_SEC)

/** How far from the target second the first and last prices may be (gaps are normal; a long gap is not). */
const MAX_EDGE_GAP_SEC = 5

/** A round from a fetched window, or null when the data is too thin to play (the caller draws another window). */
export function buildRound(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>, spec: RoundSpec, ctx: RoundContext): TickRound | null {
  const all = barsFromWindow(window)
  const { decisionSec, lookbackSec, holdSec } = spec
  const lookback = sliceBars(all, decisionSec - lookbackSec, decisionSec)
  const future = sliceBars(all, decisionSec, decisionSec + holdSec)
  if (coverage(all, decisionSec - lookbackSec, decisionSec) < TICK_READER.minCoverage) return null
  if (!lookback.t.length || !future.t.length) return null
  if (decisionSec - lookback.t[lookback.t.length - 1] > MAX_EDGE_GAP_SEC) return null
  const base = lookback.c[lookback.c.length - 1]
  const exitPrice = closeAtOrBefore(future, decisionSec + holdSec - 1)
  if (exitPrice === undefined || decisionSec + holdSec - future.t[future.t.length - 1] > MAX_EDGE_GAP_SEC) return null
  if (!(base > 0) || !Number.isFinite(exitPrice)) return null
  const high = Math.max(...lookback.h), low = Math.min(...lookback.l)
  if (!(high > low)) return null // a flat lookback tells the player nothing
  const vol = volUnit(all, decisionSec, base)
  const costPts = costPoints(ctx.cost, ctx.lotSizeOf(spec.symbol), ctx.slipMult)
  const move = exitPrice - base
  const edgeThreshold = Math.max(TICK_READER.edgeCostMult * costPts, TICK_READER.edgeVolMult * vol * Math.sqrt(holdSec / 5))
  return {
    id: spec.id, symbol: spec.symbol, date: spec.date, decisionSec,
    lookback: rebase(lookback, base), future: rebase(future, base), base, lookbackSec, holdSec, move,
    volUnit: vol, costPts, edgeThreshold,
    edge: Math.abs(move) * TICK_READER.deltaProxy >= edgeThreshold,
    er: efficiencyRatio(lookback.c),
  }
}

export interface RoundResult {
  roundId: string
  answer: TickAnswer
  kind: 'trade' | 'correct_skip' | 'missed_move' | 'timeout_skip' | 'timeout_missed'
  /** Net option points of the trade (0 for a skip). */
  net: number
  roundScore: number
  /** Underlying move, for the result flash. */
  move: number
  edge: boolean
  /** Milliseconds from the start of the decision to the key press (the full window for a timeout). */
  decisionMs: number
}

export function scoreRound(round: TickRound, answer: TickAnswer, decisionMs: number): RoundResult {
  const base = { roundId: round.id, answer, move: round.move, edge: round.edge, decisionMs }
  if (answer === 'long' || answer === 'short') {
    const net = (answer === 'long' ? 1 : -1) * round.move * TICK_READER.deltaProxy - round.costPts
    const volUnitH = round.volUnit * Math.sqrt(round.holdSec / 5)
    return { ...base, kind: 'trade', net, roundScore: clamp(net / (TICK_READER.k * volUnitH), -1, 1) }
  }
  const correct = !round.edge
  const timeout = answer === 'timeout'
  return { ...base, kind: timeout ? (correct ? 'timeout_skip' : 'timeout_missed') : correct ? 'correct_skip' : 'missed_move', net: 0, roundScore: correct ? TICK_READER.skipCredit : 0 }
}

const round2 = (value: number): number => Math.round(value * 100) / 100

/** SessionScore = clamp(50 + 50 * mean(roundScore), 0, 100); the stats are the ones the spec keeps. */
export function summariseTickReader(results: RoundResult[], _level?: number): SessionSummary {
  const n = results.length
  const mean = n ? results.reduce((sum, r) => sum + r.roundScore, 0) / n : 0
  const trades = results.filter(r => r.kind === 'trade')
  const skips = results.filter(r => r.kind !== 'trade')
  const edgeRounds = results.filter(r => r.edge).length
  const correctSkips = skips.filter(r => r.kind === 'correct_skip' || r.kind === 'timeout_skip').length
  const decided = results.filter(r => r.answer !== 'timeout')
  return {
    score: toSessionScore(50 + 50 * mean),
    stats: {
      rounds: n,
      trades: trades.length,
      hit_rate: trades.length ? round2((trades.filter(r => r.net > 0).length / trades.length) * 100) : 0,
      expectancy_pts: trades.length ? round2(trades.reduce((sum, r) => sum + r.net, 0) / trades.length) : 0,
      skip_precision: skips.length ? round2((correctSkips / skips.length) * 100) : 0,
      edge_rounds: edgeRounds,
      timeouts: results.filter(r => r.answer === 'timeout').length,
      mean_decision_ms: decided.length ? Math.round(decided.reduce((sum, r) => sum + r.decisionMs, 0) / decided.length) : 0,
    },
  }
}

/** What the round source needs from Tick Reader: how to build a round, and how well it matches the level's wishes. */
export function tickReaderPlan(params: Record<string, number>, ctx: RoundContext): RoundPlan<TickRound> {
  const lookbackSec = params.lookbackSec, holdSec = params.holdSec
  return {
    rules: { preSec: preSeconds(lookbackSec), postSec: holdSec },
    fetchBefore: preSeconds(lookbackSec),
    fetchAfter: holdSec,
    build: (window, pick) => buildRound(window, { id: pick.id, symbol: pick.symbol, date: pick.date, decisionSec: pick.decisionSec, lookbackSec, holdSec }, ctx),
    wantNoEdge: rng => rng.chance(params.noEdgeShare),
    // 0 when the round is the wanted kind; otherwise a penalty, plus the distance of the choppiness from the level's target.
    misfit: (round, wantNoEdge) => (round.edge === !wantNoEdge ? 0 : 1) + Math.abs(round.er - params.targetEr),
  }
}
