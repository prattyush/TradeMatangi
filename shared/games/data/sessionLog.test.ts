import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { LocalSession } from '../core/dashboard'
import type { ReviewRow } from '../core/trial'
import { createIdbSessionLog, createMemorySessionLog, KEEP_PER_GAME, KEEP_REVIEWS, MAX_REVIEW_ROWS, openSessionLog, pruneSessions } from './sessionLog'

const rows = (n: number): ReviewRow[] => Array.from({ length: n }, (_, i) => ({ n: i + 1, shown: 'a', answered: 'b', correctAnswer: 'b', correct: true, rtMs: 400 }))
const entry = (i: number, over: Partial<LocalSession> = {}): LocalSession => ({
  id: `id-${String(i).padStart(4, '0')}`, gameId: 'quick_match', date: '2026-11-15', level: 1, mode: 'progress', seed: i, score: 50,
  stats: { median_rt: 500 }, playedAt: `2026-11-15T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`, review: rows(3), ...over,
})

describe('pruneSessions', () => {
  it('keeps review rows on the newest 20 sessions only, and the stats on the rest', () => {
    const all = Array.from({ length: 25 }, (_, i) => entry(i, { gameId: i % 2 ? 'colour_clash' : 'quick_match' }))
    const { keep, dropIds } = pruneSessions(all)
    expect(dropIds).toEqual([]); expect(keep).toHaveLength(25)
    expect(keep.filter(e => e.review).length).toBe(KEEP_REVIEWS)
    const oldest = keep.filter(e => !e.review)
    expect(oldest.every(e => e.stats !== undefined)).toBe(true)
    expect(Math.max(...oldest.map(e => e.seed))).toBeLessThan(Math.min(...keep.filter(e => e.review).map(e => e.seed)))
  })
  it('keeps at most 30 sessions per game and drops the oldest', () => {
    const all = Array.from({ length: 35 }, (_, i) => entry(i))
    const { keep, dropIds } = pruneSessions(all)
    expect(keep).toHaveLength(KEEP_PER_GAME)
    expect(dropIds).toHaveLength(5)
    expect(dropIds.sort()).toEqual(['id-0000', 'id-0001', 'id-0002', 'id-0003', 'id-0004'])
  })
  it('cuts one session to 250 trial rows', () => {
    const { keep } = pruneSessions([entry(1, { review: rows(400) })])
    expect(keep[0].review).toHaveLength(MAX_REVIEW_ROWS)
  })
  it('does not mutate its input', () => {
    const all = Array.from({ length: 22 }, (_, i) => entry(i))
    pruneSessions(all)
    expect(all.every(e => e.review?.length === 3)).toBe(true)
  })
})

describe('session logs', () => {
  it('stores and lists oldest first in IndexedDB, replacing a repeated id', async () => {
    const factory = new IDBFactory()
    const log = createIdbSessionLog(factory)
    await log.add(entry(2)); await log.add(entry(1)); await log.add(entry(2, { score: 99 }))
    const list = await log.list()
    expect(list.map(e => e.id)).toEqual(['id-0001', 'id-0002'])
    expect(list[1].score).toBe(99)
  })
  it('survives a reopen and prunes in the database', async () => {
    const factory = new IDBFactory()
    const first = createIdbSessionLog(factory)
    for (let i = 0; i < 24; i++) await first.add(entry(i, { gameId: 'colour_clash' }))
    const second = await openSessionLog(factory)
    const list = await second.list()
    expect(list).toHaveLength(24)
    expect(list.filter(e => e.review).length).toBe(KEEP_REVIEWS)
    for (let i = 24; i < 40; i++) await second.add(entry(i, { gameId: 'colour_clash' }))
    expect((await second.list()).length).toBe(KEEP_PER_GAME)
  })
  it('the memory log behaves the same way', async () => {
    const log = createMemorySessionLog()
    for (let i = 0; i < 33; i++) await log.add(entry(i))
    const list = await log.list()
    expect(list).toHaveLength(KEEP_PER_GAME)
    expect(list.filter(e => e.review).length).toBe(KEEP_REVIEWS)
  })
  it('falls back to memory when IndexedDB is missing', async () => {
    const log = await openSessionLog({ open: () => { throw new Error('blocked') } } as unknown as IDBFactory)
    await log.add(entry(1))
    expect(await log.list()).toHaveLength(1)
  })
})
