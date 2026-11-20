/**
 * Key levels and swing points (spec 5.6). Pure: 60 second bars in, numbers out. Used by Level Recall; nothing here reads the clock or the
 * network. Only bars BEFORE the round time are ever passed in, so a level can never use information from the future.
 */
import { aggregate, type Bars } from './series'

export type LevelKind = 'prior_high' | 'prior_low' | 'prior_close' | 'today_open' | 'or_high' | 'or_low' | 'today_high' | 'today_low' | 'vwap' | 'round'
export const LEVEL_KINDS: readonly LevelKind[] = ['prior_high', 'prior_low', 'prior_close', 'today_open', 'or_high', 'or_low', 'today_high', 'today_low', 'vwap', 'round']
export const LEVEL_LABEL: Record<LevelKind, string> = {
  prior_high: 'Prior-day high', prior_low: 'Prior-day low', prior_close: 'Prior-day close', today_open: "Today's open", or_high: 'Opening-range high', or_low: 'Opening-range low',
  today_high: "Today's high so far", today_low: "Today's low so far", vwap: 'Average price (VWAP-like)', round: 'Nearest round number',
}

/** The opening range is the first 15 minutes of the session. */
export const OPENING_RANGE_SEC = 15 * 60
/** Round-number spacing for the two indices (the nearest multiple of it to the price). */
export const ROUND_STEP: Record<string, number> = { NIFTY: 100, BSESEN: 500 }

export interface Levels { values: Record<LevelKind, number>; price: number }

const maxOf = (values: number[]): number => values.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY)
const minOf = (values: number[]): number => values.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY)

/**
 * The ten levels from the previous session's minute bars and today's minute bars up to the round time. `openSec` is the second of the day the
 * session opens at (the opening range is the 15 minutes from it). The VWAP-like level is the mean typical price (high + low + close) / 3 of
 * today's bars, since the indices carry no volume. Returns null when either day has no bars or today has none inside the opening range.
 */
export function computeLevels(prior: Bars, today: Bars, openSec: number, roundStep: number): Levels | null {
  if (!prior.t.length || !today.t.length) return null
  const range = today.t.map((t, i) => ({ t, i })).filter(entry => entry.t >= openSec && entry.t < openSec + OPENING_RANGE_SEC).map(entry => entry.i)
  if (!range.length) return null
  const last = today.c[today.c.length - 1]
  const typical = today.t.map((_, i) => (today.h[i] + today.l[i] + today.c[i]) / 3)
  return {
    price: last,
    values: {
      prior_high: maxOf(prior.h), prior_low: minOf(prior.l), prior_close: prior.c[prior.c.length - 1], today_open: today.o[0],
      or_high: maxOf(range.map(i => today.h[i])), or_low: minOf(range.map(i => today.l[i])),
      today_high: maxOf(today.h), today_low: minOf(today.l), vwap: typical.reduce((a, b) => a + b, 0) / typical.length,
      round: Math.round(last / roundStep) * roundStep,
    },
  }
}

/** The day's volatility unit: the median high-low range of the 5 minute bars of both days (so it is in the size of the moves a level is judged by). */
export function dayVolUnit(prior: Bars, today: Bars, floor: number): number {
  const ranges: number[] = []
  for (const day of [prior, today]) {
    const five = aggregate(day, 300)
    for (let i = 0; i < five.t.length; i++) ranges.push(five.h[i] - five.l[i])
  }
  if (!ranges.length) return floor
  ranges.sort((a, b) => a - b)
  const mid = ranges.length >> 1
  const median = ranges.length % 2 ? ranges[mid] : (ranges[mid - 1] + ranges[mid]) / 2
  return Math.max(floor, median)
}

export interface Swing { t: number; price: number; type: 'high' | 'low' }

/**
 * Swing points by a zig-zag: a swing is confirmed when the price has moved `threshold` away from the running extreme. The last (unconfirmed)
 * extreme is not returned, so every swing has really happened. Alternates high, low, high...
 */
export function swingPoints(bars: Bars, threshold: number): Swing[] {
  const swings: Swing[] = []
  if (bars.t.length < 2 || !(threshold > 0)) return swings
  let direction: 1 | -1 | 0 = 0
  let extreme = { t: bars.t[0], price: bars.c[0] }
  let low = { t: bars.t[0], price: bars.l[0] }, high = { t: bars.t[0], price: bars.h[0] }
  for (let i = 1; i < bars.t.length; i++) {
    if (bars.h[i] > high.price) high = { t: bars.t[i], price: bars.h[i] }
    if (bars.l[i] < low.price) low = { t: bars.t[i], price: bars.l[i] }
    if (direction === 0) {
      if (high.price - low.price >= threshold) {
        // The earlier of the two extremes is the first swing.
        if (high.t >= low.t) { swings.push({ ...low, type: 'low' }); direction = 1; extreme = high } else { swings.push({ ...high, type: 'high' }); direction = -1; extreme = low }
      }
    } else if (direction === 1) {
      if (bars.h[i] > extreme.price) extreme = { t: bars.t[i], price: bars.h[i] }
      if (extreme.price - bars.l[i] >= threshold) { swings.push({ ...extreme, type: 'high' }); direction = -1; extreme = { t: bars.t[i], price: bars.l[i] } }
    } else {
      if (bars.l[i] < extreme.price) extreme = { t: bars.t[i], price: bars.l[i] }
      if (bars.h[i] - extreme.price >= threshold) { swings.push({ ...extreme, type: 'low' }); direction = 1; extreme = { t: bars.t[i], price: bars.h[i] } }
    }
  }
  return swings
}
