import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/errors'
import type { ApiClient, RequestOptions } from '../../api/transport'
import { createSwingApi, followPortfolio, SWING_BASE, type PortfolioEvent } from './swingApi'
import { describeSwingError, isUncertainWrite } from './swingErrors'

function fakeClient(answer: unknown = {}) {
  const calls: Array<{ path: string; options?: RequestOptions; query?: unknown }> = []
  const client = {
    request: async (path: string, options?: RequestOptions) => { calls.push({ path, options }); return answer },
    get: async (path: string, query?: unknown, options?: RequestOptions) => { calls.push({ path, query, options: { ...options, method: 'GET' } }); return answer },
  } as unknown as ApiClient
  return { client, calls }
}

describe('swing api', () => {
  it('writes use POST or PATCH, never retry, and wait long enough for a broker', async () => {
    const { client, calls } = fakeClient()
    const api = createSwingApi(client)
    await api.placeOrder('p1', { symbol: 'X' })
    await api.amendOrder('p1', 'o1', { price: 10 })
    await api.cancelOrder('p1', 'o1')
    await api.pause('p1', true)
    await api.close('p1', { acknowledge_delivery_context_ids: [], acknowledge_undated_submission_ids: [] })
    expect(calls.map(call => [call.options?.method, call.path])).toEqual([
      ['POST', `${SWING_BASE}/p1/orders`], ['PATCH', `${SWING_BASE}/p1/orders/o1`], ['POST', `${SWING_BASE}/p1/orders/o1/cancel`],
      ['POST', `${SWING_BASE}/p1/pause`], ['POST', `${SWING_BASE}/p1/close`],
    ])
    expect(calls.every(call => call.options?.retries === 0 && (call.options?.timeoutMs ?? 0) >= 30_000)).toBe(true)
    expect(calls[3].options?.body).toEqual({ paused: true })
  })

  it('reads the active portfolio of the chosen mode, sending the broker only for real', async () => {
    const { client, calls } = fakeClient({ portfolio: null })
    const api = createSwingApi(client)
    await api.active('paper', 'kite')
    await api.active('real', 'kotak')
    expect(calls[0].query).toEqual({ mode: 'paper', execution_broker: undefined })
    expect(calls[1].query).toEqual({ mode: 'real', execution_broker: 'kotak' })
  })

  it('lists futures and option contracts from their own routes', async () => {
    const { client, calls } = fakeClient({ contracts: [] })
    const api = createSwingApi(client)
    await api.contracts('RELIND', 'futures', 'kotak')
    await api.contracts('RELIND', 'options', 'kotak')
    expect(calls[0]).toMatchObject({ path: `${SWING_BASE}/contracts/futures`, query: { symbol: 'RELIND', provider: 'kotak' } })
    expect(calls[1]).toMatchObject({ path: `${SWING_BASE}/contracts/metadata`, query: { symbol: 'RELIND' } })
  })
})

describe('error wording', () => {
  const http = (status: number, detail?: string) => new ApiError('http', 'x', { status, detail })
  it('no answer and broker problems say the order may exist and that sending it again is safe', () => {
    expect(isUncertainWrite(new ApiError('timeout', 'x'))).toBe(true)
    expect(isUncertainWrite(new ApiError('network', 'x'))).toBe(true)
    expect(isUncertainWrite(http(502))).toBe(true)
    expect(isUncertainWrite(http(402))).toBe(false)
    expect(describeSwingError(http(502))).toMatch(/may or may not be placed/)
    expect(describeSwingError(http(502))).toMatch(/cannot be placed twice/)
    expect(describeSwingError(new ApiError('timeout', 'x'))).toMatch(/cannot be placed twice/)
  })
  it('funds, pause and conflict are plain', () => {
    expect(describeSwingError(http(402, 'Insufficient wallet balance'))).toBe('Not enough funds. Insufficient wallet balance')
    expect(describeSwingError(http(403, 'Entries are paused'))).toBe('Entries are paused')
    expect(describeSwingError(http(409, 'restoration in progress; retry shortly'))).toMatch(/still restoring/)
    expect(describeSwingError(http(409, 'Capital changed'))).toBe('Capital changed Refresh and try again.')
  })
})

describe('followPortfolio', () => {
  const frame = (event: object) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
  function streamOf(chunks: Uint8Array[]) {
    let sent = 0
    return { body: { getReader: () => ({ read: async () => (sent < chunks.length ? { done: false, value: chunks[sent++] } : { done: true, value: undefined }), cancel: async () => undefined }) } } as unknown as Response
  }

  it('turns snapshot, refresh and error events into callbacks and ignores another portfolio', async () => {
    const controller = new AbortController()
    const events: PortfolioEvent[] = []
    let opened = 0
    const client = {
      stream: async () => {
        opened++
        if (opened > 1) { controller.abort(); throw new Error('stop') }
        return streamOf([
          frame({ type: 'portfolio_snapshot', portfolio: { session_id: 'p1' }, pnl: 5 }),
          frame({ type: 'portfolio_snapshot', portfolio: { session_id: 'other' } }),
          frame({ type: 'portfolio_refresh_required' }),
          frame({ type: 'portfolio_error', message: 'feed down' }),
        ])
      },
    } as unknown as ApiClient
    await followPortfolio(client, 'p1', event => events.push(event), controller.signal)
    expect(events.map(event => event.kind)).toEqual(['snapshot', 'refresh', 'error'])
    expect(events[2]).toEqual({ kind: 'error', message: 'feed down' })
    expect(opened).toBeGreaterThan(0)
  })
})
