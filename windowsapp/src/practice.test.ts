import { describe, expect, it, vi } from 'vitest'
import { createPracticeClient } from '../../shared/practice/client'
import { practiceStartConfig } from '../../shared/practice/startConfig'
import {
  bestFor, captureSentence, captureText, daysOnOffer, deltaText, gradeLabel, pctText, pickFilter, pointsText, runLine, tripMarks,
} from '../../shared/practice/model'
import { GRADES, type Grade, type PracticeStrategy, type ReviewTrade } from '../../shared/practice/types'

const strategy: PracticeStrategy = {
  category: 'Breakout', strategy: 'Opening range', days: 5,
  grades: { ideal: 2, average: 1, poor: 0, ungraded: 1, failed: 1, open: 0 },
  symbols: [{ symbol: 'BSESEN', days: 1 }, { symbol: 'NIFTY', days: 4 }],
}
const all = new Set<Grade>(GRADES)

const trade = (extra: Partial<ReviewTrade> = {}): ReviewTrade => ({
  index: 0, instrument: 'CE', right: 'CE', strike: 24500, expiry: '2026-10-07', action: 'BUY', side: 'buy', state: 'closed', quantity: 75,
  pnl: 1500, pnl_pct: 2, entry: { time: 1_791_244_800 + 9 * 3600 + 51 * 60 + 20, price: 55 }, exit: { time: 1_791_244_800 + 10 * 3600 + 24 * 60 + 5, price: 75 },
  points: 20, entry_delta_min: 6, exit_delta_min: -6, capture_pct: 50, theoretical_points: 40, theoretical_rupees: 3000, ...extra,
})

describe('what to send for a pick', () => {
  it('sends nothing when every grade is ticked and no symbol is chosen', () => {
    expect(pickFilter('', all)).toEqual({})
  })
  it('sends the symbol and only the ticked grades, in a fixed order', () => {
    expect(pickFilter('NIFTY', new Set<Grade>(['failed', 'ideal']))).toEqual({ symbol: 'NIFTY', grades: ['ideal', 'failed'] })
    expect(pickFilter('', new Set<Grade>())).toEqual({}) // nothing ticked: the screen disables Start instead
  })
  it('counts the days a choice leaves on offer', () => {
    expect(daysOnOffer(strategy, '', all)).toBe(5)
    expect(daysOnOffer(strategy, 'BSESEN', all)).toBe(1)
    expect(daysOnOffer(strategy, '', new Set<Grade>(['ideal']))).toBe(2)
    expect(daysOnOffer(strategy, 'BSESEN', new Set<Grade>(['ideal']))).toBe(1) // never more than the symbol has
    expect(daysOnOffer(strategy, '', new Set<Grade>(['poor']))).toBe(0)
  })
  it('names every grade', () => {
    expect(GRADES.map(gradeLabel)).toEqual(['Ideal', 'Average', 'Poor', 'Success (not graded)', 'Failed', 'No outcome'])
  })
})

describe('the wording of the review', () => {
  it('says early, late or on the candle', () => {
    expect(deltaText(6)).toBe('Entered 6 min late')
    expect(deltaText(-3)).toBe('Entered 3 min early')
    expect(deltaText(0)).toBe('Entered on the recorded candle')
    expect(deltaText(-6, 'exit')).toBe('Exited 6 min early')
    expect(deltaText(null)).toBe('—')
  })
  it('formats points, percentages and capture', () => {
    expect([pointsText(12), pointsText(-3.5), pointsText(null), pctText(2.5), captureText(49.6), captureText(null)])
      .toEqual(['+12.00 pts', '-3.50 pts', '—', '+2.50%', '50%', '—'])
  })
  it('explains what a trade kept of the theoretical move, or why it cannot say', () => {
    expect(captureSentence(trade())).toBe('You kept 50% of the +40.00 pts on offer.')
    expect(captureSentence(trade({ theoretical_points: null, capture_pct: null }))).toMatch(/could not be priced/)
    expect(captureSentence(trade({ theoretical_points: -5, capture_pct: null }))).toMatch(/made nothing/)
    expect(captureSentence(trade({ points: null, exit: null, capture_pct: null }))).toMatch(/Still open/)
  })
  it('summarises a run for the History list', () => {
    expect(runLine(null)).toBe('Not reviewed yet')
    expect(runLine({ traded: false })).toBe('No trade')
    expect(runLine({ traded: true, entry_delta_min: 3, capture_pct: 75 })).toBe('3 min late · kept 75%')
    expect(runLine({ traded: true, entry_delta_min: -2, capture_pct: null })).toBe('2 min early')
  })
  it('finds the best priced pair of an instrument', () => {
    const setup = { theoretical: [{ instrument: 'underlying' as const, strike: null, expiry: null, unavailable: 'no data' },
      { instrument: 'CE' as const, strike: 24500, expiry: null, points: 21 }] }
    expect(bestFor(setup, 'CE')?.points).toBe(21)
    expect(bestFor(setup, 'underlying')).toBeNull()
  })
})

describe('your trades as gold marks', () => {
  it('puts the entry and exit on the candle they happened in, on the traded instrument', () => {
    const marks = tripMarks(trade(), { category: 'Breakout', strategy: 'Opening range' }, 3, 'buy0')
    expect(marks.map(m => [m.type, m.instrument, m.action, m.source])).toEqual([['entry', 'CE', 'BUY', 'traded'], ['exit', 'CE', 'SELL', 'traded']])
    expect(marks[0].time % 180).toBe(0)
    expect(marks[0].time).toBe(1_791_244_800 + 9 * 3600 + 51 * 60) // 09:51:20 sits on the 09:51 candle
    expect(marks[1].time).toBe(1_791_244_800 + 10 * 3600 + 24 * 60)
    expect(marks[0].text).toBe('BUY 75 @ 55')
    expect(new Set(marks.map(m => m.id)).size).toBe(2)
  })
  it('a short and an open trade', () => {
    const short = tripMarks(trade({ action: 'SELL', instrument: 'underlying', right: null }), { category: 'c', strategy: 's' }, 5, 'k')
    expect(short.map(m => [m.type, m.action])).toEqual([['entry', 'SELL'], ['exit', 'BUY']])
    expect(tripMarks(trade({ exit: null }), { category: 'c', strategy: 's' }, 3, 'k').map(m => m.type)).toEqual(['entry'])
  })
})

describe('the client', () => {
  it('uses the deep-dive/practice paths a transport must allow', async () => {
    const request = vi.fn(async (path: string) => path.endsWith('strategies') ? { strategies: [strategy] } : path.endsWith('runs') ? { runs: [] } : { ok: true })
    const api = createPracticeClient(request as never)
    expect(await api.strategies()).toEqual([strategy])
    expect(await api.runs()).toEqual([])
    await api.pick({ category: 'Breakout', strategy: 'Opening range' })
    await api.pick({ category: 'Breakout', strategy: 'Opening range' }, { symbol: 'NIFTY', grades: ['ideal', 'failed'] })
    await api.evaluate('s 1')
    expect(request.mock.calls).toEqual([
      ['deep-dive/practice/strategies', 'GET'], ['deep-dive/practice/runs', 'GET'],
      ['deep-dive/practice/pick', 'POST', { category: 'Breakout', strategy: 'Opening range' }],
      ['deep-dive/practice/pick', 'POST', { category: 'Breakout', strategy: 'Opening range', symbol: 'NIFTY', grades: ['ideal', 'failed'] }],
      ['deep-dive/practice/evaluate?session_id=s%201', 'GET'],
    ])
  })
})

describe('the instrument settings of a practice start', () => {
  const plan = (extra: Record<string, unknown> = {}) => ({
    symbol: 'NIFTY', date: '2026-10-16', start_time: '09:33:00', interval_minutes: 3, instrument_type: 'options' as const,
    strike_ce: 24500, strike_pe: 24400, expiry: '2026-10-20', practice: { category: 'c', strategy: 's', start_offset_min: 12 },
    days_available: 1, repeated: false, ...extra,
  })
  const lookups = () => ({ getExpiry: vi.fn(async () => ({ expiry: '2026-10-27' })), getPriceAt: vi.fn(async () => ({ price: 24512 })) })

  it('trades the strikes the day was marked on, with no lookups', async () => {
    const l = lookups()
    expect(await practiceStartConfig(plan(), l)).toEqual({ symbol: 'NIFTY', date: '2026-10-16', instrument_type: 'options', strike: 24500, expiry: '2026-10-20', strike_ce: 24500, strike_pe: 24400, underlyingPrice: 0 })
    expect(l.getExpiry).not.toHaveBeenCalled(); expect(l.getPriceAt).not.toHaveBeenCalled()
  })
  it('fills strikes that were never saved with the ATM strike at the start time', async () => {
    const l = lookups()
    const c = await practiceStartConfig(plan({ strike_ce: null, strike_pe: 24400 }), l)
    expect([c.strike_ce, c.strike_pe, c.underlyingPrice]).toEqual([24500, 24400, 24512]) // 24512 rounds to 24500 on a 50 interval
    expect(l.getPriceAt).toHaveBeenCalledWith('NIFTY', '2026-10-16', '09:33')
    const both = await practiceStartConfig(plan({ strike_ce: null, strike_pe: null, symbol: 'BSESEN' }), l)
    expect([both.strike_ce, both.strike_pe]).toEqual([24500, 24500]) // 100 interval: 24512 -> 24500
  })
  it('looks the expiry up only when the server gave none', async () => {
    const l = lookups()
    expect((await practiceStartConfig(plan({ expiry: null }), l)).expiry).toBe('2026-10-27')
  })
  it('an equity-only symbol is plain equity', async () => {
    const l = lookups()
    expect(await practiceStartConfig(plan({ instrument_type: 'equity', strike_ce: null, strike_pe: null, expiry: null }), l))
      .toEqual({ symbol: 'NIFTY', date: '2026-10-16', instrument_type: 'equity', underlyingPrice: 0 })
    expect(l.getExpiry).not.toHaveBeenCalled()
  })
})
