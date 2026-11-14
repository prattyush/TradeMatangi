import { describe, expect, it, vi } from 'vitest'

// The extension registry needs a browser chart library; the indicator choice is what is under test.
vi.mock('react-klinecharts-ui/extensions', () => ({ registerExtensions: vi.fn() }))

import { applyAnalysisIndicators } from '../../shared/charts/useKLineIndicators'

const fakeChart = () => {
  const created: string[] = []
  const calls: Array<{ value: string | { name: string; paneId?: string }; stack?: boolean }> = []
  return {
    created, calls,
    chart: {
      removeIndicator: vi.fn(),
      createIndicator: (value: string | { name: string; paneId?: string }, stack?: boolean) => { created.push(typeof value === 'string' ? value : value.name); calls.push({ value, stack }) },
    },
  }
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
  it('draws VWAP over the candles (candle pane, stacked) while VOL keeps its own pane', () => {
    const { chart, calls } = fakeChart()
    applyAnalysisIndicators(chart as never, ['VOL', 'VWAP'], { hasVolume: true })
    expect(calls).toEqual([{ value: 'VOL', stack: undefined }, { value: { name: 'VWAP', paneId: 'candle_pane' }, stack: true }])
  })
  it('skips VWAP on daily bars, where it is only the typical price', () => {
    const { chart, created } = fakeChart()
    applyAnalysisIndicators(chart as never, ['VOL', 'VWAP'], { hasVolume: true, interval: '1D' })
    expect(created).toEqual(['VOL'])
  })
})
