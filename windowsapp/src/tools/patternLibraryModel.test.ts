import { describe, expect, it, vi } from 'vitest'
import { TOOL_OPTIONS, buildSaveBody, defaultPatternDate, resolveStrikes, strikesOf, toggleAnnotation } from './patternLibraryModel'
import { createPatternsClient } from '../patternsClient'

const tool = TOOL_OPTIONS.find(t => t.key === 'entry-CE')!

describe('toggleAnnotation', () => {
  it('adds, then removes on the same click', () => {
    const added = toggleAnnotation([], tool, 100, 50, 'Breakout', 'Trend', 'a1')
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ id: 'a1', type: 'entry', instrument: 'CE', strategy_name: 'Breakout', category: 'Trend' })
    expect(toggleAnnotation(added, tool, 100, 51, 'Breakout', 'Trend', 'a2')).toEqual([])
  })
  it('keeps marks that differ by bar, tool, strategy or category', () => {
    const base = toggleAnnotation([], tool, 100, 50, 'Breakout', 'Trend', 'a1')
    expect(toggleAnnotation(base, tool, 160, 50, 'Breakout', 'Trend', 'a2')).toHaveLength(2)
    expect(toggleAnnotation(base, TOOL_OPTIONS[1], 100, 50, 'Breakout', 'Trend', 'a2')).toHaveLength(2)
    expect(toggleAnnotation(base, tool, 100, 50, 'Other', 'Trend', 'a2')).toHaveLength(2)
    expect(toggleAnnotation(base, tool, 100, 50, 'Breakout', 'Range', 'a2')).toHaveLength(2)
  })
})

describe('strikes', () => {
  const client = () => {
    const request = vi.fn(async (path: string) => {
      if (path.startsWith('data/expiry')) return { expiry: '2026-10-06' }
      if (path.startsWith('data/price-at')) return { price: 24812 }
      if (path.includes('right=CE')) return { strike: 24900, price: 40 }
      return { strike: 24700, price: 38 }
    })
    return { request, api: createPatternsClient(request as never) }
  }
  it('OTM mode: ATM from the 09:15 price, offset applied each way', async () => {
    const { api } = client()
    expect(await resolveStrikes(api, 'NIFTY', '2026-10-01', 2, { mode: 'otm', ceCap: 0, peCap: 0 }))
      .toEqual({ ce: 24900, pe: 24700, atm: 24800, expiry: '2026-10-06' })
  })
  it('Max Price mode on an index uses the two caps; a stock stays OTM', async () => {
    const a = client()
    const r = await resolveStrikes(a.api, 'NIFTY', '2026-10-01', 0, { mode: 'threshold', ceCap: 40, peCap: 38 })
    expect(r).toMatchObject({ ce: 24900, pe: 24700, expiry: '2026-10-06' })
    expect(a.request.mock.calls.some(([p]) => String(p).includes('max_price=40'))).toBe(true)
    const b = client()
    await resolveStrikes(b.api, 'TATPOW', '2026-10-01', 0, { mode: 'threshold', ceCap: 40, peCap: 38 })
    expect(b.request.mock.calls.some(([p]) => String(p).includes('find-strike-by-price'))).toBe(false)
  })
  it('saved strikes: PE falls back to CE on older charts', () => {
    expect(strikesOf({ strike: 24800 })).toEqual({ ce: 24800, pe: 24800 })
    expect(strikesOf({ strike: 24900, strike_pe: 24700 })).toEqual({ ce: 24900, pe: 24700 })
    expect(strikesOf({})).toBeNull()
  })
})

describe('buildSaveBody / defaultPatternDate', () => {
  it('options charts carry right and both strikes; equity charts carry none', () => {
    const o = buildSaveBody({ symbol: 'NIFTY', date: '2026-10-01', instrumentType: 'options', annotations: [], notes: 'n', intervalMinutes: 3, strikes: { ce: 24900, pe: 24700 } })
    expect(o).toMatchObject({ right: 'CE', strike: 24900, strike_pe: 24700, interval_minutes: 3 })
    const e = buildSaveBody({ symbol: 'NIFTY', date: '2026-10-01', instrumentType: 'equity', annotations: [], notes: '', intervalMinutes: 5, strikes: null })
    expect(e.right).toBeUndefined(); expect(e.strike).toBeUndefined()
  })
  it('weekend dates roll back to Friday', () => {
    expect(defaultPatternDate(new Date('2026-11-15T12:00:00Z'))).toBe('2026-11-13')
    expect(defaultPatternDate(new Date('2026-11-14T12:00:00Z'))).toBe('2026-11-13')
    expect(defaultPatternDate(new Date('2026-11-12T12:00:00Z'))).toBe('2026-11-12')
  })
})
