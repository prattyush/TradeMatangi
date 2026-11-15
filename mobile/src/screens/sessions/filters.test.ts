import { describe, expect, it } from 'vitest'
import { activeFilterCount, customRangeProblem, DEFAULT_FILTERS, rangeDates, type SessionFilters } from './filters'
import { clockTime, dateParts, formatPnl, modeLabel, pnlClass } from './format'

const today = new Date(2026, 10, 10) // 10 Nov 2026, local
const withFilters = (patch: Partial<SessionFilters>): SessionFilters => ({ ...DEFAULT_FILTERS, ...patch })

describe('session filters', () => {
  it('turns a preset into start and end dates', () => {
    expect(rangeDates(withFilters({ range: '7d' }), today)).toEqual({ startDate: '2026-11-03', endDate: '2026-11-10' })
    expect(rangeDates(withFilters({ range: '30d' }), today)).toEqual({ startDate: '2026-10-11', endDate: '2026-11-10' })
    expect(rangeDates(withFilters({ range: '1y' }), today)).toEqual({ startDate: '2025-11-10', endDate: '2026-11-10' })
  })
  it('uses the custom dates, ending today when no end is given', () => {
    expect(rangeDates(withFilters({ range: 'custom', start: '2026-09-01', end: '2026-09-30' }), today)).toEqual({ startDate: '2026-09-01', endDate: '2026-09-30' })
    expect(rangeDates(withFilters({ range: 'custom', start: '2026-09-01' }), today).endDate).toBe('2026-11-10')
  })
  it('rejects custom ranges that are empty, backwards or too wide', () => {
    expect(customRangeProblem(withFilters({ range: 'custom' }))).toMatch(/start/)
    expect(customRangeProblem(withFilters({ range: 'custom', start: '2026-10-01', end: '2026-09-01' }))).toMatch(/before/)
    expect(customRangeProblem(withFilters({ range: 'custom', start: '2024-01-01', end: '2026-01-01' }))).toMatch(/at most/)
    expect(customRangeProblem(withFilters({ range: 'custom', start: '2026-09-01', end: '2026-09-30' }))).toBeNull()
    expect(customRangeProblem(withFilters({ range: '30d' }))).toBeNull()
  })
  it('counts only filters that differ from the default', () => {
    expect(activeFilterCount(DEFAULT_FILTERS)).toBe(0)
    expect(activeFilterCount(withFilters({ range: '90d', mode: 'paper', symbol: 'NIFTY' }))).toBe(3)
  })
})

describe('formatting', () => {
  it('formats dates without a timezone shift', () => {
    expect(dateParts('2026-11-09')).toEqual({ day: '09', month: 'Nov', weekday: 'Mon', year: '2026' })
    expect(dateParts('2026-01-01').weekday).toBe('Thu')
    expect(dateParts('garbage').day).toBe('garbage')
  })
  it('formats P&L with Indian grouping and a sign', () => {
    expect(formatPnl(1240)).toBe('+₹1,240')
    expect(formatPnl(-125000.4)).toBe('-₹1,25,000')
    expect(formatPnl(0)).toBe('₹0')
    expect(formatPnl(-85.5, true)).toBe('-₹85.50')
    expect(pnlClass(5)).toBe('pos'); expect(pnlClass(-5)).toBe('neg'); expect(pnlClass(0)).toBe('flat')
  })
  it('names session modes and reads IST clock times from epoch seconds', () => {
    expect(modeLabel('sim')).toBe('Replay'); expect(modeLabel('real')).toBe('Real'); expect(modeLabel('paper')).toBe('Paper')
    expect(clockTime(Date.UTC(2026, 10, 9, 9, 15, 7) / 1000)).toBe('09:15:07')
  })
})
