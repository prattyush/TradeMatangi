import { describe, expect, it } from 'vitest'
import { gamesIn, type GameId } from './ids'
import { EMPTY_STATE, type GameRecord, type ProgressState } from './progress'
import { buildWarmup, WARMUP_QUICK, type WarmupInput } from './warmup'
import { catalogueEntry } from './ids'

const brain = gamesIn('brain').map(entry => entry.id)
const market = gamesIn('market').map(entry => entry.id)
const stateWith = (games: Partial<Record<GameId, GameRecord>>): ProgressState => ({ ...EMPTY_STATE, games })
const input = (over: Partial<WarmupInput> = {}): WarmupInput => ({ userId: 'user-1', date: '2026-11-16', pool: 'brain', playable: brain, state: EMPTY_STATE, ...over })

describe('buildWarmup', () => {
  it('is deterministic for the same user, date, pool, progress and games', () => {
    expect(buildWarmup(input())).toEqual(buildWarmup(input()))
  })
  it('changes with the date and the user', () => {
    const a = buildWarmup(input()).steps.map(step => step.gameId).join()
    expect(buildWarmup(input({ date: '2026-11-17' })).steps.map(step => step.gameId).join()).not.toBe(a)
    expect(buildWarmup(input({ userId: 'user-2' })).steps.map(step => step.gameId).join()).not.toBe(a)
  })
  it('brain pool: Quick Match, two weakest categories, Number Sprint, one short game, no repeats', () => {
    const plan = buildWarmup(input())
    expect(plan.steps).toHaveLength(5)
    expect(plan.steps.map(step => step.role)).toEqual(['physical', 'weakest', 'second', 'math', 'random'])
    expect(plan.steps[0].gameId).toBe('quick_match')
    expect(plan.steps[3].gameId).toBe('number_sprint')
    expect(new Set(plan.steps.map(step => step.gameId)).size).toBe(5)
    expect(WARMUP_QUICK).toContain(plan.steps[4].gameId)
    for (const step of plan.steps) expect(catalogueEntry(step.gameId).pool).toBe('brain')
    expect(plan.notice).toBeUndefined()
  })
  it('draws the two lowest-rated categories first; a category never played counts as lowest', () => {
    // Everything rated high except Flexibility (rated low) and Word (never played).
    const games: Partial<Record<GameId, GameRecord>> = {}
    for (const id of brain) {
      const entry = catalogueEntry(id)
      if (entry.category === 'word') continue
      games[id] = { revision: 1, emaScore: entry.category === 'flexibility' ? 20 : 80, sessions: 3 }
    }
    const plan = buildWarmup(input({ state: stateWith(games) }))
    expect(catalogueEntry(plan.steps[1].gameId).category).toBe('word')
    expect(catalogueEntry(plan.steps[2].gameId).category).toBe('flexibility')
  })
  it('prefers a game not played in the last two days', () => {
    const wordIds = brain.filter(id => catalogueEntry(id).category === 'word')
    const games: Partial<Record<GameId, GameRecord>> = {}
    for (const id of brain) games[id] = { revision: 1, emaScore: catalogueEntry(id).category === 'word' ? 10 : 90 }
    games[wordIds[0]] = { revision: 1, emaScore: 10, lastPlayed: '2026-11-16T08:00:00' }
    games[wordIds[1]] = { revision: 1, emaScore: 10, lastPlayed: '2026-11-15T20:00:00' }
    games[wordIds[2]] = { revision: 1, emaScore: 10, lastPlayed: '2026-11-10T20:00:00' }
    const plan = buildWarmup(input({ state: stateWith(games) }))
    expect(plan.steps[1].gameId).toBe(wordIds[2])
  })
  it('market and both pools fall back to brain games with a notice while no market game is playable', () => {
    for (const pool of ['market', 'both'] as const) {
      const plan = buildWarmup(input({ pool }))
      expect(plan.notice).toMatch(/market games are not available/i)
      expect(plan.pool).toBe('brain')
      for (const step of plan.steps) expect(catalogueEntry(step.gameId).pool).toBe('brain')
    }
  })
  it('with market games playable: both mixes the pools, market keeps to the market, brain stays brain', () => {
    const playable = [...brain, ...market]
    const both = buildWarmup(input({ pool: 'both', playable }))
    expect(both.steps[0].gameId).toBe('hotkey_drill')
    expect(both.steps[3].gameId).toBe('risk_calculator')
    expect(new Set(both.steps.map(step => catalogueEntry(step.gameId).pool))).toEqual(new Set(['brain', 'market']))
    const onlyMarket = buildWarmup(input({ pool: 'market', playable: market }))
    expect(onlyMarket.steps.every(step => catalogueEntry(step.gameId).pool === 'market')).toBe(true)
    const onlyBrain = buildWarmup(input({ pool: 'brain', playable }))
    expect(onlyBrain.steps.every(step => catalogueEntry(step.gameId).pool === 'brain')).toBe(true)
    expect(onlyBrain.steps[0].gameId).toBe('quick_match')
  })
  it('step 3 prefers the other pool from step 2 when both pools can supply the category', () => {
    const playable = [...brain, ...market]
    const plan = buildWarmup(input({ pool: 'both', playable }))
    const pools = plan.steps.slice(1, 3).map(step => catalogueEntry(step.gameId).pool)
    expect(new Set(pools).size).toBe(2)
  })
  it('copes with a tiny registry', () => {
    const plan = buildWarmup(input({ playable: ['quick_match', 'colour_clash'] }))
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.steps.length).toBeLessThanOrEqual(5)
    expect(new Set(plan.steps.map(step => step.gameId)).size).toBe(plan.steps.length)
    expect(buildWarmup(input({ playable: [] })).steps).toEqual([])
  })
})
