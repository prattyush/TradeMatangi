import { describe, expect, it } from 'vitest'
import { applyEvent, fromSnapshot, replayCandles } from './chartState'
import type { ChartSnapshot } from './contracts'

const snapshot: ChartSnapshot = { instrument: { kind: 'index', exchange: 'NSE', symbol: 'NIFTY 50' }, interval: '1m', generation: 1, eventId: 10, candles: [{ timestamp: 1, open: 1, high: 2, low: 0, close: 1 }] }
describe('chart event ordering', () => {
  it('replaces the current bar once and rejects stale updates', () => {
    const current = applyEvent(fromSnapshot(snapshot), { type: 'candle', generation: 1, eventId: 11, candle: { timestamp: 1, open: 1, high: 3, low: 0, close: 2 } })
    expect(current.candles).toHaveLength(1)
    expect(current.candles[0].high).toBe(3)
    expect(applyEvent(current, { type: 'candle', generation: 1, eventId: 10, candle: { timestamp: 2, open: 2, high: 2, low: 2, close: 2 } })).toBe(current)
  })
})

describe('replay candle seeding', () => {
  it('keeps prior-day context and completed same-day bars, replacing the active bar', () => {
    const candles = [
      { timestamp: 100, open: 1, high: 2, low: 0, close: 1 },
      { timestamp: 200, open: 2, high: 3, low: 1, close: 2 },
      { timestamp: 300, open: 3, high: 4, low: 2, close: 3 },
      { timestamp: 400, open: 4, high: 5, low: 3, close: 4 },
    ]
    const seeded = replayCandles(candles, 350, { timestamp: 300, open: 3, high: 6, low: 2, close: 5 })
    expect(seeded.map(candle => candle.timestamp)).toEqual([100, 200, 300])
    expect(seeded[2].high).toBe(6)
  })
})
