import { describe, expect, it } from 'vitest'
import { emptyPicks, formatBrowseDate, isWeekday, keepStrike, latestBrowseDate, maxPriceRequest, nearestStrike, parseCap, readMaxPrice, searchInstruments, shiftTradingDay, strikeLadder, withRecent, type Instrument, type PreparedPane } from './browseModel'

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

describe('CE and PE picks', () => {
  it('start manual with no strike on either side', () => {
    expect(emptyPicks()).toEqual({ CE: { mode: 'manual', strike: null, cap: null }, PE: { mode: 'manual', strike: null, cap: null } })
    expect(emptyPicks().CE).not.toBe(emptyPicks().CE) // never shared between sides or calls
  })
  it('keeps a listed strike and otherwise falls to the middle of the ladder', () => {
    const ladder = [100, 150, 200, 250, 300]
    expect(keepStrike(150, ladder)).toBe(150)
    expect(keepStrike(999, ladder)).toBe(200)
    expect(keepStrike(null, ladder)).toBe(200)
    expect(keepStrike(150, [])).toBe(150)
  })
  it('accepts only a positive number as a premium cap', () => {
    expect(parseCap('50')).toBe(50)
    expect(parseCap(' 62.5 ')).toBe(62.5)
    expect(parseCap('62.456')).toBe(62.46)
    for (const bad of ['', ' ', '0', '-5', 'abc', 'Infinity', '1e999']) expect(parseCap(bad)).toBeNull()
  })
  it('asks the server for one option pane with the cap, at the ladder\'s reference time', () => {
    expect(maxPriceRequest('NIFTY', '2026-11-09', '2026-11-13', 'PE', 60)).toEqual({
      mode: 'browse', date: '2026-11-09', reference_time: '09:30:00',
      panes: [{ id: 'browse', kind: 'option', symbol: 'NIFTY', interval: '3', tradingDate: '2026-11-09', expiry: '2026-11-13', strike: '', right: 'PE', selection_mode: 'max_price', max_price: 60 }],
    })
  })
  it('reads the strike the server found, or throws its reason', () => {
    const pane = (availability: PreparedPane['availability'], strike = '24600', reason: string | null = null) => ({ panes: [{ pane: { strike }, availability, reason, premium: 48.5 }] })
    expect(readMaxPrice(pane('available'))).toEqual({ strike: 24600, premium: 48.5 })
    expect(readMaxPrice(pane('waiting'))).toEqual({ strike: 24600, premium: 48.5 })
    expect(() => readMaxPrice(pane('error', '', 'No observed premium at or below the cap within 30 strikes'))).toThrow('No observed premium')
    expect(() => readMaxPrice(pane('unavailable', '24600', 'No data is available for this contract/date'))).toThrow('No data')
    expect(() => readMaxPrice(pane('available', ''))).toThrow()
    expect(() => readMaxPrice({ panes: [] })).toThrow('no strike')
    expect(() => readMaxPrice(null)).toThrow()
  })
})
