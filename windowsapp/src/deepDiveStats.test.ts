import { describe, expect, it } from 'vitest'
import type { LedgerTrade } from '../../shared/analysis/habits/types'
import {
  MIN_TERCILE_TRADES, barBuckets, barsBucket, capitalBucket, capitalBuckets, capitalEdges, halfHour, quantile, quickLosses, scatterPoints, sortTrades, timeBuckets, weekdayBuckets, weekdayOf,
} from '../../shared/analysis/habits/deepDiveStats'

let serial = 0
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000
const trade = (pnl_pct: number | null, extra: Partial<LedgerTrade> = {}): LedgerTrade => ({
  cycle_id: `c${++serial}`, session_id: 's', date: '2026-10-05', entry_time: at('2026-10-05', '09:20'), exit_time: null, symbol: 'NIFTY', right: null, strike: null, direction: 'LONG',
  net_pnl: pnl_pct == null ? 0 : pnl_pct * 100, pnl_pct, capital_pct: 10, risk_pct: null, entries: 1, exits: 1, holding_seconds: 60, bars: 1, r_multiple: null, entry_method: null, habits: [], ...extra,
})

describe('bars held buckets', () => {
  it('maps bars to the 1, 2, 3–5, 6–10, over 10 and unknown buckets at every boundary', () => {
    expect([0, 1, 2, 3, 5, 6, 10, 11, 40].map(b => barsBucket(b))).toEqual(['1', '1', '2', '3-5', '3-5', '6-10', '6-10', '11+', '11+'])
    expect(barsBucket(null)).toBe('unknown')
  })
  it('summarizes each bucket (hand-computed)', () => {
    const rows = [
      trade(-1.0, { bars: 1 }), trade(0.5, { bars: 1 }), trade(-2.0, { bars: 2 }), trade(-0.5, { bars: 3 }), trade(1.0, { bars: 5 }),
      trade(-1.0, { bars: 6 }), trade(2.0, { bars: 10 }), trade(-3.0, { bars: 11 }), trade(0.2, { bars: null }),
    ]
    const buckets = barBuckets(rows, 'pct', 'mean')
    expect(buckets.map(b => [b.label, b.count])).toEqual([['1 bar', 2], ['2 bars', 1], ['3–5 bars', 2], ['6–10 bars', 2], ['Over 10 bars', 1], ['Unknown', 1]])
    const one = buckets[0]
    expect(one.net).toBeCloseTo(-0.5, 6); expect(one.win_pct).toBe(50); expect(one.average).toBeCloseTo(-0.25, 6)
    expect(buckets[2].net).toBeCloseTo(0.5, 6); expect(buckets[3].net).toBeCloseTo(1.0, 6); expect(buckets[4].net).toBeCloseTo(-3.0, 6)
    expect(barBuckets(rows, 'money', 'mean')[0].net).toBeCloseTo(-50, 6)
    expect(barBuckets(rows, 'pct', 'median')[3].average).toBeCloseTo(0.5, 6)
    expect(barBuckets([trade(1, { bars: 2 })], 'pct', 'mean').map(b => b.label)).toEqual(['2 bars'])   // empty buckets are left out
    expect(barBuckets([], 'pct', 'mean')).toEqual([])
  })
  it('does not turn a bucket with no P&L % into 0%', () => {
    const [row] = barBuckets([trade(null, { bars: 1, net_pnl: -40 })], 'pct', 'mean')
    expect(row).toMatchObject({ count: 1, net: null, average: null, measured: 0 })
    expect(barBuckets([trade(null, { bars: 1, net_pnl: -40 })], 'money', 'mean')[0].net).toBe(-40)
  })
})

describe('capital % buckets', () => {
  it('interpolates quantiles', () => {
    expect(quantile([10, 20, 30, 40, 50, 60], 1 / 3)).toBeCloseTo(26.6667, 3)
    expect(quantile([10, 20, 30, 40, 50, 60], 2 / 3)).toBeCloseTo(43.3333, 3)
    expect(quantile([null, 5], 0.5)).toBe(5)
    expect(quantile([], 0.5)).toBeNull()
  })
  const scope = [10, 20, 30, 40, 50, 60].map(c => trade(0.1, { capital_pct: c }))
  it('splits the user\'s own trades into thirds and classifies edges inclusively', () => {
    const edges = capitalEdges(scope)!
    expect(edges.low).toBeCloseTo(26.6667, 3); expect(edges.high).toBeCloseTo(43.3333, 3)
    expect([10, edges.low, 30, edges.high, 45, null].map(c => capitalBucket(c, edges))).toEqual(['low', 'low', 'medium', 'medium', 'high', 'unknown'])   // the edges themselves belong to the lower bucket
    const habit = [trade(-1, { capital_pct: 10 }), trade(-2, { capital_pct: 15 }), trade(0.5, { capital_pct: 30 }), trade(1.5, { capital_pct: 45 }), trade(0.1, { capital_pct: null })]
    const result = capitalBuckets(habit, scope, 'pct', 'mean')!
    expect(result.rows.map(r => [r.key, r.count])).toEqual([['low', 2], ['medium', 1], ['high', 1], ['unknown', 1]])
    expect(result.rows[0].net).toBeCloseTo(-3.0, 6)
    expect(result.rows[0].label).toBe('Smaller (up to 26.7%)')
    expect(result.rows[2].label).toBe('Larger (over 43.3%)')
  })
  it('does not split when there are too few trades or no spread', () => {
    expect(MIN_TERCILE_TRADES).toBe(6)
    expect(capitalEdges(scope.slice(0, 5))).toBeNull()
    expect(capitalEdges(Array.from({ length: 8 }, () => trade(0.1, { capital_pct: 10 })))).toBeNull()
    expect(capitalBuckets([trade(1)], scope.slice(0, 3), 'pct', 'mean')).toBeNull()
  })
})

describe('time of day and weekday', () => {
  it('uses the entry clock in half-hour buckets, in order, empty ones left out', () => {
    expect(halfHour(at('2026-10-05', '09:20'))).toEqual({ key: '09:00', label: '09:00–09:30' })
    expect(halfHour(at('2026-10-05', '09:30'))).toEqual({ key: '09:30', label: '09:30–10:00' })
    expect(halfHour(at('2026-10-05', '15:29')).label).toBe('15:00–15:30')
    const rows = [trade(1, { entry_time: at('2026-10-05', '14:10') }), trade(-1, { entry_time: at('2026-10-05', '09:40') }), trade(-2, { entry_time: at('2026-10-06', '09:45') })]
    const buckets = timeBuckets(rows, 'pct', 'mean')
    expect(buckets.map(b => [b.label, b.count])).toEqual([['09:30–10:00', 2], ['14:00–14:30', 1]])
    expect(buckets[0].net).toBeCloseTo(-3, 6)
  })
  it('groups by weekday from the trading date', () => {
    expect(weekdayOf('2026-10-05')).toBe('1')                  // Monday
    const rows = [trade(1, { date: '2026-10-05' }), trade(-1, { date: '2026-10-12' }), trade(2, { date: '2026-10-06' })]
    const buckets = weekdayBuckets(rows, 'pct', 'mean')
    expect(buckets.map(b => [b.label, b.count, b.net])).toEqual([['Monday', 2, 0], ['Tuesday', 1, 2]])
  })
})

describe('quick losses', () => {
  it('counts the losers closed within one candle and their share of the loss', () => {
    const rows = [trade(-1.0, { bars: 1 }), trade(-3.0, { bars: 1 }), trade(-4.0, { bars: 5 }), trade(-2.0, { bars: null }), trade(2.0, { bars: 1 })]
    const result = quickLosses(rows, 'pct')
    expect(result).toMatchObject({ losers: 4, known: 3, quick: 2, quick_pct: (100 * 2) / 3 })      // the unknown-bars loser is not counted as quick or slow
    expect(result.quick_loss).toBeCloseTo(-4, 6)
    expect(result.quick_loss_share).toBeCloseTo((100 * -4) / -10, 6)
    expect(quickLosses([trade(1)], 'pct')).toMatchObject({ losers: 0, quick_pct: null, quick_loss_share: null })
  })
})

describe('scatter and sorting', () => {
  const rows = [
    trade(-1, { entry_time: 300, capital_pct: 20 }), trade(0.5, { entry_time: 100, capital_pct: 10 }), trade(2, { entry_time: 200, capital_pct: null }), trade(null, { entry_time: 400, capital_pct: 5 }),
    trade(1, { entry_time: 500, capital_pct: 8 }),
  ]
  it('plots capital % against the result, colours by recency and drops trades missing either value', () => {
    const points = scatterPoints(rows, 'pct')
    expect(points.map(p => [p.x, p.y])).toEqual([[10, 0.5], [20, -1], [8, 1]])
    expect(points.map(p => p.recency)).toEqual([0, 0.5, 1])    // 5 trades in time order; indices 0, 2 and 4 survive
    expect(scatterPoints(rows, 'money').map(p => p.y)).toEqual([50, -100, 0, 100])        // the trade without a P&L % still has rupees
  })
  it('sorts by a column with missing values last in either direction', () => {
    expect(sortTrades(rows, 'capital', 'asc', 'pct').map(t => t.capital_pct)).toEqual([5, 8, 10, 20, null])
    expect(sortTrades(rows, 'capital', 'desc', 'pct').map(t => t.capital_pct)).toEqual([20, 10, 8, 5, null])
    expect(sortTrades(rows, 'pnl', 'asc', 'pct').map(t => t.pnl_pct)).toEqual([-1, 0.5, 1, 2, null])
    expect(sortTrades(rows, 'date', 'desc', 'pct').map(t => t.entry_time)).toEqual([500, 400, 300, 200, 100])
  })
})
