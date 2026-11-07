import { describe, expect, it } from 'vitest'
import type { BehaviorQuestion } from '../../shared/analysis/api'
import type { LedgerTrade } from '../../shared/analysis/habits/types'
import { LOW_SAMPLE_TRADES, mean, median, metric, sortHabits, stat, summarize, totals, verdictFor, worstFirst } from '../../shared/analysis/habits/habitStats'

let serial = 0
const trade = (date: string, net_pnl: number, pnl_pct: number | null, extra: Partial<LedgerTrade> = {}): LedgerTrade => ({
  cycle_id: `c${++serial}`, session_id: 's', date, entry_time: serial, exit_time: serial + 1, symbol: 'NIFTY', right: null, strike: null, direction: 'LONG',
  net_pnl, pnl_pct, capital_pct: null, risk_pct: null, entries: 1, exits: 1, holding_seconds: 60, bars: 1, r_multiple: null, entry_method: null, habits: [], ...extra,
})
const question = (id: string, kind: 'entry' | 'exit', status: 'active' | 'archived' = 'active'): BehaviorQuestion => ({
  question_id: id, kind, text: `Habit ${id}`, status, sort_order: 0, created_at: '2026-10-01', archived_at: status === 'archived' ? '2026-10-20' : null,
})

describe('mean / median / stat', () => {
  it('skip missing values and handle odd, even and empty sets', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(mean([1, null, 3, undefined, NaN])).toBe(2)
    expect(median([null, undefined])).toBeNull()
    expect(mean([])).toBeNull()
    expect(stat([2, null, 4, 9])).toEqual({ mean: 5, median: 4, n: 3 })
  })
})

// A 4-day scope with 11 trades whose per-habit numbers are worked out by hand in the assertions below.
const trades = [
  trade('d1', 100, 1.0, { capital_pct: 10, bars: 1, entries: 1, exits: 1, habits: ['qa'] }),
  trade('d1', -200, -2.0, { capital_pct: 20, bars: 1, entries: 1, exits: 1, habits: ['qa', 'qb'] }),
  trade('d2', -100, -1.0, { capital_pct: 15, bars: 3, entries: 2, exits: 1, habits: ['qa'] }),
  trade('d2', 50, 0.5, { capital_pct: 5, bars: 6, entries: 1, exits: 2, habits: ['qa'] }),
  trade('d2', -50, -0.5, { capital_pct: 5, bars: 2, habits: ['qb'] }),
  trade('d3', 300, 3.0, { capital_pct: 10, bars: 4 }),
  trade('d3', -20, -0.2, { capital_pct: null, bars: 1 }),
  trade('d3', 0.001, 0.0001, { bars: 2 }),                       // break-even: |net| below half a paisa
  trade('d4', 100, 1.0, { capital_pct: 10, bars: null }),
  trade('d4', -60, -0.6, { capital_pct: 12, bars: 1, habits: ['qb'] }),
  trade('d4', 10, null, { bars: 1, habits: ['qe'] }),            // no capital: no P&L %
]
const questions = [question('qa', 'entry'), question('qb', 'exit'), question('qc', 'entry', 'archived'), question('qd', 'exit'), question('qe', 'entry')]

describe('totals', () => {
  it('splits wins, losses and break-even and sums profit % / loss % separately', () => {
    const scope = totals(trades)
    expect(scope).toMatchObject({ trades: 11, pct_trades: 10, days: 4, wins: 5, losses: 5, breakeven: 1 })
    expect(scope.profit_pct).toBeCloseTo(5.5, 6)   // 1.0 + 0.5 + 3.0 + 1.0 (the +10 ₹ win has no %)
    expect(scope.loss_pct).toBeCloseTo(-4.3, 6)    // -2.0 -1.0 -0.5 -0.2 -0.6
    expect(scope.net_pnl).toBeCloseTo(100 - 200 - 100 + 50 - 50 + 300 - 20 + 0.001 + 100 - 60 + 10, 6)
    expect(totals([])).toMatchObject({ trades: 0, win_pct: null, avg_win_pct: null, profit_factor: null, payoff_ratio: null, largest_loss_pct: null, net_pct: 0 })
  })
})

describe('habit summaries', () => {
  const overview = summarize(questions, trades)
  const habitA = overview.habits.find(h => h.question_id === 'qa')!
  const habitB = overview.habits.find(h => h.question_id === 'qb')!

  it('computes results for a habit (trades 1-4)', () => {
    expect(habitA.habit).toMatchObject({ trades: 4, days: 2, wins: 2, losses: 2, win_pct: 50, net_pnl: -150, profit_pnl: 150, loss_pnl: -300 })
    expect(habitA.habit.net_pct).toBeCloseTo(-1.5, 6)
    expect(habitA.habit.profit_pct).toBeCloseTo(1.5, 6)
    expect(habitA.habit.loss_pct).toBeCloseTo(-3.0, 6)
    expect(habitA.habit.pct.mean).toBeCloseTo(-0.375, 6)      // (1 - 2 - 1 + 0.5) / 4
    expect(habitA.habit.pct.median).toBeCloseTo(-0.25, 6)     // middle of -2, -1, 0.5, 1
    expect(habitA.habit.pnl.mean).toBeCloseTo(-37.5, 6)
    expect(habitA.habit.pnl.median).toBeCloseTo(-25, 6)
    expect(habitA.habit.avg_win_pct).toBeCloseTo(0.75, 6)
    expect(habitA.habit.avg_loss_pct).toBeCloseTo(-1.5, 6)
    expect(habitA.habit.payoff_ratio).toBeCloseTo(0.5, 6)
    expect(habitA.habit.profit_factor).toBeCloseTo(0.5, 6)
    expect(habitA.habit.largest_loss_pct).toBeCloseTo(-2.0, 6)
    expect(habitA.habit.largest_loss_pnl).toBe(-200)
  })
  it('compares against the trades without the habit and reports what skipping it would have changed', () => {
    expect(habitA.baseline.trades).toBe(7)
    expect(habitA.baseline.pct.n).toBe(6)                       // the trade without a P&L % is left out
    expect(habitA.baseline.pct.mean).toBeCloseTo((-0.5 + 3.0 - 0.2 + 0.0001 + 1.0 - 0.6) / 6, 6)
    expect(habitA.if_skipped_pct).toBeCloseTo(1.5, 6)
    expect(habitA.if_skipped_pnl).toBe(150)
    expect(metric(habitA, 'vs_without', 'pct', 'mean')).toBeCloseTo(-0.375 - habitA.baseline.pct.mean!, 6)
    expect(metric(habitA, 'vs_without', 'money', 'median')).toBeCloseTo(-25 - habitA.baseline.pnl.median!, 6)
  })
  it('attributes shares of all losses and profits (habits overlap, so they are not additive)', () => {
    expect(habitA.share_of_loss_pct).toBeCloseTo((100 * 3.0) / 4.3, 6)
    expect(habitA.share_of_profit_pct).toBeCloseTo((100 * 1.5) / 5.5, 6)
    expect(habitB.share_of_loss_pct).toBeCloseTo((100 * 3.1) / 4.3, 6)   // T2 counts for both habits
    expect(habitA.per_scope_day).toBeCloseTo(1, 6)                      // 4 trades over 4 trading days
  })
  it('profiles size, entries/exits and how fast the trades closed', () => {
    const profile = habitA.profile
    expect(profile.entries).toEqual({ mean: 1.25, median: 1, n: 4 })
    expect(profile.exits).toEqual({ mean: 1.25, median: 1, n: 4 })
    expect(profile.capital).toEqual({ mean: 12.5, median: 12.5, n: 4, max: 20 })
    expect(profile.bars).toEqual({ mean: 2.75, median: 2, n: 4 })
    expect(profile.within_1_bar_pct).toBe(50)       // bars 1, 1, 3, 6
    expect(profile.within_2_bars_pct).toBe(50)
    expect(profile.loser_within_1_bar_pct).toBe(50) // losers: the 1-bar one and the 3-bar one
    expect(habitB.profile.within_1_bar_pct).toBeCloseTo(200 / 3, 6)   // bars 1, 2, 1
    expect(habitB.profile.loser_within_1_bar_pct).toBeCloseTo(200 / 3, 6)
    expect(habitB.habit).toMatchObject({ trades: 3, days: 3, wins: 0, losses: 3, win_pct: 0, profit_factor: 0 })
    expect(habitB.habit.payoff_ratio).toBeNull()
  })
  it('keeps a habit without any P&L % usable and marks it low sample', () => {
    const habitE = overview.habits.find(h => h.question_id === 'qe')!
    expect(habitE.habit).toMatchObject({ trades: 1, pct_trades: 0, net_pnl: 10 })
    expect(habitE.if_skipped_pct).toBeNull()
    expect(habitE.verdict).toBe('low_sample')
    expect(habitE.profile.capital).toMatchObject({ n: 0, mean: null, max: null })
  })
  it('lists active habits with no trades as idle and honours the kind and archived filters', () => {
    expect(overview.habits.map(h => h.question_id).sort()).toEqual(['qa', 'qb', 'qe'])
    expect(overview.idle.map(q => q.question_id)).toEqual(['qd'])     // archived habits without trades are not listed
    expect(summarize(questions, trades, { kind: 'exit' }).habits.map(h => h.question_id)).toEqual(['qb'])
    expect(summarize(questions, trades, { kind: 'exit' }).idle.map(q => q.question_id)).toEqual(['qd'])
    const archivedTrade = [trade('d1', -10, -0.1, { habits: ['qc'] })]
    expect(summarize(questions, archivedTrade).habits.map(h => [h.question_id, h.status])).toEqual([['qc', 'archived']])
    expect(summarize(questions, archivedTrade, { includeArchived: false }).habits).toEqual([])
    expect(summarize(questions, trades).scope.trades).toBe(11)
  })
})

describe('verdicts', () => {
  const many = (count: number, net: number, pct: number | null) => Array.from({ length: count }, () => trade('d1', net, pct))
  it('is low sample below the threshold and decided at it', () => {
    expect(verdictFor(totals(many(LOW_SAMPLE_TRADES - 1, -100, -1)), totals([])).verdict).toBe('low_sample')
    expect(verdictFor(totals(many(LOW_SAMPLE_TRADES, -100, -1)), totals([])).verdict).toBe('costly')
  })
  it('calls a habit costly when it loses and does worse than the trades without it, rewarding for the opposite', () => {
    expect(verdictFor(totals(many(10, -100, -1)), totals(many(5, 100, 1))).verdict).toBe('costly')
    expect(verdictFor(totals(many(10, 100, 1)), totals(many(5, -100, -1))).verdict).toBe('rewarding')
  })
  it('is mixed when a losing habit still does better than the alternative (or the reverse)', () => {
    const habit = [...many(9, -10, -0.1), trade('d1', 20, 0.2)]
    expect(verdictFor(totals(habit), totals(many(5, -100, -1))).verdict).toBe('mixed')
    expect(verdictFor(totals(many(10, 10, 0.1)), totals(many(5, 100, 1))).verdict).toBe('mixed')
  })
  it('falls back to rupees when no trade has a P&L %, and explains itself', () => {
    const result = verdictFor(totals(many(10, -10, null)), totals(many(5, 10, null)))
    expect(result.verdict).toBe('costly')
    expect(result.reason).toContain('₹')
    expect(verdictFor(totals(many(10, -100, -1)), totals(many(5, 100, 1))).reason).toBe('Net −10.00% over 10 trades; −1.00% per trade vs +1.00% without it.')
  })
})

describe('sorting and metrics', () => {
  const overview = summarize(questions, trades)
  it('puts the most destructive habit first by default and honours unit and direction', () => {
    expect(worstFirst(overview.habits, 'pct', 'mean').map(h => h.question_id)).toEqual(['qb', 'qa', 'qe'])    // -3.1, -1.5, no %
    expect(sortHabits(overview.habits, 'net', 'desc', 'pct', 'mean').map(h => h.question_id)).toEqual(['qa', 'qb', 'qe'])
    expect(sortHabits(overview.habits, 'net', 'asc', 'money', 'mean').map(h => h.question_id)).toEqual(['qb', 'qa', 'qe']) // ₹ -310, -150, +10
    expect(metric(overview.habits.find(h => h.question_id === 'qe')!, 'net', 'pct', 'mean')).toBeNull()
  })
  it('always sorts missing values last and text alphabetically', () => {
    expect(sortHabits(overview.habits, 'capital', 'asc', 'pct', 'mean').map(h => h.question_id).at(-1)).toBe('qe')
    expect(sortHabits(overview.habits, 'capital', 'desc', 'pct', 'mean').map(h => h.question_id).at(-1)).toBe('qe')
    expect(sortHabits(overview.habits, 'text', 'asc', 'pct', 'mean').map(h => h.text)).toEqual(['Habit qa', 'Habit qb', 'Habit qe'])
  })
  it('switches columns between mean and median and between % and rupees', () => {
    const a = overview.habits.find(h => h.question_id === 'qa')!
    expect(metric(a, 'average', 'pct', 'mean')).toBeCloseTo(-0.375, 6)
    expect(metric(a, 'average', 'pct', 'median')).toBeCloseTo(-0.25, 6)
    expect(metric(a, 'average', 'money', 'mean')).toBeCloseTo(-37.5, 6)
    expect(metric(a, 'net', 'money', 'mean')).toBe(-150)
    expect(metric(a, 'capital', 'pct', 'median')).toBe(12.5)
    expect(metric(a, 'capital_max', 'pct', 'mean')).toBe(20)
    expect(metric(a, 'trades', 'pct', 'mean')).toBe(4)
  })
})
