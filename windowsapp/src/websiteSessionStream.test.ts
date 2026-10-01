import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionStream } from '../../frontend/src/services/sessionStream'

function fixture(probe = vi.fn<() => Promise<unknown>>().mockResolvedValue({ state: 'running' })) {
  const sources: Array<{ onopen: (() => void) | null; onerror: (() => void) | null; onmessage: ((event: unknown) => void) | null; close: ReturnType<typeof vi.fn> }> = []
  const options = {
    sessionId: 'paper', url: vi.fn((cursor: string | null) => `stream?cursor=${cursor}`), probe,
    onMessage: vi.fn(), onReconnect: vi.fn(), onUnavailable: vi.fn(),
    createSource: () => {
      const source = { onopen: null, onerror: null, onmessage: null, close: vi.fn() }
      sources.push(source)
      return source as unknown as EventSource
    },
  }
  const stream = new SessionStream(options)
  stream.connect()
  return { stream, sources, options }
}

afterEach(() => vi.useRealTimers())

describe('website session SSE recovery', () => {
  for (const status of [404, 410]) {
    it(`stops retrying a session confirmed unavailable with ${status}`, async () => {
      vi.useFakeTimers()
      const f = fixture(vi.fn().mockRejectedValue({ status }))
      f.sources[0].onerror?.()
      await vi.runAllTimersAsync()
      expect(f.options.onUnavailable).toHaveBeenCalledTimes(1)
      f.stream.connect(true)
      expect(f.sources).toHaveLength(1)
      f.stream.close()
    })
  }

  it('keeps retrying a reachable session after a transport failure', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.sources[0].onopen?.()
    f.sources[0].onerror?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sources).toHaveLength(2)
    f.sources[1].onopen?.()
    expect(f.options.onReconnect).toHaveBeenCalledTimes(1)
    expect(f.options.onUnavailable).not.toHaveBeenCalled()
    f.stream.close()
  })

  it('retries network and server failures without marking a session ended', async () => {
    vi.useFakeTimers()
    const f = fixture(vi.fn().mockRejectedValue({ status: 503 }))
    f.sources[0].onerror?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sources).toHaveLength(2)
    expect(f.options.onUnavailable).not.toHaveBeenCalled()
    f.stream.close()
  })

  it('ignores a missing-session probe that resolves after cleanup', async () => {
    let reject!: (error: unknown) => void
    const f = fixture(vi.fn(() => new Promise((_, fail) => { reject = fail })))
    f.sources[0].onerror?.()
    f.stream.close()
    reject({ status: 404 })
    await Promise.resolve(); await Promise.resolve()
    expect(f.options.onUnavailable).not.toHaveBeenCalled()
    expect(f.sources).toHaveLength(1)
  })

  it('fences a probe from a replaced connection', async () => {
    let reject!: (error: unknown) => void
    const f = fixture(vi.fn(() => new Promise((_, fail) => { reject = fail })))
    f.sources[0].onerror?.()
    f.stream.connect(true)
    reject({ status: 410 })
    await Promise.resolve(); await Promise.resolve()
    expect(f.options.onUnavailable).not.toHaveBeenCalled()
    expect(f.sources).toHaveLength(2)
    f.stream.close()
  })

  it('retains the replay cursor and identifies inactive group events', () => {
    const f = fixture()
    f.sources[0].onmessage?.({ data: JSON.stringify({ type: 'tick' }), lastEventId: '15' })
    expect(f.options.onMessage).toHaveBeenCalledWith({ type: 'tick', session_id: 'paper' })
    f.stream.connect(true)
    expect(f.options.url).toHaveBeenLastCalledWith('15')
    f.stream.close()
  })

  it('ends a connection on session_ended and ignores late callbacks', () => {
    const f = fixture()
    f.sources[0].onmessage?.({ data: JSON.stringify({ type: 'session_ended' }), lastEventId: '5' })
    f.sources[0].onerror?.()
    f.stream.connect(true)
    expect(f.options.probe).not.toHaveBeenCalled()
    expect(f.sources).toHaveLength(1)
    f.stream.close()
  })

  it('cancels an already scheduled retry on cleanup', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.sources[0].onerror?.()
    await vi.advanceTimersByTimeAsync(0)
    f.stream.close()
    await vi.runAllTimersAsync()
    expect(f.sources).toHaveLength(1)
  })
})
