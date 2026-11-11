import { describe, expect, it } from 'vitest'
import { AccountNameRequired, createAuthService, SignInError } from './auth'
import { createApiClient } from './transport'
import { createMemoryStore } from './storage'
import { createTokenStore } from './tokenStore'
import { createDiagnostics } from './diagnostics'
import { probeCapabilities, summarizeCapabilities } from './capabilities'

const json = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const bundle = { access_token: 'a1', refresh_token: 'r1', token_type: 'Bearer', expires_in: 3600 }

function setup(handler: (url: string, init: RequestInit) => Response) {
  const secure = createMemoryStore()
  const prefs = createMemoryStore()
  const tokens = createTokenStore(secure)
  const calls: Array<{ url: string; body: unknown }> = []
  const client = createApiClient({
    baseUrl: () => 'https://server.example', tokens, allowHttp: false, sleep: async () => {}, diagnostics: createDiagnostics(),
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url).replace('https://server.example', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return handler(String(url), init ?? {})
    }) as typeof fetch,
  })
  return { auth: createAuthService({ client, tokens, prefs }), client, tokens, secure, prefs, calls }
}

describe('auth service', () => {
  it('signs in with a password, keeps the refresh token and remembers the email', async () => {
    const { auth, tokens, secure, calls } = setup(() => json(bundle))
    await auth.signInWithPassword('  me@example.com ', 'pw')
    expect(calls[0]).toEqual({ url: '/api/auth/desktop/token', body: { email: 'me@example.com', password: 'pw', device_name: 'Android phone app' } })
    expect(tokens.accessToken()).toBe('a1')
    expect(await secure.get('tm.refresh_token')).toBe('r1')
    expect(await auth.accountLabel()).toBe('me@example.com')
  })

  it('turns a wrong password into a plain message and stores nothing', async () => {
    const { auth, tokens } = setup(() => json({ detail: 'Invalid email or password' }, 401))
    await expect(auth.signInWithPassword('a@b.c', 'bad')).rejects.toThrow(SignInError)
    expect(tokens.hasSession()).toBe(false)
  })

  it('does not call the server for an empty form', async () => {
    const { auth, calls } = setup(() => json(bundle))
    await expect(auth.signInWithPassword('', '')).rejects.toThrow(/Enter your email/)
    expect(calls).toHaveLength(0)
  })

  it('signs in with a Google ID token', async () => {
    const { auth, calls, tokens } = setup(() => json(bundle))
    await auth.signInWithGoogle('google-id-token', 'Pratt')
    expect(calls[0]).toEqual({ url: '/api/auth/desktop/google-token', body: { id_token: 'google-id-token', account_name: 'Pratt', device_name: 'Android phone app' } })
    expect(tokens.hasSession()).toBe(true)
  })

  it('remembers the Google email as the account label', async () => {
    const { auth } = setup(() => json(bundle))
    await auth.signInWithGoogle('google-id-token', undefined, 'me@gmail.com')
    expect(await auth.accountLabel()).toBe('me@gmail.com')
  })

  it('asks for an account name when the server does not know the Google account, then signs in with it', async () => {
    let known = false
    const { auth, calls, tokens } = setup((_url, init) => {
      const body = JSON.parse(String(init.body))
      if (!known && !body.account_name) return json({ detail: 'Invalid Google token or account_name required' }, 401)
      return json(bundle)
    })
    await expect(auth.signInWithGoogle('google-id-token')).rejects.toBeInstanceOf(AccountNameRequired)
    expect(tokens.hasSession()).toBe(false)
    await auth.signInWithGoogle('google-id-token', '  Pratt ')
    expect(calls[1].body).toEqual({ id_token: 'google-id-token', account_name: 'Pratt', device_name: 'Android phone app' })
    expect(tokens.hasSession()).toBe(true)
  })

  it('reports a rejected Google token once a name was supplied, and refuses a blank name without calling the server', async () => {
    const { auth, calls } = setup(() => json({ detail: 'Invalid Google token or account_name required' }, 401))
    await expect(auth.signInWithGoogle('t', 'Pratt')).rejects.toThrow(/did not accept/)
    const before = calls.length
    await expect(auth.signInWithGoogle('t', '   ')).rejects.toThrow(/Enter a name/)
    expect(calls).toHaveLength(before)
  })

  it('restores a saved session without calling the network', async () => {
    const { auth, calls, secure } = setup(() => json(bundle))
    await secure.set('tm.refresh_token', 'saved')
    expect(await auth.restore()).toBe('signedIn')
    expect(calls).toHaveLength(0)
  })

  it('signs out locally even when the server cannot be reached', async () => {
    const { auth, tokens, secure, prefs } = setup(() => { throw new TypeError('down') })
    await secure.set('tm.refresh_token', 'saved'); await prefs.set('tm.account_label', 'me@example.com')
    await auth.restore()
    await auth.signOut()
    expect(tokens.hasSession()).toBe(false)
    expect(await secure.get('tm.refresh_token')).toBeNull()
    expect(await auth.accountLabel()).toBeNull()
  })

  it('revokes the refresh token on the server when signing out', async () => {
    const { auth, calls, secure } = setup(() => json(null, 204))
    await secure.set('tm.refresh_token', 'saved')
    await auth.restore()
    await auth.signOut()
    expect(calls[0]).toEqual({ url: '/api/auth/desktop/logout', body: { refresh_token: 'saved' } })
  })
})

describe('capability probe', () => {
  it('reads an up-to-date server', async () => {
    const { client } = setup((url) => url.endsWith('/capabilities') ? json({ api_version: 'v1', features: ['a'], trading_capabilities: ['trade-labels'] }) : json(bundle))
    await client.adopt(bundle)
    const caps = await probeCapabilities(client)
    expect(caps).toMatchObject({ status: 'ok', apiVersion: 'v1', features: ['a'], tradingCapabilities: ['trade-labels'] })
    expect(summarizeCapabilities(caps)).toMatch(/API v1/)
  })
  it('marks an older server and an offline server without throwing', async () => {
    const old = setup(() => json({ detail: 'Not Found' }, 404)); await old.client.adopt(bundle)
    expect((await probeCapabilities(old.client)).status).toBe('old')
    const offline = setup(() => { throw new TypeError('down') }); await offline.client.adopt(bundle)
    expect((await probeCapabilities(offline.client)).status).toBe('unreachable')
    const forbidden = setup(() => json({ detail: 'no' }, 403)); await forbidden.client.adopt(bundle)
    expect((await probeCapabilities(forbidden.client)).status).toBe('forbidden')
  })
  it('lets unexpected errors surface', async () => {
    const broken = setup(() => json({ detail: 'boom' }, 500)); await broken.client.adopt(bundle)
    await expect(probeCapabilities(broken.client)).rejects.toMatchObject({ status: 500 })
  })
})

