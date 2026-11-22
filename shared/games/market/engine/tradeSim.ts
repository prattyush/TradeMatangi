/**
 * The trade simulation shared by Entry Sniper and Exit Discipline (spec 5.2, 5.3). Pure: a trade on the underlying's 1 second
 * bars, in points, measured in R (the stop distance). Nothing here knows about the chart, the clock or the network.
 *
 * Rules (both games, as built):
 *  - A trade is entered at a price on a second and is judged on the bars after that second.
 *  - Stop and target are hit when a bar's low/high reaches them; the exit is AT the level (no gap model). A bar that reaches
 *    both counts the stop first (the conservative reading of a 1 second bar).
 *  - At the end of the horizon the trade is marked to market at the last close.
 *  - Costs are charged once, in R: `costPts / (deltaProxy x stop distance)`, because R is measured in underlying points and costs in
 *    option points (spec 2: points of the option move `deltaProxy` of the underlying).
 */
import type { Bars } from './series'

export type Direction = 1 | -1
export type ExitKind = 'stop' | 'target' | 'horizon' | 'manual'

export interface TradeSpec {
  direction: Direction
  entrySec: number
  entryPrice: number
  /** Distance of the stop and of the target from the entry, in points (positive). The target may be null (none). */
  stop: number
  target: number | null
  /** Last second (exclusive) the trade can run; the trade is marked to market at the last bar before it. */
  endSec: number
}

export interface TradeOutcome {
  kind: ExitKind
  exitSec: number
  exitPrice: number
  /** Gross result in R of the ORIGINAL stop distance (before costs). */
  r: number
  /** Best price move in the trade's favour seen up to the exit, in R (never negative), and the worst against it. */
  mfeR: number
  maeR: number
}

const favourable = (direction: Direction, entry: number, price: number): number => direction * (price - entry)

/** Run a trade through the bars after the entry second. */
export function simulateTrade(bars: Bars, spec: TradeSpec): TradeOutcome {
  const { direction, entryPrice, stop, target } = spec
  const stopPrice = entryPrice - direction * stop
  const targetPrice = target === null ? null : entryPrice + direction * target
  let best = 0, worst = 0 // in points: the most the price moved for and against the trade before the exit
  let lastSec = spec.entrySec, lastClose = entryPrice
  for (let i = 0; i < bars.t.length; i++) {
    const t = bars.t[i]
    if (t <= spec.entrySec) continue
    if (t >= spec.endSec) break
    const forPrice = direction === 1 ? bars.h[i] : bars.l[i]      // the bar's best price for the trade
    const againstPrice = direction === 1 ? bars.l[i] : bars.h[i]  // and its worst
    if (direction === 1 ? againstPrice <= stopPrice : againstPrice >= stopPrice) {
      worst = Math.max(worst, stop)
      return { kind: 'stop', exitSec: t, exitPrice: stopPrice, r: -1, mfeR: best / stop, maeR: worst / stop }
    }
    if (targetPrice !== null && (direction === 1 ? forPrice >= targetPrice : forPrice <= targetPrice)) {
      best = Math.max(best, target as number)
      return { kind: 'target', exitSec: t, exitPrice: targetPrice, r: (target as number) / stop, mfeR: best / stop, maeR: worst / stop }
    }
    best = Math.max(best, favourable(direction, entryPrice, forPrice))
    worst = Math.max(worst, -favourable(direction, entryPrice, againstPrice))
    lastSec = t; lastClose = bars.c[i]
  }
  return { kind: 'horizon', exitSec: lastSec, exitPrice: lastClose, r: favourable(direction, entryPrice, lastClose) / stop, mfeR: best / stop, maeR: worst / stop }
}

/** Cost of the round trip in R of a stop `stop` points away. */
export const costInR = (costPts: number, deltaProxy: number, stop: number): number => (stop > 0 && deltaProxy > 0 ? costPts / (deltaProxy * stop) : 0)

/** The net result of an outcome: gross R less the cost in R. */
export const netR = (outcome: TradeOutcome, costR: number): number => outcome.r - costR

/**
 * An open trade that is stepped one bar at a time (Exit Discipline's replay): the stop and target are enforced on every bar, and
 * the player can exit, trail the stop to the entry, or lock a share of the open profit. The stop only ever moves in the trade's
 * favour.
 */
export interface OpenTrade {
  readonly direction: Direction
  readonly entryPrice: number
  /** The stop price now (it moves when the player trails or locks) and the original distance that defines 1 R. */
  readonly stopPrice: number
  readonly targetPrice: number | null
  readonly riskPts: number
  readonly overrides: number
  readonly closed: TradeOutcome | null
  /** Where the open profit stands at the last price, in R. */
  readonly openR: number
  /** Feed the next bar. Returns the outcome when this bar closed the trade. */
  step(bar: { t: number; h: number; l: number; c: number }): TradeOutcome | null
  /** Move the stop to the entry. Only allowed while the trade is in profit and the stop is still behind the entry. */
  trailToCost(): boolean
  /** Move the stop to lock `fraction` of the open profit. Only when it improves the stop. */
  lock(fraction: number): boolean
  /** Leave at the last price (the player's choice: counts as an override). */
  exit(sec: number): TradeOutcome | null
  /** The horizon ended: close at the last price without counting an override. */
  expire(sec: number): TradeOutcome | null
}

export function openTrade(spec: { direction: Direction; entryPrice: number; stop: number; target: number | null }): OpenTrade {
  const { direction, entryPrice } = spec
  const riskPts = spec.stop
  const targetPrice = spec.target === null ? null : entryPrice + direction * spec.target
  let stopPrice = entryPrice - direction * riskPts
  let lastClose = entryPrice
  let lastSec = 0
  let best = 0, worst = 0
  let overrides = 0
  let closed: TradeOutcome | null = null

  const finish = (kind: ExitKind, exitSec: number, exitPrice: number): TradeOutcome => {
    const rr = favourable(direction, entryPrice, exitPrice) / riskPts
    closed = { kind, exitSec, exitPrice, r: rr, mfeR: best / riskPts, maeR: worst / riskPts }
    return closed
  }
  const behindEntry = () => (direction === 1 ? stopPrice < entryPrice : stopPrice > entryPrice)

  const api: OpenTrade = {
    direction, entryPrice, riskPts, targetPrice,
    get stopPrice() { return stopPrice },
    get overrides() { return overrides },
    get closed() { return closed },
    get openR() { return favourable(direction, entryPrice, lastClose) / riskPts },
    step(bar) {
      if (closed) return null
      lastSec = bar.t
      const stopHit = direction === 1 ? bar.l <= stopPrice : bar.h >= stopPrice
      if (stopHit) {
        worst = Math.max(worst, favourable(direction, entryPrice, direction === 1 ? bar.l : bar.h) * -1)
        return finish('stop', bar.t, stopPrice)
      }
      if (targetPrice !== null && (direction === 1 ? bar.h >= targetPrice : bar.l <= targetPrice)) {
        best = Math.max(best, direction * (targetPrice - entryPrice))
        return finish('target', bar.t, targetPrice)
      }
      best = Math.max(best, favourable(direction, entryPrice, direction === 1 ? bar.h : bar.l))
      worst = Math.max(worst, -favourable(direction, entryPrice, direction === 1 ? bar.l : bar.h))
      lastClose = bar.c
      return null
    },
    trailToCost() {
      if (closed || !behindEntry() || favourable(direction, entryPrice, lastClose) <= 0) return false
      stopPrice = entryPrice; overrides += 1
      return true
    },
    lock(fraction) {
      const open = favourable(direction, entryPrice, lastClose)
      if (closed || open <= 0 || !(fraction > 0 && fraction < 1)) return false
      const candidate = entryPrice + direction * open * fraction
      const better = direction === 1 ? candidate > stopPrice : candidate < stopPrice
      if (!better) return false
      stopPrice = candidate; overrides += 1
      return true
    },
    exit(sec) {
      if (closed) return null
      overrides += 1
      return finish('manual', sec || lastSec, lastClose)
    },
    expire(sec) {
      if (closed) return null
      return finish('horizon', sec || lastSec, lastClose)
    },
  }
  return api
}
