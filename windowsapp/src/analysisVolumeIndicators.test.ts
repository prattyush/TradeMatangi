import { describe, expect, it, vi } from 'vitest'

// The extension registry needs a browser chart library; the indicator choice is what is under test.
vi.mock('react-klinecharts-ui/extensions', () => ({ registerExtensions: vi.fn() }))

import { applyAnalysisIndicators } from '../../shared/charts/useKLineIndicators'

const fakeChart = () => {
  const created: string[] = []
  return { created, chart: { removeIndicator: vi.fn(), createIndicator: (value: string | { name: string }) => { created.push(typeof value === 'string' ? value : value.name) } } }
}

describe('Analysis chart volume indicators', () => {
  it('creates VOL and VWAP when the candles have volume', () => {
    const { chart, created } = fakeChart()
    applyAnalysisIndicators(chart as never, ['EMA', 'VOL', 'VWAP', 'RSI_TV'], { hasVolume: true })
    expect(created).toEqual(['EMA', 'VOL', 'VWAP', 'RSI_TV'])
  })
  it('skips VOL and VWAP, but nothing else, when there is no volume (an index)', () => {
    const { chart, created } = fakeChart()
    applyAnalysisIndicators(chart as never, ['EMA', 'VOL', 'VWAP', 'RSI_TV'], { hasVolume: false })
    expect(created).toEqual(['EMA', 'RSI_TV'])
  })
  it('keeps every indicator for callers that do not say (unchanged behavior)', () => {
    const { chart, created } = fakeChart()
    applyAnalysisIndicators(chart as never, ['VOL', 'MA'])
    expect(created).toEqual(['VOL', 'MA'])
  })
})
