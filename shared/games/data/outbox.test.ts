import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createGamesClient, GamesHttpError, parseNativeError, type GamesClient, type GamesRequest } from '../core/client'
import { EMPTY_STATE, type GameRecord, type ProgressState, type PutBody, type SessionResult } from '../core/progress'
import { createIdbOutbox, createMemoryOutbox, openOutbox, type Outbox } from './outbox'
import { flushOutbox, recordSession } from './sync'

const session = (id: string, over: Partial<SessionResult> = {}): SessionResult => ({
  id, gameId: 'quick_match', mode: 'progress', level: 1, date: '2026-11-15', minutes: 1, summary: { score: 80 }, playedAt: '2026-11-15T10:00:00Z', ...over,
})

/** An in-memory stand-in for the server rules in games_persistence_service: revisions, 409 with current records, mutation ids. */
class FakeServer implements GamesClient {
  state: ProgressState = { ...EMPTY_STATE, games: {}, days: {}, months: {} }
  puts = 0
  failNext: Array<unknown> = []
  beforePut?: () => void
  async getState() { if (this.failNext.length && this.failNext[0] === 'get') { this.failNext.shift(); throw new Error('offline') } return JSON.parse(JSON.stringify(this.state)) as ProgressState }
  async putState(body: PutBody) {
    if (this.failNext.length && this.failNext[0] !== 'get') throw this.failNext.shift()
    this.beforePut?.(); this.beforePut = undefined
    this.puts += 1
    const targets: Array<['games' | 'days' | 'months', string, { revision: number; item: Record<string, unknown> }]> = []
    if (body.game) targets.push(['games', body.game.id, body.game])
    if (body.day) targets.push(['days', body.day.date, body.day])
    if (body.month) targets.push(['months', body.month.month, body.month])
    for (const [bucket, key, entry] of targets) {
      const current = (this.state[bucket] as Record<string, { revision: number }>)[key]
      if ((current?.revision ?? 0) !== entry.revision) throw new GamesHttpError(409, 'conflict', { current: {} })
    }
    for (const [bucket, key, entry] of targets) {
      ;(this.state[bucket] as Record<string, unknown>)[key] = { ...entry.item, revision: entry.revision + 1, last_mutation_id: body.mutation_id }
    }
    return { version: 1, applied: true, records: {} }
  }
}

describe('outbox (IndexedDB)', () => {
  it('stores, lists oldest first, ignores duplicates, removes, counts attempts', async () => {
    const box = createIdbOutbox(new IDBFactory())
    await box.add(session('a-0000001')); await box.add(session('b-0000002')); await box.add(session('a-0000001'))
    expect((await box.list()).map(entry => entry.id)).toEqual(['a-0000001', 'b-0000002'])
    await box.bumpAttempts('a-0000001'); await box.bumpAttempts('missing')
    expect((await box.list())[0].attempts).toBe(1)
    await box.remove('a-0000001')
    expect((await box.list()).map(entry => entry.id)).toEqual(['b-0000002'])
  })
  it('survives a reopen of the same database (a closed and reopened window)', async () => {
    const factory = new IDBFactory()
    await createIdbOutbox(factory).add(session('keep-000001', { summary: { score: 61 } }))
    const reopened = createIdbOutbox(factory)
    expect((await reopened.list())[0].session.summary.score).toBe(61)
  })
  it('falls back to memory when IndexedDB is unavailable, and still works', async () => {
    const box = await openOutbox({ open() { throw new Error('blocked') } } as unknown as IDBFactory)
    await box.add(session('mem-0000001'))
    expect(await box.list()).toHaveLength(1)
  })
})

describe('flushOutbox', () => {
  const setup = async (...ids: string[]) => { const box: Outbox = createMemoryOutbox(); for (const id of ids) await box.add(session(id)); return { box, server: new FakeServer() } }

  it('sends queued sessions in order and empties the queue', async () => {
    const { box, server } = await setup('s-0000001', 's-0000002')
    const report = await flushOutbox(box, server)
    expect(report).toMatchObject({ sent: 2, dropped: 0, pending: 0 })
    expect(server.state.games.quick_match).toMatchObject({ sessions: 2, revision: 2 })
    expect((server.state.games.quick_match as GameRecord).lastScores).toEqual([80, 80])
    expect(report.state?.games.quick_match?.sessions).toBe(2)
  })

  it('re-applies the session on top of a newer record after a 409', async () => {
    const { box, server } = await setup('s-0000001')
    server.beforePut = () => { server.state.games.quick_match = { revision: 5, level: 4, sessions: 10, best: 99, lastScores: [99], consecutiveHigh: 0, consecutiveLow: 0 } }
    const report = await flushOutbox(box, server)
    expect(report.sent).toBe(1)
    expect(server.state.games.quick_match).toMatchObject({ sessions: 11, revision: 6, best: 99, level: 4 })
    expect(server.puts).toBe(2)
  })

  it('does not apply a session twice when the first attempt succeeded but the reply was lost', async () => {
    const { box, server } = await setup('s-0000001')
    await server.putState({ mutation_id: 's-0000001', game: { id: 'quick_match', revision: 0, item: { level: 1, sessions: 1 } } })
    const before = JSON.stringify(server.state)
    const report = await flushOutbox(box, server)
    expect(report).toMatchObject({ sent: 0, dropped: 1, pending: 0 })
    expect(JSON.stringify(server.state)).toBe(before)
  })

  it('keeps sessions queued while offline, then sends them later', async () => {
    const { box, server } = await setup('s-0000001')
    server.failNext = ['get']
    const offline = await flushOutbox(box, server)
    expect(offline.pending).toBe(1); expect(offline.error).toBeInstanceOf(Error); expect(offline.sent).toBe(0)
    expect((await box.list())[0].attempts).toBe(1)
    expect(await flushOutbox(box, server)).toMatchObject({ sent: 1, pending: 0 })
  })

  it('drops a session the server rejects as invalid so it cannot block the queue', async () => {
    const { box, server } = await setup('bad-000001', 'ok-0000002')
    server.failNext = [new GamesHttpError(422, 'bad level')]
    const report = await flushOutbox(box, server)
    expect(report.rejected).toEqual(['bad-000001']); expect(report.sent).toBe(1); expect(report.pending).toBe(0)
  })

  it('stops on a server outage (500) and on auth problems instead of dropping data', async () => {
    for (const status of [500, 401, 404, 429]) {
      const { box, server } = await setup('s-0000001')
      server.failNext = [new GamesHttpError(status, 'x')]
      const report = await flushOutbox(box, server)
      expect(report.pending).toBe(1); expect(report.rejected).toEqual([])
    }
  })

  it('gives up on endless conflicts without losing the session', async () => {
    const { box, server } = await setup('s-0000001')
    server.putState = async () => { throw new GamesHttpError(409, 'always') }
    const report = await flushOutbox(box, server)
    expect(report.pending).toBe(1); expect(report.error).toBeInstanceOf(GamesHttpError)
  })

  it('recordSession queues first, so a crash or offline start never loses the result', async () => {
    const { box, server } = await setup()
    server.failNext = ['get']
    const report = await recordSession(box, server, session('s-0000009'))
    expect(report.pending).toBe(1)
    expect(await box.list()).toHaveLength(1)
  })
})

describe('client and errors', () => {
  it('fills defaults for missing state fields', async () => {
    const request: GamesRequest = (async () => ({ version: 1, user_id: 'u' })) as GamesRequest
    expect(await createGamesClient(request).getState()).toMatchObject({ user_id: 'u', games: {}, days: {}, months: {}, profile: null })
  })
  it('turns the desktop host error string back into a status', () => {
    const error = parseNativeError('Games request failed (409 Conflict): {"detail":"Records changed","current":{"game#x":null}}') as GamesHttpError
    expect(error).toBeInstanceOf(GamesHttpError)
    expect(error.status).toBe(409); expect(error.message).toBe('Records changed')
    expect((error.body as { current: unknown }).current).toEqual({ 'game#x': null })
    expect((parseNativeError('Games request failed (422 Unprocessable Entity): not json') as GamesHttpError).message).toBe('not json')
    const other = new Error('Games authentication timed out')
    expect(parseNativeError(other)).toBe(other)
  })
})
