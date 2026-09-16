import { describe, expect, it } from 'vitest'
import { applyEvent, fromSnapshot } from './chartState'
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
