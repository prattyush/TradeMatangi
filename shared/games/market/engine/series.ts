/**
 * Price series helpers for the market games (spec 2, 4.3). Pure: no DOM, no clock, no network.
 *
 * The server sends integer paise and seconds of the IST day (`/window`, backend G1); here a window becomes floats in index or premium
 * points. Rows are only the seconds that were observed, so bars are sparse and every helper copes with gaps.
 */

/** A window as the client keeps it: the server's arrays, prices still in paise. Typed arrays are what the cache stores. */
export interface WindowData {
  symbol: string
  date: string
  intervalSeconds: number
  startSec: number
  durationSec: number
  t: ArrayLike<number>
  o: ArrayLike<number>
  h: ArrayLike<number>
  l: ArrayLike<number>
  c: ArrayLike<number>
  /** Option contract, when the window is an option series. */
  contract?: { expiry: string; strike: number; right: 'CE' | 'PE' }
}

/** Bars in price points (not paise). `t` is the second of the day of each bar's start. */
export interface Bars { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] }

export const emptyBars = (): Bars => ({ t: [], o: [], h: [], l: [], c: [] })
export const barCount = (bars: Bars): number => bars.t.length

export const PAISE = 100

export function barsFromWindow(window: Pick<WindowData, 't' | 'o' | 'h' | 'l' | 'c'>): Bars {
  const n = window.t.length
  const bars = emptyBars()
  for (let i = 0; i < n; i++) {
    const o = window.o[i] / PAISE, h = window.h[i] / PAISE, l = window.l[i] / PAISE, c = window.c[i] / PAISE
    if (![o, h, l, c].every(Number.isFinite)) continue
    bars.t.push(window.t[i]); bars.o.push(o); bars.h.push(h); bars.l.push(l); bars.c.push(c)
  }
  return bars
}

/** Bars whose start is in `[from, to)`. */
export function sliceBars(bars: Bars, from: number, to: number): Bars {
  const out = emptyBars()
  for (let i = 0; i < bars.t.length; i++) {
    if (bars.t[i] < from || bars.t[i] >= to) continue
    out.t.push(bars.t[i]); out.o.push(bars.o[i]); out.h.push(bars.h[i]); out.l.push(bars.l[i]); out.c.push(bars.c[i])
  }
  return out
}

/**
 * Aggregate to `seconds`-wide bars on epoch-aligned boundaries (`floor(t / seconds) * seconds`, the same rule as the trading charts),
 * so 5 s and 15 s candles are built here from the 1 s data the server serves. A bucket with no observed row produces no bar.
 */
export function aggregate(bars: Bars, seconds: number): Bars {
  if (seconds <= 1) return bars
  const out = emptyBars()
  let bucket = -1
  for (let i = 0; i < bars.t.length; i++) {
    const start = Math.floor(bars.t[i] / seconds) * seconds
    if (start !== bucket) {
      bucket = start
      out.t.push(start); out.o.push(bars.o[i]); out.h.push(bars.h[i]); out.l.push(bars.l[i]); out.c.push(bars.c[i])
    } else {
      const k = out.t.length - 1
      out.h[k] = Math.max(out.h[k], bars.h[i]); out.l[k] = Math.min(out.l[k], bars.l[i]); out.c[k] = bars.c[i]
    }
  }
  return out
}

/** Last close at or before `second`, or undefined when nothing was observed up to then. */
export function closeAtOrBefore(bars: Bars, second: number): number | undefined {
  let lo = 0, hi = bars.t.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (bars.t[mid] <= second) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found >= 0 ? bars.c[found] : undefined
}

/** Subtract `base` from every price (the round starts at 0 so the symbol and the level are not given away). */
export function rebase(bars: Bars, base: number): Bars {
  const shift = (values: number[]) => values.map(v => v - base)
  return { t: bars.t.slice(), o: shift(bars.o), h: shift(bars.h), l: shift(bars.l), c: shift(bars.c) }
}

/** Kaufman efficiency ratio of a close series: |net change| / path length, 0 (pure noise) to 1 (a straight line). */
export function efficiencyRatio(closes: number[]): number {
  if (closes.length < 2) return 0
  let path = 0
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1])
  return path > 0 ? Math.abs(closes[closes.length - 1] - closes[0]) / path : 0
}

/** Fraction of the seconds in `[from, to)` that have an observed row (1 = no gaps). */
export function coverage(bars: Bars, from: number, to: number): number {
  const span = to - from
  if (span <= 0) return 0
  let count = 0
  for (const t of bars.t) if (t >= from && t < to) count += 1
  return Math.min(1, count / span)
}
