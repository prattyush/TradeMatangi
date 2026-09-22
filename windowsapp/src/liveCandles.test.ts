import { describe, expect, it } from 'vitest'
import { aggregateLiveCandles, appendLiveTick, mergeHistoryWithLiveTicks, recentLiveTicks, reconcileLiveTicks } from './liveCandles'

const candle = (timestamp: number, close: number) => ({ timestamp, open: close, high: close, low: close, close })

describe('desktop live candle aggregation', () => {
  it('builds independent intervals from the same raw ticks', () => {
    const ticks = [candle(9 * 3600 + 24 * 60 + 10, 100), candle(9 * 3600 + 24 * 60 + 20, 104)]
    expect(aggregateLiveCandles([], ticks, 3)).toEqual([{ timestamp: 9 * 3600 + 24 * 60, open: 100, high: 104, low: 100, close: 104 }])
    expect(aggregateLiveCandles([], ticks, 5)).toEqual([{ timestamp: 9 * 3600 + 20 * 60, open: 100, high: 104, low: 100, close: 104 }])
  })

  it('rebuilds the active candle immediately after an interval switch', () => {
    const ticks = [candle(9 * 3600 + 24 * 60 + 10, 100), candle(9 * 3600 + 24 * 60 + 20, 104)]
    const history = [candle(9 * 3600 + 15 * 60, 90)]
    const candles = aggregateLiveCandles(history, ticks, 5)
    expect(candles[candles.length - 1]).toEqual({ timestamp: 9 * 3600 + 20 * 60, open: 100, high: 104, low: 100, close: 104 })
  })

  it('deduplicates ticks without capping the desktop session cache', () => {
    const ticks = Array.from({ length: 61 * 60 + 1 }, (_, index) => candle(index, index))
    const cached = ticks.reduce(appendLiveTick, [] as ReturnType<typeof appendLiveTick>)
    expect(cached).toHaveLength(61 * 60 + 1)
    const updated = appendLiveTick(cached, candle(61 * 60, 999))
    expect(updated[updated.length - 1]?.close).toBe(999)
  })

  it('keeps local seconds absent from refresh while backend wins matching seconds', () => {
    const local = [candle(100, 10), candle(101, 11)]
    const backend = [candle(101, 21), candle(102, 22)]
    expect(reconcileLiveTicks(local, backend)).toEqual([candle(100, 10), candle(101, 21), candle(102, 22)])
  })

  it('can expose only recent ticks for website history backfill', () => {
    expect(recentLiveTicks([candle(0, 1), candle(901, 2)], 901)).toEqual([candle(901, 2)])
  })

  it('merges tick-built candles into broker history sorted by timestamp', () => {
    const merged = mergeHistoryWithLiveTicks([candle(60, 10)], [candle(130, 11), candle(125, 14)], 1)
    expect(merged).toEqual([candle(60, 10), { timestamp: 120, open: 11, high: 14, low: 11, close: 14 }])
  })
})
