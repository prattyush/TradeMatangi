/**
 * volUnit (spec 2): the robust volatility unit of a round, the median of the 5 second high-low ranges over the 5 minutes before the
 * decision point, floored so a dead market at the open cannot make every threshold ~0. It normalises a quiet day and a wild day.
 */
import { sliceBars, type Bars } from './series'

export const VOL_WINDOW_SEC = 300
export const VOL_BUCKET_SEC = 5
/** The floor as a share of the price: about 1 point on NIFTY (25,000) and 3 on the Sensex (80,000). */
export const MIN_VOL_SHARE = 0.00004

export function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Median 5 s range of the bars in `[atSec - 300, atSec)`. `price` sets the floor; the floor also answers "no data". */
export function volUnit(bars: Bars, atSec: number, price: number, minShare = MIN_VOL_SHARE): number {
  const floor = Math.max(1e-9, Math.abs(price) * minShare || 0)
  const recent = sliceBars(bars, atSec - VOL_WINDOW_SEC, atSec)
  const ranges = new Map<number, { hi: number; lo: number }>()
  for (let i = 0; i < recent.t.length; i++) {
    const key = Math.floor(recent.t[i] / VOL_BUCKET_SEC)
    const entry = ranges.get(key)
    if (entry) { entry.hi = Math.max(entry.hi, recent.h[i]); entry.lo = Math.min(entry.lo, recent.l[i]) }
    else ranges.set(key, { hi: recent.h[i], lo: recent.l[i] })
  }
  const value = median([...ranges.values()].map(entry => entry.hi - entry.lo))
  return Number.isFinite(value) ? Math.max(floor, value) : floor
}
