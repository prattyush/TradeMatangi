import { beforeEach, describe, expect, it } from 'vitest'
import type { RoundTrip, SessionSummary, TradeLabel } from '../../shared/analysis/api'
import { dayProgress, invalidateLabelProgress, MAX_PARALLEL_READS, resetLabelProgress, sessionProgress, subscribeLabelProgress } from '../../shared/analysis/labeling/dayProgress'
import { blankLabel, isFullyLabeled, labelProgress, tripKey, type LabeledRoundTrip } from '../../shared/analysis/labeling/model'
import { groupSessions } from '../../shared/analysis/TradeAnalysis'

const full = (sessionId: string, index: number, over: Partial<TradeLabel> = {}): TradeLabel =>
  ({ ...blankLabel(sessionId, index), expected_category: 'Trend', expected_strategy: 'ORB', actual_category: 'Trend', actual_strategy: 'ORB', ...over })
const trips = (count: number) => Array.from({ length: count }, (_, i) => ({ index: i + 1 }) as RoundTrip)

describe('fully labelled', () => {
  it('needs expected AND actual category and strategy', () => {
    expect(isFullyLabeled(undefined)).toBe(false)
    expect(isFullyLabeled(blankLabel('s', 1))).toBe(false)
    expect(isFullyLabeled(full('s', 1))).toBe(true)
    for (const field of ['expected_category', 'expected_strategy', 'actual_category', 'actual_strategy'] as const) expect(isFullyLabeled(full('s', 1, { [field]: '' })), field).toBe(false)
    // entry and exit tags do not matter
    expect(isFullyLabeled(full('s', 1, { entry_tag: '', exit_tag: '' }))).toBe(true)
  })
  it('counts the labelled round trips of a list (the "1/5" beside Trade 1 of 5)', () => {
    const list = [1, 2, 3, 4, 5].map(index => ({ session_id: 's', index }) as LabeledRoundTrip)
    const labels = new Map<string, TradeLabel>([[tripKey(list[0]), full('s', 1)], [tripKey(list[1]), full('s', 2, { actual_strategy: '' })], [tripKey(list[4]), full('s', 5)]])
    expect(labelProgress(list, labels)).toEqual({ done: 2, total: 5 })
    expect(labelProgress([], new Map())).toEqual({ done: 0, total: 0 })
  })
})

describe('day progress for a date row', () => {
  beforeEach(() => resetLabelProgress())
  const source = (rows: Record<string, { trips: number; labels: TradeLabel[] }>, calls: string[] = []) => ({
    getRoundTrips: async (id: string) => { calls.push(`trips ${id}`); return trips(rows[id].trips) },
    getLabels: async (id: string) => { calls.push(`labels ${id}`); return rows[id].labels },
  })

  it('adds up every session of the day and counts only fully labelled round trips', async () => {
    const api = source({ a: { trips: 3, labels: [full('a', 1), full('a', 2, { expected_strategy: '' })] }, b: { trips: 2, labels: [full('b', 1), full('b', 2)] } })
    expect(await dayProgress(api, ['a', 'b'])).toEqual({ done: 3, total: 5 })
  })
  it('a day with no round trips has nothing to label', async () => {
    expect(await dayProgress(source({ a: { trips: 0, labels: [] } }), ['a'])).toEqual({ done: 0, total: 0 })
  })
  it('reads each session once until its labels change', async () => {
    const calls: string[] = []
    const rows = { a: { trips: 1, labels: [] as TradeLabel[] } }
    const api = source(rows, calls)
    expect(await sessionProgress(api, 'a')).toEqual({ done: 0, total: 1 })
    await sessionProgress(api, 'a'); await dayProgress(api, ['a'])
    expect(calls).toEqual(['trips a', 'labels a'])
    rows.a.labels = [full('a', 1)]
    invalidateLabelProgress(['a'])
    expect(await sessionProgress(api, 'a')).toEqual({ done: 1, total: 1 })
    expect(calls).toHaveLength(4)
  })
  it('tells the date rows when labels were saved, and only for those sessions', () => {
    const seen: string[][] = []
    const stop = subscribeLabelProgress(ids => seen.push(ids))
    invalidateLabelProgress(['a', 'b']); stop(); invalidateLabelProgress(['c'])
    expect(seen).toEqual([['a', 'b']])
  })
  it('reads at most three sessions at a time, so a long search result does not flood the server', async () => {
    let running = 0, most = 0
    const release: Array<() => void> = []
    const api = {
      getRoundTrips: async () => { running += 1; most = Math.max(most, running); await new Promise<void>(resolve => release.push(resolve)); running -= 1; return trips(1) },
      getLabels: async () => [] as TradeLabel[],
    }
    const all = Promise.all(Array.from({ length: 8 }, (_, i) => sessionProgress(api, `s${i}`)))
    for (let guard = 0; guard < 200 && release.length < 8; guard++) { await Promise.resolve(); while (release.length) release.shift()!() }
    await all
    expect(MAX_PARALLEL_READS).toBe(3)
    expect(most).toBeLessThanOrEqual(3)
    expect(most).toBeGreaterThan(0)
  })
  it('a failed read is not remembered: the next look tries again', async () => {
    let fail = true
    const api = { getRoundTrips: async () => { if (fail) throw new Error('offline'); return trips(2) }, getLabels: async () => [] as TradeLabel[] }
    await expect(sessionProgress(api, 'a')).rejects.toThrow('offline')
    fail = false
    expect(await sessionProgress(api, 'a')).toEqual({ done: 0, total: 2 })
  })
})

describe('win percentage on a date row', () => {
  const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
    session_id: id, user_id: 'u', symbol: 'NIFTY', date: '2026-11-10', start_time: null, instrument_type: 'options', session_type: 'real', strike: null, expiry: null,
    session_capital: 100000, net_pnl: 100, pnl_pct: 0.1, total_commission: 10, trade_count: 6, round_trip_count: 3, winning_round_trip_count: 2, buy_count: 3, sell_count: 3, ...over,
  }) as SessionSummary
  it('adds the winning round trips of the sessions of one day', () => {
    const [group] = groupSessions([session('a'), session('b', { round_trip_count: 2, winning_round_trip_count: 1 })])
    expect(group.totalTrades).toBe(5)
    expect(group.winningTrades).toBe(3)
  })
  it('is unknown when a session comes from an older backend without the count', () => {
    const [group] = groupSessions([session('a'), session('b', { winning_round_trip_count: undefined })])
    expect(group.winningTrades).toBeUndefined()
  })
})
