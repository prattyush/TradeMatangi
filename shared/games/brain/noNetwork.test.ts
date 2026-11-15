import { describe, expect, it } from 'vitest'
import { createGamesClient, type GamesRequest } from '../core/client'
import { EMPTY_STATE, type SessionResult } from '../core/progress'
import { createMemoryOutbox } from '../data/outbox'
import { recordSession } from '../data/sync'
import { simulateBlock } from './engine/simPlayers'
import quickMatch from './games/quick_match'
import { quickMatchSim } from './games/quick_match/engine'

describe('a brain session touches the network only for the single progress write (spec 17.10)', () => {
  it('playing a whole block makes no request; finishing it costs one state read and one state write', async () => {
    const calls: string[] = []
    const request: GamesRequest = (async (path: string, method: string) => {
      calls.push(`${method} ${path}`)
      return method === 'GET' ? { ...EMPTY_STATE } : { version: 1, applied: true, records: {} }
    }) as GamesRequest
    const summary = simulateBlock(quickMatch, quickMatchSim, 1, 'perfect', 5) // the whole block, nothing else is wired to a transport
    expect(calls).toEqual([])
    const session: SessionResult = { id: 'session-brain-1', gameId: 'quick_match', mode: 'progress', level: 1, date: '2026-11-15', minutes: 1, summary, playedAt: '2026-11-15T10:00:00Z' }
    const report = await recordSession(createMemoryOutbox(), createGamesClient(request), session)
    expect(report).toMatchObject({ sent: 1, pending: 0 })
    expect(calls.filter(call => call.startsWith('PUT'))).toEqual(['PUT state'])
    expect(calls.every(call => call.endsWith(' state'))).toBe(true)
  })
  it('the per-trial review is not part of what the server stores', async () => {
    const bodies: unknown[] = []
    const request: GamesRequest = (async (_path: string, method: string, body?: unknown) => {
      if (method === 'PUT') bodies.push(body)
      return method === 'GET' ? { ...EMPTY_STATE } : { version: 1, applied: true, records: {} }
    }) as GamesRequest
    const summary = simulateBlock(quickMatch, quickMatchSim, 1, 'perfect', 5)
    expect(summary.review!.length).toBeGreaterThan(30)
    await recordSession(createMemoryOutbox(), createGamesClient(request), { id: 'session-brain-2', gameId: 'quick_match', mode: 'progress', level: 1, date: '2026-11-15', minutes: 1, summary, playedAt: '2026-11-15T10:00:00Z' })
    expect(JSON.stringify(bodies)).not.toContain('correctAnswer')
    expect(JSON.stringify(bodies)).not.toContain('"review"')
    expect(JSON.stringify(bodies).length).toBeLessThan(3000)
  })
})
