import { describe, expect, it } from 'vitest'
import type { LedgerTrade } from '../../shared/analysis/habits/types'
import {
  CHANGE_THRESHOLD, MIN_COMPARE_TRADES, compareHabit, customPeriods, daySeries, daysWithWithout, lastPeriods, metricOver, rollingMean, toneFor, tradesIn, tradingDays,
  type Period,
} from '../../shared/analysis/habits/habitSeries'

let serial = 0
const trade = (date: string, pnl_pct: number | null, extra: Partial<LedgerTrade> = {}): LedgerTrade => ({
  cycle_id: `c${++serial}`, session_id: 's', date, entry_time: serial, exit_time: serial + 1, symbol: 'NIFTY', right: null, strike: null, direction: 'LONG',
  net_pnl: pnl_pct == null ? 0 : pnl_pct * 100, pnl_pct, capital_pct: 10, risk_pct: null, entries: 1, exits: 1, holding_seconds: 60, bars: 1, r_multiple: null, entry_method: null, habits: [], ...extra,
})
const qa = ['qa']

// Five trading days. Habit qa: D1 two trades, D2 none, D3/D4/D5 one each. Other trades keep every day on the axis.
const D = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07']
const trades = [
  trade(D[0], -2.0, { capital_pct: 20, bars: 1, entries: 1, exits: 1, habits: qa }),
  trade(D[0], 0.5, { capital_pct: 10, bars: 4, entries: 2, exits: 1, habits: qa }),
  trade(D[1], 1.0),
  trade(D[2], -1.0, { capital_pct: 10, bars: 1, habits: qa }),
  trade(D[3], -1.0, { capital_pct: 8, bars: 2, habits: qa }),
  trade(D[4], -0.5, { capital_pct: 5, bars: 1, habits: qa }),
  trade(D[4], 0.25),
]

describe('days and periods', () => {
  it('lists trading days once, oldest first', () => {
    expect(tradingDays([...trades].reverse())).toEqual(D)
  })
  it('splits the last N trading days from the N before, or fewer when history is short', () => {
    const two = lastPeriods(D, 2)!
    expect(two.recent).toEqual({ start: D[3], end: D[4], days: [D[3], D[4]] })
    expect(two.before).toEqual({ start: D[1], end: D[2], days: [D[1], D[2]] })
    const three = lastPeriods(D, 3)!
    expect(three.recent.days).toEqual([D[2], D[3], D[4]])
    expect(three.before.days).toEqual([D[0], D[1]])           // only two days exist before
    expect(lastPeriods(D, 5)).toBeNull()                       // nothing before the recent period
    expect(lastPeriods(D, 0)).toBeNull()
  })
  it('builds custom periods from inclusive ranges and rejects empty ones', () => {
    const periods = customPeriods(D, [D[0], D[1]], [D[3], '2026-12-31'])!
    expect(periods.before.days).toEqual([D[0], D[1]])
    expect(periods.recent.days).toEqual([D[3], D[4]])
    expect(customPeriods(D, ['2025-01-01', '2025-01-31'], [D[3], D[4]])).toBeNull()
    expect(tradesIn(trades, periods.before)).toHaveLength(3)
  })
})

describe('per-day series', () => {
  it('plots counts and sums as 0 and averages as gaps on days without the habit', () => {
    const occurrences = daySeries(trades, D, 'qa', 'occurrences', 'pct', 'mean')
    expect(occurrences.map(p => p.value)).toEqual([2, 0, 1, 1, 1])
    expect(occurrences.map(p => p.trades)).toEqual([2, 0, 1, 1, 1])
    expect(daySeries(trades, D, 'qa', 'net', 'pct', 'mean').map(p => p.value)).toEqual([-1.5, 0, -1, -1, -0.5])
    expect(daySeries(trades, D, 'qa', 'loss', 'pct', 'mean').map(p => p.value)).toEqual([-2, 0, -1, -1, -0.5])
    expect(daySeries(trades, D, 'qa', 'profit', 'pct', 'mean').map(p => p.value)).toEqual([0.5, 0, 0, 0, 0])
    expect(daySeries(trades, D, 'qa', 'net', 'money', 'mean').map(p => p.value)).toEqual([-150, 0, -100, -100, -50])
    expect(daySeries(trades, D, 'qa', 'capital', 'pct', 'mean').map(p => p.value)).toEqual([15, null, 10, 8, 5])
    expect(daySeries(trades, D, 'qa', 'bars', 'pct', 'mean').map(p => p.value)).toEqual([2.5, null, 1, 2, 1])
    expect(daySeries(trades, D, 'qa', 'within_1', 'pct', 'mean').map(p => p.value)).toEqual([50, null, 100, 0, 100])
    expect(daySeries(trades, D, 'qa', 'entries', 'pct', 'median').map(p => p.value)).toEqual([1.5, null, 1, 1, 1])
    expect(daySeries(trades, D, 'unknown', 'occurrences', 'pct', 'mean').map(p => p.value)).toEqual([0, 0, 0, 0, 0])
  })
  it('keeps a day whose trades have no P&L % unavailable for % metrics but not for rupees', () => {
    const rows = [trade(D[0], null, { net_pnl: -40, habits: qa })]
    expect(metricOver(rows, 'net', 'pct', 'mean')).toBeNull()
    expect(metricOver(rows, 'net', 'money', 'mean')).toBe(-40)
    expect(metricOver(rows, 'occurrences', 'pct', 'mean')).toBe(1)
  })
  it('rolls a mean over the last N days, ignoring gaps', () => {
    expect(rollingMean([-1.5, 0, -1, -1, -0.5], 3).map(v => Math.round(v! * 10000) / 10000)).toEqual([-1.5, -0.75, -0.8333, -0.6667, -0.8333])
    expect(rollingMean([null, 2, null, 4], 2)).toEqual([null, 2, 2, 4])
    expect(rollingMean([null, null], 3)).toEqual([null, null])
  })
})

// Two 2-day periods built directly: habit loss, frequency and capital move together or apart.
const before: Period = { start: 'b1', end: 'b2', days: ['b1', 'b2'] }
const recent: Period = { start: 'r1', end: 'r2', days: ['r1', 'r2'] }
const habit = (date: string, pct: number, capital: number, extra: Partial<LedgerTrade> = {}) => trade(date, pct, { capital_pct: capital, habits: qa, ...extra })

describe('period comparison', () => {
  it('flags a costly habit improving when losses, frequency and capital all shrink', () => {
    const rows = [habit('b1', -1, 20), habit('b1', -1, 20), habit('b2', -1, 20), habit('b2', -1, 20), habit('r1', -0.5, 10), habit('r1', -0.5, 10), habit('r2', -0.5, 10)]
    const result = compareHabit(rows, 'qa', before, recent, 'pct', 'mean', 'costly')
    expect(result.trades).toEqual({ before: 4, recent: 3 })
    expect(result.cells.per_day).toMatchObject({ before: 2, recent: 1.5, tone: 'good' })   // a costly habit happening less is good
    expect(result.cells.net.before).toBeCloseTo(-4, 6); expect(result.cells.net.recent).toBeCloseTo(-1.5, 6); expect(result.cells.net.tone).toBe('good')
    expect(result.cells.loss.delta).toBeCloseTo(2.5, 6)
    expect(result.cells.capital).toMatchObject({ before: 20, recent: 10, delta: -10, tone: 'neutral' })
    expect(result.flag).toBe('improving')
    expect(result.reasons[0]).toBe('Loss per day improved')
  })
  it('flags worse when everything grows, and mixed when the signals disagree', () => {
    const worse = [habit('b1', -0.5, 10), habit('b1', -0.5, 10), habit('b2', -0.5, 10), habit('r1', -1, 20), habit('r1', -1, 20), habit('r2', -1, 20), habit('r2', -1, 20)]
    expect(compareHabit(worse, 'qa', before, recent, 'pct', 'mean', 'costly').flag).toBe('worse')
    // Losses shrank, but the habit is now taken with twice the capital: "still taking it, but bigger".
    const mixed = [habit('b1', -1, 10), habit('b1', -1, 10), habit('b2', -1, 10), habit('b2', -1, 10), habit('r1', -0.5, 20), habit('r1', -0.5, 20), habit('r2', -0.5, 20), habit('r2', -0.5, 20)]
    const result = compareHabit(mixed, 'qa', before, recent, 'pct', 'mean', 'costly')
    expect(result.flag).toBe('mixed')
    expect(result.reasons).toEqual(['Loss per day improved', 'Frequency is about the same', 'Capital % moved the wrong way'])
  })
  it('flags same when nothing moves by 10% and too few when a period has fewer than 3 trades', () => {
    const rows = [habit('b1', -1, 10), habit('b1', -1, 10), habit('b2', -1, 10), habit('r1', -1, 10), habit('r1', -1, 10), habit('r2', -1, 10)]
    expect(compareHabit(rows, 'qa', before, recent, 'pct', 'mean', 'costly').flag).toBe('same')
    const sparse = [habit('b1', -1, 10), habit('b1', -1, 10), habit('b2', -1, 10), habit('r1', -1, 10), habit('r2', -1, 10)]
    const result = compareHabit(sparse, 'qa', before, recent, 'pct', 'mean', 'costly')
    expect(result.flag).toBe('too_few')
    expect(result.reasons[0]).toContain(`${MIN_COMPARE_TRADES} trades`)
    expect(result.cells.net.delta).not.toBeNull()    // the numbers are still shown
    expect(CHANGE_THRESHOLD).toBe(0.1)
  })
  it('judges a rewarding habit the other way round and a mixed habit only by its losses', () => {
    const rows = [habit('b1', 0.5, 10), habit('b1', 0.5, 10), habit('b2', 0.5, 10), habit('r1', 0.5, 20), habit('r1', 0.5, 20), habit('r1', 0.5, 20), habit('r2', 0.5, 20), habit('r2', 0.5, 20)]
    const rewarding = compareHabit(rows, 'qa', before, recent, 'pct', 'mean', 'rewarding')
    expect(rewarding.cells.per_day.tone).toBe('good')          // more of a good habit
    expect(rewarding.flag).toBe('improving')                   // happens more often with more capital; no losses to worsen
    const neutral = compareHabit(rows, 'qa', before, recent, 'pct', 'mean', 'mixed')
    expect(neutral.cells.per_day.tone).toBe('neutral')
    expect(neutral.reasons.slice(1)).toEqual(['Frequency not judged (mixed habit)', 'Capital % not judged (mixed habit)'])
    expect(neutral.flag).toBe('same')
  })
  it('colours only results and, for a judged habit, frequency', () => {
    expect(toneFor('net', 0.2, 'mixed')).toBe('good'); expect(toneFor('net', -0.2, 'mixed')).toBe('bad')
    expect(toneFor('loss', 0.5, 'costly')).toBe('good')       // loss is negative: -2 -> -1.5 is better
    expect(toneFor('per_day', -1, 'costly')).toBe('good'); expect(toneFor('per_day', -1, 'rewarding')).toBe('bad'); expect(toneFor('per_day', -1, 'mixed')).toBe('neutral')
    for (const metric of ['capital', 'bars', 'within_1', 'entries', 'exits'] as const) expect(toneFor(metric, 5, 'costly')).toBe('neutral')
    expect(toneFor('net', null, 'costly')).toBe('neutral')
  })
})

describe('days with vs without a habit', () => {
  it('compares the day\'s net of all trades on days the habit occurred and on the other days', () => {
    // Day nets (all trades, % of capital): D1 -1.5, D2 +1.0, D3 -1.0, D4 -1.0, D5 -0.25. The habit occurs on D1, D3, D4, D5.
    const result = daysWithWithout(trades, 'qa', 'pct')
    expect(result.daysWith).toBe(4); expect(result.daysWithout).toBe(1)
    expect(result.netWith).toBeCloseTo((-1.5 - 1.0 - 1.0 - 0.25) / 4, 6)
    expect(result.netWithout).toBeCloseTo(1.0, 6)
    expect(result.difference).toBeCloseTo(result.netWith! - 1.0, 6)
    expect(daysWithWithout(trades, 'nope', 'pct')).toMatchObject({ daysWith: 0, daysWithout: 5, netWith: null, difference: null })
  })
})
