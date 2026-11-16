import { describe, expect, it } from 'vitest'
import { alreadyApplied, buildSessionPut, dayCategoryScores, itemOf, type GameRecord, type ProgressState, type SessionResult } from './progress'
import { EMPTY_STATE } from './progress'

const session = (over: Partial<SessionResult> = {}): SessionResult => ({
  id: 'session-0001', gameId: 'quick_match', mode: 'progress', level: 1, date: '2026-11-15', minutes: 1.5,
  summary: { score: 80, stats: { median_rt: 612 } }, playedAt: '2026-11-15T10:20:30.123Z', ...over,
})
const withGame = (record: GameRecord): ProgressState => ({ ...EMPTY_STATE, games: { quick_match: record } })

describe('buildSessionPut', () => {
  it('creates the game, day and month records for a first Progress session (revision 0)', () => {
    const body = buildSessionPut(EMPTY_STATE, session())
    expect(body.mutation_id).toBe('session-0001')
    expect(body.game).toMatchObject({ id: 'quick_match', revision: 0 })
    expect(body.game!.item).toMatchObject({ level: 1, sessions: 1, best: 80, lastScores: [80], stats: { median_rt: 612 }, lastPlayed: '2026-11-15T10:20:30', consecutiveHigh: 1, consecutiveLow: 0 })
    expect(body.game!.item.emaScore).toBeCloseTo(80 * (0.6 + 0.4 / 20), 2)
    expect(body.day).toMatchObject({ date: '2026-11-15', revision: 0 })
    expect(body.day!.item).toMatchObject({ games: { quick_match: { n: 1, avg: 80, best: 80 } }, minutes: 1.5, categoryScores: { speed: 80 } })
    expect(body.day!.item).not.toHaveProperty('days')
    expect(body.month).toMatchObject({ month: '2026-11', revision: 0 })
    expect(body.month!.item).toMatchObject({ games: { quick_match: { n: 1, avg: 80, best: 80 } }, days: 1 })
  })

  it('carries the server revision and strips server bookkeeping fields', () => {
    const record: GameRecord = { revision: 4, last_mutation_id: 'older-mutation', updated_at: '2026-11-14T00:00:00Z', level: 3, sessions: 7, best: 90, consecutiveHigh: 0, consecutiveLow: 0, emaScore: 50, lastScores: [60, 70] }
    const body = buildSessionPut(withGame(record), session({ level: 3, summary: { score: 60 } }))
    expect(body.game!.revision).toBe(4)
    expect(body.game!.item).not.toHaveProperty('revision')
    expect(body.game!.item).not.toHaveProperty('last_mutation_id')
    expect(body.game!.item).not.toHaveProperty('updated_at')
    expect(body.game!.item).toMatchObject({ sessions: 8, best: 90, lastScores: [60, 70, 60], level: 3 })
    expect(body.game!.item.emaScore).toBeCloseTo(0.7 * 50 + 0.3 * 60 * (0.6 + 0.4 * 3 / 20), 1)
  })

  it('levels up after two strong sessions and keeps only the last 20 scores', () => {
    const first = buildSessionPut(EMPTY_STATE, session({ summary: { score: 90 } }))
    const afterFirst: ProgressState = { ...EMPTY_STATE, games: { quick_match: { revision: 1, ...(first.game!.item as object) } as GameRecord } }
    const second = buildSessionPut(afterFirst, session({ id: 'session-0002', summary: { score: 85 } }))
    expect(second.game!.item).toMatchObject({ level: 2, consecutiveHigh: 0 })
    const long = Array.from({ length: 20 }, (_, i) => i)
    const body = buildSessionPut(withGame({ revision: 1, level: 1, lastScores: long }), session())
    expect((body.game!.item.lastScores as number[]).length).toBe(20)
    expect((body.game!.item.lastScores as number[]).at(-1)).toBe(80)
    expect((body.game!.item.lastScores as number[])[0]).toBe(1)
  })

  it('a Practice session only bumps the practice counter: no level change, no scores, no day or month', () => {
    const body = buildSessionPut(withGame({ revision: 2, level: 5, sessions: 3, lastScores: [50], consecutiveHigh: 1 }), session({ mode: 'practice', level: 9, summary: { score: 100 } }))
    expect(body.day).toBeUndefined(); expect(body.month).toBeUndefined()
    expect(body.game!.item).toMatchObject({ practice: 1, level: 5, sessions: 3, lastScores: [50], consecutiveHigh: 1 })
    expect(body.game!.revision).toBe(2)
  })

  it('adds to an existing day: running average, best, minutes, category mean over games; the month counts a new day once', () => {
    const state: ProgressState = {
      ...EMPTY_STATE,
      days: { '2026-11-15': { revision: 3, last_mutation_id: 'x', games: { quick_match: { n: 1, avg: 60, best: 60 }, grid_recall: { n: 1, avg: 40, best: 40 } }, minutes: 2, categoryScores: { speed: 60, memory: 40 } } },
      months: { '2026-11': { revision: 5, games: { quick_match: { n: 4, avg: 55, best: 70 } }, days: 3, minutes: 9 } },
    }
    const body = buildSessionPut(state, session({ summary: { score: 90 }, minutes: 1 }))
    expect(body.day!.revision).toBe(3)
    expect(body.day!.item).toMatchObject({ games: { quick_match: { n: 2, avg: 75, best: 90 }, grid_recall: { n: 1, avg: 40, best: 40 } }, minutes: 3, categoryScores: { speed: 75, memory: 40 } })
    expect(body.month!.revision).toBe(5)
    expect(body.month!.item).toMatchObject({ days: 3, games: { quick_match: { n: 5, avg: 62, best: 90 } }, minutes: 10 })
  })

  it('passes optional market extras to the day record', () => {
    const body = buildSessionPut(EMPTY_STATE, session({ gameId: 'tick_reader', summary: { score: 70, expectancyR: 0.4, discipline: 88 } }))
    expect(body.day!.item).toMatchObject({ expectancyR: 0.4, discipline: 88 })
  })

  it('is pure: the same state and session give the same body, and the state is not modified', () => {
    const state = withGame({ revision: 1, level: 2, lastScores: [10] })
    const copy = JSON.parse(JSON.stringify(state))
    expect(buildSessionPut(state, session())).toEqual(buildSessionPut(state, session()))
    expect(state).toEqual(copy)
  })
})

describe('helpers', () => {
  it('detects a session the server already holds', () => {
    expect(alreadyApplied(withGame({ revision: 1, last_mutation_id: 'session-0001' }), session())).toBe(true)
    expect(alreadyApplied(withGame({ revision: 1, last_mutation_id: 'other' }), session())).toBe(false)
    expect(alreadyApplied(EMPTY_STATE, session())).toBe(false)
  })
  it('itemOf drops bookkeeping and tolerates null', () => {
    expect(itemOf({ revision: 2, last_mutation_id: 'a', updated_at: 'b', level: 3 } as GameRecord)).toEqual({ level: 3 })
    expect(itemOf(null)).toEqual({})
  })
  it('dayCategoryScores ignores unknown ids and averages within a category', () => {
    expect(dayCategoryScores({ quick_match: { avg: 50 }, colour_clash: { avg: 70 }, bogus: { avg: 99 } } as never)).toEqual({ speed: 60 })
    expect(dayCategoryScores(undefined)).toEqual({})
  })
})

describe('warm-up steps', () => {
  it('a Practice warm-up session also writes the day record with one more step done', () => {
    const state: ProgressState = { ...EMPTY_STATE, days: { '2026-11-15': { revision: 3, games: { quick_match: { n: 2, avg: 70, best: 80 } }, minutes: 3, warmupDone: 2 } } }
    const body = buildSessionPut(state, session({ mode: 'practice', warmup: { step: 3 } }))
    expect(body.game!.item).toMatchObject({ practice: 1 })
    expect(body.day).toMatchObject({ date: '2026-11-15', revision: 3 })
    expect(body.day!.item).toMatchObject({ warmupDone: 3, minutes: 3, games: { quick_match: { n: 2 } } })
    expect(body.day!.item).not.toHaveProperty('revision')
    expect(body.month).toBeUndefined()
  })
  it('a Progress warm-up session adds the step on top of the usual day totals', () => {
    const body = buildSessionPut(EMPTY_STATE, session({ warmup: { step: 1 } }))
    expect(body.day!.item).toMatchObject({ warmupDone: 1, games: { quick_match: { n: 1 } } })
    expect(body.month!.item).not.toHaveProperty('warmupDone')
  })
  it('the count stops at 5 and a boolean from an older client counts as 5', () => {
    const full: ProgressState = { ...EMPTY_STATE, days: { '2026-11-15': { revision: 1, warmupDone: 5 } } }
    expect(buildSessionPut(full, session({ mode: 'practice', warmup: { step: 2 } })).day!.item.warmupDone).toBe(5)
    const legacy: ProgressState = { ...EMPTY_STATE, days: { '2026-11-15': { revision: 1, warmupDone: true } } }
    expect(buildSessionPut(legacy, session({ warmup: { step: 2 } })).day!.item.warmupDone).toBe(5)
  })
  it('a session that is not a warm-up step leaves warmupDone alone and sends no day for Practice', () => {
    expect(buildSessionPut(EMPTY_STATE, session({ mode: 'practice' })).day).toBeUndefined()
    const state: ProgressState = { ...EMPTY_STATE, days: { '2026-11-15': { revision: 1, warmupDone: 3 } } }
    expect(buildSessionPut(state, session()).day!.item.warmupDone).toBe(3)
  })
})
