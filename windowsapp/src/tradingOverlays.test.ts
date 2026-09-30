import { describe, expect, it, vi } from 'vitest'
import type { Chart, OverlayCreate } from 'klinecharts'
import { TradingOverlayRegistry } from './tradingOverlays'

describe('trading chart overlays', () => {
  it('retains unchanged lines, updates moved lines, and removes filled orders without rebuilding remaining lines', () => {
    const chart = { createOverlay: vi.fn().mockReturnValueOnce('sl-line').mockReturnValueOnce('tp-line'), overrideOverlay: vi.fn(), removeOverlay: vi.fn() } as unknown as Pick<Chart, 'createOverlay' | 'overrideOverlay' | 'removeOverlay'>
    const registry = new TradingOverlayRegistry()
    const line = (price: number): OverlayCreate => ({ name: 'horizontalStraightLine', points: [{ timestamp: 100000, value: price }] })
    registry.upsert(chart, 'stop', line(90))
    registry.upsert(chart, 'target', line(110))
    registry.upsert(chart, 'stop', line(90))
    expect(chart.overrideOverlay).not.toHaveBeenCalled()
    registry.upsert(chart, 'stop', line(95))
    expect(chart.overrideOverlay).toHaveBeenCalledWith({ ...line(95), id: 'sl-line' })
    expect(registry.prune(chart, new Set(['target']))).toEqual(['stop'])
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: 'sl-line' })
    expect(chart.createOverlay).toHaveBeenCalledTimes(2)
    registry.reset()
    registry.upsert(chart, 'target', line(110))
    expect(chart.createOverlay).toHaveBeenCalledTimes(3)
  })
})
