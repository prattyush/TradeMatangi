import { afterEach, describe, expect, it, vi } from 'vitest'
import { SwingSseDecoder, browserSwingSubscribe } from '../../shared/swingStream'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Swing SSE', () => {
  it('decodes split UTF-8, CRLF, named events, and skips keepalives', () => {
    const delivered: unknown[] = []
    const decoder = new SwingSseDecoder(event => delivered.push(event))
    const bytes = new TextEncoder().encode(': keepalive\r\n\r\nevent: snapshot\r\ndata: {"type":"portfolio_snapshot","label":"₹"}\r\n\r\ndata: {"type":"chart_quotes"}\n\n')
    for (const byte of bytes) decoder.push(Uint8Array.of(byte))
    expect(delivered).toEqual([{ type: 'portfolio_snapshot', label: '₹' }, { type: 'chart_quotes' }])
  })
  it('rejects invalid events for recovery rather than silently losing data', () => {
    const decoder = new SwingSseDecoder(() => undefined)
    expect(() => decoder.push(new TextEncoder().encode('data: []\n\n'))).toThrow('Invalid Swing stream event')
  })
  it('recreates a lost chart watch after backend restart instead of retrying its old identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const events: unknown[] = []
    const stop = browserSwingSubscribe('https://test', () => ({}))('portfolio/charts/watch/old/events', event => events.push(event), () => undefined)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(events).toEqual([{ type: 'chart_watch_expired' }])
    stop()
  })
  it('uses authenticated SSE, reconnects with renewed headers, and aborts on disposal', async () => {
    vi.useFakeTimers()
    let token = 'first'
    const delivered: unknown[] = [], errors: unknown[] = []
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      const attempt = fetchMock.mock.calls.length
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: {"type":"portfolio_snapshot","attempt":${attempt}}\n\n`))
          if (attempt === 1) controller.close()
          else options.signal!.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')))
        },
      }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const stop = browserSwingSubscribe('https://test/api/swing/portfolios', () => ({ Authorization: `Bearer ${token}` }))('owned/events', e => delivered.push(e), e => errors.push(e))
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered).toEqual([{ type: 'portfolio_snapshot', attempt: 1 }])
    expect(errors).toHaveLength(1)
    token = 'renewed'
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer renewed' })
    expect(delivered).toHaveLength(2)
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
    expect(fetchMock.mock.calls[1][1].signal?.aborted).toBe(true)
  })
})
