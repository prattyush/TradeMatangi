import { describe, expect, it } from 'vitest'
import { formatBrowseDate, isWeekday, latestBrowseDate, nearestStrike, searchInstruments, shiftTradingDay, strikeLadder, withRecent, type Instrument } from './browseModel'

describe('trading days', () => {
  it('skips weekends in both directions', () => {
    expect(shiftTradingDay('2026-11-06', 1)).toBe('2026-11-09') // Friday -> Monday
    expect(shiftTradingDay('2026-11-09', -1)).toBe('2026-11-06') // Monday -> Friday
    expect(shiftTradingDay('2026-11-09', 1)).toBe('2026-11-10')
    expect(shiftTradingDay('2026-12-31', 1)).toBe('2027-01-01') // year end
  })
  it('knows weekdays and rejects invalid dates', () => {
    expect(isWeekday('2026-11-09')).toBe(true)
    expect(isWeekday('2026-11-08')).toBe(false)
    expect(isWeekday('2026-02-30')).toBe(false)
    expect(isWeekday('nonsense')).toBe(false)
  })
  it('opens on the last completed trading day, never today', () => {
    expect(latestBrowseDate(new Date(2026, 10, 10, 12))).toBe('2026-11-09') // Tuesday -> Monday
    expect(latestBrowseDate(new Date(2026, 10, 9, 20))).toBe('2026-11-06') // Monday evening -> Friday
    expect(latestBrowseDate(new Date(2026, 10, 8, 9))).toBe('2026-11-06') // Sunday -> Friday
  })
  it('formats the date button', () => {
    expect(formatBrowseDate('2026-11-09')).toBe('Mon 9 Nov')
    expect(formatBrowseDate('bad')).toBe('bad')
  })
})

describe('searchInstruments', () => {
  const list: Instrument[] = [
    { symbol: 'RELIND', display_name: 'Reliance Industries', chart_type: 'equity' },
    { symbol: 'NIFTY', display_name: 'NIFTY 50', chart_type: 'index', option_eligible: true },
    { symbol: 'TATMOT', display_name: 'Tata Motors', chart_type: 'equity' },
    { symbol: 'BSESEN', display_name: 'S&P BSE SENSEX', chart_type: 'index' },
  ]
  it('lists indices first when nothing is typed', () => {
    expect(searchInstruments(list, '').map(item => item.symbol)).toEqual(['NIFTY', 'BSESEN', 'RELIND', 'TATMOT'])
  })
  it('matches the symbol or the name in any case', () => {
    expect(searchInstruments(list, 'tata').map(item => item.symbol)).toEqual(['TATMOT'])
    expect(searchInstruments(list, ' relind ').map(item => item.symbol)).toEqual(['RELIND'])
    expect(searchInstruments(list, 'zzz')).toEqual([])
  })
})

describe('strikes', () => {
  it('rounds to the nearest listed strike', () => {
    expect(nearestStrike(24512, 50)).toBe(24500)
    expect(nearestStrike(24526, 50)).toBe(24550)
  })
  it('builds a ladder around the price, lowest first', () => {
    const ladder = strikeLadder(24512, 50, 2)
    expect(ladder).toEqual([24400, 24450, 24500, 24550, 24600])
    expect(strikeLadder(24512, 50)).toHaveLength(43)
  })
  it('gives nothing without a price or an interval, and never a non-positive strike', () => {
    expect(strikeLadder(0, 50)).toEqual([])
    expect(strikeLadder(100, 0)).toEqual([])
    expect(strikeLadder(60, 50, 5).every(strike => strike > 0)).toBe(true)
  })
})

describe('withRecent', () => {
  it('moves a symbol to the front without duplicates and keeps six', () => {
    expect(withRecent(['A', 'B', 'C'], 'B')).toEqual(['B', 'A', 'C'])
    expect(withRecent(['1', '2', '3', '4', '5', '6'], '7')).toEqual(['7', '1', '2', '3', '4', '5'])
  })
})
