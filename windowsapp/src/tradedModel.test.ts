import { describe, expect, it } from 'vitest'
import { buildMarkers, TRADED_MARK_COLOR } from '../../shared/analysis/patternMarkers'
import { clock, contractFor, directionText, filterStrategies, instrumentName, matchedText, pnlText, saveText, timeRange, tradedMarks, TRADED_BAR_SECONDS, tradeInstrument } from '../../shared/traded/model'
import type { TradedStrategy, TradedTrade } from '../../shared/traded/types'

const base = Date.parse('2026-10-16T09:00:00Z') / 1000 // the chart clock: IST wall time written as UTC
const trade = (extra: Partial<TradedTrade> = {}): TradedTrade => ({
  session_id: 's1', round_trip_index: 2, date: '2026-10-16', symbol: 'NIFTY', session_type: 'paper', instrument_type: 'options',
  right: 'CE', strike: 24500, expiry: '2026-10-20', action: 'BUY', side: 'buy', state: 'closed',
  entry: { time: base + 21 * 60 + 5, price: 100, quantity: 65 }, exit: { time: base + 48 * 60 + 40, price: 130.5, quantity: 65 },
  pnl: 1950, pnl_pct: 1.9, expected: { category: 'Breakout', strategy: 'ORB' }, actual: { category: '', strategy: '' }, matched_as: 'expected', ...extra,
})
const ref = { category: 'Breakout', strategy: 'ORB' }

describe('traded marks', () => {
  it('draws a long option trade as a BUY entry and a SELL exit on its own leg, on 3-minute bars', () => {
    const [entry, exit] = tradedMarks(trade(), ref)
    expect([entry.type, entry.action, entry.instrument, entry.price]).toEqual(['entry', 'BUY', 'CE', 100])
    expect([exit.type, exit.action, exit.instrument, exit.price]).toEqual(['exit', 'SELL', 'CE', 130.5])
    expect(entry.time % TRADED_BAR_SECONDS).toBe(0)
    expect(clock(entry.time)).toBe('09:21') // 09:21:05 sits in the 09:21 bar
    expect(clock(exit.time)).toBe('09:48')
    expect([entry.source, entry.strategy_name, entry.category]).toEqual(['traded', 'ORB', 'Breakout'])
    expect(entry.id).not.toBe(exit.id)
  })

  it('draws a short trade as a SELL entry and a BUY exit, and a stock or index trade on the underlying', () => {
    const [entry, exit] = tradedMarks(trade({ action: 'SELL', right: null, strike: null, expiry: null, side: 'sell' }), ref)
    expect([entry.action, exit.action, entry.instrument]).toEqual(['SELL', 'BUY', 'underlying'])
    expect(tradeInstrument(trade({ right: 'PE' }))).toBe('PE')
    expect(tradeInstrument(trade({ right: null }))).toBe('underlying')
  })

  it('draws only the entry of a trade that is still open', () => {
    const marks = tradedMarks(trade({ exit: null, state: 'open' }), ref)
    expect(marks.map(m => m.type)).toEqual(['entry'])
  })

  it('gives the markers a gold, order-named look that never dims', () => {
    const marks = tradedMarks(trade(), ref)
    const markers = buildMarkers(marks, 'Some other strategy', 'Other', undefined, undefined)
    expect(markers.map(m => m.text)).toEqual(['⚑ BUY', '⚑ SELL'])
    expect(markers.every(m => m.color === TRADED_MARK_COLOR)).toBe(true)
    expect(markers.map(m => [m.position, m.shape])).toEqual([['belowBar', 'arrowUp'], ['aboveBar', 'arrowDown']])
    const short = buildMarkers(tradedMarks(trade({ action: 'SELL' }), ref), null, null)
    expect(short.map(m => m.text)).toEqual(['⚑ SELL', '⚑ BUY'])
    expect(short[0].position).toBe('aboveBar')
  })

  it('leaves ordinary pattern marks exactly as they were', () => {
    const ordinary = buildMarkers([{ id: 'a', time: 1, price: 1, type: 'entry', instrument: 'CE', strategy_name: 'ORB', category: 'Breakout', text: '' }], 'ORB', 'Breakout')
    expect(ordinary[0].color).toBe('#22c55e')
    expect(ordinary[0].text).toBe('Break/ORB')
  })
})

describe('wording', () => {
  it('names the instrument, the time range and the position', () => {
    expect(instrumentName(trade())).toBe('NIFTY CE 24500')
    expect(instrumentName(trade({ right: null, strike: null }))).toBe('NIFTY')
    expect(timeRange(trade())).toBe('09:21 → 09:48')
    expect(timeRange(trade({ exit: null }))).toBe('09:21 → open')
    expect(directionText(trade())).toBe('Bought · Buy setup')
    expect(directionText(trade({ action: 'SELL', right: 'PE', side: 'buy' }))).toBe('Sold · Buy setup') // a short PE is bullish
    expect(directionText(trade({ side: null }))).toBe('Bought')
    expect([pnlText(1950), pnlText(-12.5), pnlText(0)]).toEqual(['+1950.00', '-12.50', '+0.00'])
    expect([matchedText('expected'), matchedText('actual'), matchedText('both')]).toEqual(['Expected', 'Actual', 'Expected and actual'])
  })

  it('needs a strike and an expiry to draw an option chart', () => {
    expect(contractFor(trade())).toEqual({ right: 'CE', strike: 24500, expiry: '2026-10-20' })
    expect(contractFor(trade({ right: null }))).toBeNull()
    expect(contractFor(trade({ expiry: null }))).toBeNull()
  })

  it('filters strategies by category or name and words the save result', () => {
    const list: TradedStrategy[] = [
      { category: 'Breakout', strategy: 'ORB', trades: 3, expected: 3, actual: 1, last_date: '2026-10-16', sessions: 2 },
      { category: 'Reversal', strategy: 'Double top', trades: 1, expected: 0, actual: 1, last_date: '2026-10-01', sessions: 1 },
    ]
    expect(filterStrategies(list, '  ').length).toBe(2)
    expect(filterStrategies(list, 'rever').map(s => s.strategy)).toEqual(['Double top'])
    expect(filterStrategies(list, 'orb').map(s => s.strategy)).toEqual(['ORB'])
    expect(filterStrategies(list, 'zzz')).toEqual([])
    expect(saveText({ merged: false, added: 2 })).toBe('Saved as a new pattern chart with 2 marks')
    expect(saveText({ merged: true, added: 1 })).toBe("Added 1 mark to the day's pattern chart")
  })
})
