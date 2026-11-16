import { describe, expect, it } from 'vitest'
import { EMPTY_STATE, type ProgressState } from './progress'
import { gameRows, trendDirection, trendSeries, warmupCount, warmupStreak, WARMUP_STEPS, type LocalSession } from './dashboard'
import { daysBetween, shiftDate } from './dates'

const days = (spec: Record<string, boolean | number>): ProgressState['days'] =>
  Object.fromEntries(Object.entries(spec).map(([date, done]) => [date, { revision: 1, warmupDone: done }]))

describe('dates', () => {
  it('shifts across month, year and leap days without drifting', () => {
    expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29')
    expect(daysBetween('2026-03-28', '2026-04-02')).toBe(5)
    expect(daysBetween('2026-11-16', '2026-11-15')).toBe(-1)
  })
})

describe('warmup streak', () => {
  it('counts a boolean as a full routine and a number as steps, capped at 5', () => {
    expect(warmupCount({ revision: 1, warmupDone: true })).toBe(WARMUP_STEPS)
    expect(warmupCount({ revision: 1, warmupDone: 3 })).toBe(3)
    expect(warmupCount({ revision: 1, warmupDone: 9 })).toBe(5)
    expect(warmupCount({ revision: 1, warmupDone: false })).toBe(0)
    expect(warmupCount(undefined)).toBe(0)
  })
  it('needs 4 of 5 steps to keep a day', () => {
    const streak = warmupStreak(days({ '2026-11-14': 3, '2026-11-15': 4, '2026-11-16': 5 }), '2026-11-16')
    expect(streak).toEqual({ current: 2, best: 2, doneToday: true })
  })
  it('stays alive today when yesterday was kept, and breaks after a missed day', () => {
    const kept = days({ '2026-11-13': 5, '2026-11-14': 5, '2026-11-15': 4 })
    expect(warmupStreak(kept, '2026-11-16')).toEqual({ current: 3, best: 3, doneToday: false })
    expect(warmupStreak(kept, '2026-11-17')).toMatchObject({ current: 0, best: 3, doneToday: false })
  })
  it('finds the best run even when it is not the current one', () => {
    const history = days({ '2026-11-01': 5, '2026-11-02': 5, '2026-11-03': 5, '2026-11-04': 5, '2026-11-10': 5, '2026-11-11': 4 })
    expect(warmupStreak(history, '2026-11-11')).toEqual({ current: 2, best: 4, doneToday: true })
  })
})

describe('game rows and filter', () => {
  const state: ProgressState = { ...EMPTY_STATE, games: { quick_match: { revision: 2, level: 4, sessions: 6, best: 91, emaScore: 70.4, lastScores: [60, 80], practice: 2 } } }
  it('filters by pool and reads level, best and scores from the record', () => {
    const brain = gameRows(state, 'brain'), market = gameRows(state, 'market'), all = gameRows(state, 'all')
    expect(brain).toHaveLength(21); expect(market).toHaveLength(10); expect(all).toHaveLength(31)
    expect(brain.find(row => row.id === 'quick_match')).toMatchObject({ level: 4, sessions: 6, best: 91, scores: [60, 80], practice: 2 })
    expect(brain.find(row => row.id === 'colour_clash')).toMatchObject({ level: 1, sessions: 0, best: undefined, scores: [] })
  })
})

describe('trend series', () => {
  const session = (n: number, over: Partial<LocalSession> = {}): LocalSession => ({ id: `s${n}`, gameId: 'colour_clash', date: '2026-11-15', level: 1, mode: 'progress', seed: n, score: 50, stats: { stroop_effect: 100 - n * 10 }, playedAt: `2026-11-15T10:0${n}:00Z`, ...over })
  it('reads the stat over Progress sessions of that game, oldest first, ignoring practice and other games', () => {
    const list = [session(3), session(1), session(2, { mode: 'practice' }), session(4, { gameId: 'flanker_flock' }), session(5, { stats: {} })]
    expect(trendSeries(list, 'colour_clash', 'stroop_effect')).toEqual([90, 70])
  })
  it('keeps the newest 30', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...session(1), id: `m${i}`, playedAt: `2026-11-15T10:${String(i).padStart(2, '0')}:00Z`, stats: { stroop_effect: i } }))
    const values = trendSeries(many, 'colour_clash', 'stroop_effect')
    expect(values).toHaveLength(30); expect(values[0]).toBe(10); expect(values[29]).toBe(39)
  })
  it('says better, worse, steady or unknown', () => {
    expect(trendDirection([120, 110, 100, 90, 80, 70], 'lower')).toBe('better')
    expect(trendDirection([120, 110, 100, 90, 80, 70], 'higher')).toBe('worse')
    expect(trendDirection([5, 5, 5, 5, 5], 'lower')).toBe('steady')
    expect(trendDirection([5, 6], 'lower')).toBe('unknown')
  })
})
