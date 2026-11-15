import { describe, expect, it, vi } from 'vitest'
import type { PatternAnnotation } from '../../../shared/analysis/api'
import { TOOL_OPTIONS, buildSaveBody, defaultPatternDate, resolveStrikes, riskRewardKey, savedStrikePair, setRank, setRiskReward, strikesOf, toggleAnnotation, uniquePatterns } from './patternLibraryModel'
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

describe('P2b helpers', () => {
  const marks = [
    { id: '1', time: 1, price: 1, type: 'entry', instrument: 'underlying', strategy_name: 'ORB', category: 'Open', text: '' },
    { id: '2', time: 2, price: 1, type: 'exit', instrument: 'underlying', strategy_name: 'ORB', category: 'Open', text: '' },
    { id: '3', time: 3, price: 1, type: 'entry', instrument: 'CE', strategy_name: 'Fade', category: 'Mid', text: '' },
  ] as PatternAnnotation[]

  it('lists each strategy/category once', () => {
    expect(uniquePatterns(marks).map(p => `${p.category}/${p.strategy_name}`)).toEqual(['Open/ORB', 'Mid/Fade'])
  })
  it('sets and clears a rank by identity', () => {
    const top = setRank({}, 'top_1', uniquePatterns(marks)[1].identity)
    expect(top).toEqual({ top_1: { strategy_name: 'Fade', category: 'Mid' } })
    expect(setRank(top, 'top_1', '')).toEqual({})
  })
  it('keeps R:R per category::strategy and drops blanks', () => {
    const key = riskRewardKey('Open', 'ORB')
    expect(setRiskReward({}, key, '1.5')).toEqual({ 'Open::ORB': '1.5' })
    expect(setRiskReward({ 'Open::ORB': '1.5' }, key, ' ')).toEqual({})
  })
  it('saves the first CE and PE strike, and one strike for both when only one right is shown', () => {
    expect(savedStrikePair([{ id: 1, right: 'CE', strike: 24000 }, { id: 2, right: 'PE', strike: 24100 }, { id: 3, right: 'CE', strike: 23900 }])).toEqual({ ce: 24000, pe: 24100 })
    expect(savedStrikePair([{ id: 1, right: 'PE', strike: 24100 }])).toEqual({ ce: 24100, pe: 24100 })
    expect(savedStrikePair([])).toBeNull()
  })
})
