import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './transport'
import { ApiError } from './errors'
import { createMemoryStore } from './storage'
import { createTokenStore, type TokenBundle } from './tokenStore'
import { createDiagnostics } from './diagnostics'

const bundle = (n: number, expiresIn = 3600): TokenBundle => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: 'Bearer', expires_in: expiresIn })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

async function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>, initial?: TokenBundle) {
  const secure = createMemoryStore()
  let clock = 1_000_000
  const tokens = createTokenStore(secure, () => clock)
  if (initial) await tokens.setBundle(initial)
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(String(url), init ?? {})
  }) as unknown as typeof fetch
  const onAuthLost = vi.fn()
  const diag = createDiagnostics(20)
  const client = createApiClient({
    baseUrl: () => 'https://server.example', tokens, fetchImpl, onAuthLost, sleep: async () => {}, diagnostics: diag, allowHttp: false,
  })
  return { client, tokens, calls, onAuthLost, diag, secure, advance: (ms: number) => { clock += ms } }
}
const authHeader = (init: RequestInit) => (init.headers as Record<string, string>).Authorization

describe('api client', () => {
  it('sends the Bearer token and a query string without empty values', async () => {
    const { client, calls } = await setup(() => json({ ok: true }), bundle(1))
    await client.get('/api/x', { a: 1, b: undefined, c: '', d: 'y' })
    expect(calls[0].url).toBe('https://server.example/api/x?a=1&d=y')
    expect(authHeader(calls[0].init)).toBe('Bearer access-1')
  })

  it('refreshes once and retries once after a 401', async () => {
    let first = true
    const { client, calls, tokens } = await setup((url, init) => {
      if (url.endsWith('/api/auth/desktop/refresh')) return json(bundle(2))
      if (first) { first = false; return json({ detail: 'expired' }, 401) }
      return json({ done: authHeader(init) })
    }, bundle(1))
    const result = await client.get<{ done: string }>('/api/data')
    expect(result.done).toBe('Bearer access-2')
    expect(calls.map(c => c.url.split('server.example')[1])).toEqual(['/api/data', '/api/auth/desktop/refresh', '/api/data'])
    expect(tokens.refreshToken()).toBe('refresh-2')
  })

  it('shares one refresh between concurrent requests', async () => {
    let refreshes = 0
    const { client, tokens, advance } = await setup((url) => {
      if (url.endsWith('/refresh')) { refreshes++; return json(bundle(2)) }
      return json({ ok: true })
    }, bundle(1, 30))
    advance(1_000_000) // access token is now expired; the refresh token is still saved
    expect(tokens.accessToken()).toBeNull()
    await Promise.all([client.get('/a'), client.get('/b'), client.get('/c')])
    expect(refreshes).toBe(1)
  })

  it('does not refresh again when another request already did', async () => {
    let refreshes = 0
    const gate: { release?: () => void } = {}
    const hold = new Promise<void>(resolve => { gate.release = resolve })
    const { client } = await setup(async (url, init) => {
      if (url.endsWith('/refresh')) { refreshes++; return json(bundle(2)) }
      if (authHeader(init) === 'Bearer access-1') { await hold; return json({ detail: 'expired' }, 401) }
      return json({ ok: true })
    }, bundle(1))
    const slow = client.get('/slow')
    const other = client.refresh()
    await other
    gate.release?.()
    await slow
    expect(refreshes).toBe(1)
  })

  it('signs out when the refresh token is rejected, and clears it', async () => {
    const { client, onAuthLost, tokens, secure } = await setup((url) =>
      url.endsWith('/refresh') ? json({ detail: 'bad' }, 401) : json({ detail: 'expired' }, 401), bundle(1))
    await expect(client.get('/api/data')).rejects.toMatchObject({ kind: 'auth' })
    expect(onAuthLost).toHaveBeenCalledTimes(1)
    expect(tokens.hasSession()).toBe(false)
    expect(await secure.get('tm.refresh_token')).toBeNull()
  })

  it('keeps the session when the refresh fails only because the network is down', async () => {
    const { client, onAuthLost, tokens } = await setup((url) => {
      if (url.endsWith('/refresh')) throw new TypeError('network down')
      return json({ detail: 'expired' }, 401)
    }, bundle(1))
    await expect(client.get('/api/data', undefined, { retries: 0 })).rejects.toMatchObject({ kind: 'network' })
    expect(onAuthLost).not.toHaveBeenCalled()
    expect(tokens.hasSession()).toBe(true)
  })

  it('gives up after a second 401 instead of looping', async () => {
    let calls = 0
    const { client } = await setup((url) => {
      if (url.endsWith('/refresh')) return json(bundle(2))
      calls++
      return json({ detail: 'nope' }, 401)
    }, bundle(1))
    await expect(client.get('/api/data')).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toBe(2)
  })

  it('retries reads on network errors but never retries writes', async () => {
    let reads = 0
    const read = await setup(() => { reads++; if (reads < 3) throw new TypeError('down'); return json({ ok: 1 }) }, bundle(1))
    await expect(read.client.get('/r')).resolves.toEqual({ ok: 1 })
    expect(reads).toBe(3)
    let writes = 0
    const write = await setup(() => { writes++; throw new TypeError('down') }, bundle(1))
    await expect(write.client.post('/w', { a: 1 })).rejects.toMatchObject({ kind: 'network' })
    expect(writes).toBe(1)
  })

  it('retries a 503 read and then succeeds, but returns other errors with the server detail', async () => {
    let n = 0
    const a = await setup(() => (++n === 1 ? json({ detail: 'busy' }, 503) : json({ ok: true })), bundle(1))
    await expect(a.client.get('/r')).resolves.toEqual({ ok: true })
    const b = await setup(() => json({ detail: 'Session not found' }, 404), bundle(1))
    await expect(b.client.get('/r')).rejects.toMatchObject({ kind: 'http', status: 404, detail: 'Session not found' })
  })

  it('reads FastAPI validation errors', async () => {
    const { client } = await setup(() => json({ detail: [{ msg: 'field required' }] }, 422), bundle(1))
    await expect(client.get('/r')).rejects.toMatchObject({ detail: 'field required' })
  })

  it('times out and reports it as a timeout', async () => {
    const { client } = await setup((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }), bundle(1))
    await expect(client.get('/slow', undefined, { timeoutMs: 20, retries: 0 })).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('rethrows a caller abort as an AbortError, not an API error', async () => {
    const controller = new AbortController()
    const { client } = await setup((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }), bundle(1))
    const pending = client.get('/slow', undefined, { signal: controller.signal, retries: 0 })
    controller.abort()
    await expect(pending).rejects.toSatisfy((e: unknown) => !(e instanceof ApiError) && (e as Error).name === 'AbortError')
  })

  it('refuses to talk to a plain-http server in a release build', async () => {
    const client = createApiClient({ baseUrl: () => 'http://server.example', tokens: createTokenStore(createMemoryStore()), allowHttp: false, fetchImpl: vi.fn() as unknown as typeof fetch })
    await expect(client.get('/x', undefined, { auth: false })).rejects.toMatchObject({ kind: 'config' })
  })

  it('is signed out when there is no session at all', async () => {
    const { client, onAuthLost } = await setup(() => json({}))
    await expect(client.get('/api/data')).rejects.toMatchObject({ kind: 'auth' })
    expect(onAuthLost).toHaveBeenCalled()
  })

  it('never writes a token into the diagnostics', async () => {
    const { client, diag } = await setup(() => json({ detail: 'boom Bearer access-1 token=abc' }, 500), bundle(1))
    await expect(client.get('/r?token=abc', undefined, { retries: 0 })).rejects.toBeInstanceOf(ApiError)
    const text = JSON.stringify(diag.entries())
    expect(text).not.toContain('access-1')
    expect(text).not.toContain('refresh-1')
  })
})
