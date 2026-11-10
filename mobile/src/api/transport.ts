import { ApiError } from './errors'
import { diagnostics as sharedDiagnostics, type Diagnostics } from './diagnostics'
import { normalizeServerUrl, ServerUrlError } from './serverConfig'
import type { TokenBundle, TokenStore } from './tokenStore'

export type Query = Record<string, string | number | boolean | null | undefined>

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  query?: Query
  body?: unknown
  signal?: AbortSignal
  /** Send the Bearer token (default). Login and refresh turn this off. */
  auth?: boolean
  /** Extra attempts after a network error or 502/503/504. Reads default to 2; writes are never retried. */
  retries?: number
  timeoutMs?: number
}

export interface TransportOptions {
  baseUrl: () => Promise<string> | string
  tokens: TokenStore
  /** Called once when the session cannot be continued (refresh token rejected). */
  onAuthLost?: () => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  diagnostics?: Diagnostics
  allowHttp?: boolean
}

export const isAbort = (error: unknown): boolean =>
  error instanceof DOMException ? error.name === 'AbortError' : (error as { name?: string } | null)?.name === 'AbortError'

const RETRYABLE_STATUS = new Set([502, 503, 504])
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${base}/`)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/** FastAPI sends `{detail: "text"}` or, for validation errors, `{detail: [{msg: "..."}]}`. */
function detailOf(payload: unknown): string | undefined {
  const detail = (payload as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: unknown }
    if (typeof first?.msg === 'string') return first.msg
  }
  return undefined
}

export interface ApiClient {
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>
  get<T = unknown>(path: string, query?: Query, options?: RequestOptions): Promise<T>
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T>
  del<T = unknown>(path: string, options?: RequestOptions): Promise<T>
  /**
   * Open a server-sent-events response with the Bearer token (refreshed once on 401). The caller reads `response.body`
   * and aborts through `signal`; there is no overall timeout, only the wait for the response headers.
   */
  stream(path: string, options?: { query?: Query; signal?: AbortSignal }): Promise<Response>
  /** Exchange the refresh token for a new bundle. Shared: concurrent callers wait for the same refresh. */
  refresh(): Promise<void>
  /** Store a bundle obtained by sign-in. */
  adopt(bundle: TokenBundle): Promise<void>
}

export function createApiClient(options: TransportOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const sleep = options.sleep ?? defaultSleep
  const log = options.diagnostics ?? sharedDiagnostics
  const defaultTimeout = options.timeoutMs ?? 20_000
  let inflightRefresh: Promise<void> | null = null

  async function base(): Promise<string> {
    const configured = await options.baseUrl()
    try { return normalizeServerUrl(configured, { allowHttp: options.allowHttp }) }
    catch (error) { throw new ApiError('config', error instanceof ServerUrlError ? error.message : 'The server address is not valid.') }
  }

  async function send(path: string, request: RequestOptions, token: string | null): Promise<Response> {
    const timeoutMs = request.timeoutMs ?? defaultTimeout
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    const onCallerAbort = () => controller.abort()
    if (request.signal) {
      if (request.signal.aborted) controller.abort()
      else request.signal.addEventListener('abort', onCallerAbort, { once: true })
    }
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (token) headers.Authorization = `Bearer ${token}`
      if (request.body !== undefined) headers['Content-Type'] = 'application/json'
      const url = buildUrl(await base(), path, request.query)
      // The caller may have given up while the base URL was being read.
      if (request.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
      return await fetchImpl(url, {
        method: request.method ?? 'GET',
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
        cache: 'no-store',
      })
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (request.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
      if (timedOut) throw new ApiError('timeout', 'The server took too long to answer.')
      throw new ApiError('network', 'Could not reach the server.')
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  async function parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    try { return JSON.parse(text) as T } catch { return text as unknown as T }
  }

  async function failure(response: Response, path: string): Promise<ApiError> {
    let payload: unknown
    try { payload = await response.clone().json() } catch { payload = undefined }
    log.record(`${response.status} ${path.split('?')[0]}`)
    return new ApiError('http', `The server returned ${response.status}.`, { status: response.status, detail: detailOf(payload) })
  }

  function refresh(): Promise<void> {
    if (!inflightRefresh) {
      inflightRefresh = (async () => {
        const token = options.tokens.refreshToken()
        if (!token) throw await lost('No saved session.')
        const response = await send('/api/auth/desktop/refresh', { method: 'POST', body: { refresh_token: token }, retries: 0 }, null)
        if (response.status === 401 || response.status === 403) throw await lost('The saved session was rejected.')
        if (!response.ok) throw await failure(response, '/api/auth/desktop/refresh')
        await options.tokens.setBundle(await parse<TokenBundle>(response))
      })().finally(() => { inflightRefresh = null })
    }
    return inflightRefresh
  }

  async function lost(reason: string): Promise<ApiError> {
    log.record(`signed out: ${reason}`)
    await options.tokens.clear()
    options.onAuthLost?.()
    return new ApiError('auth', 'You have been signed out.')
  }

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const authenticated = opts.auth !== false
    const method = opts.method ?? 'GET'
    const maxRetries = opts.retries ?? (method === 'GET' ? 2 : 0)

    let token: string | null = null
    if (authenticated) {
      token = options.tokens.accessToken()
      if (!token) {
        if (!options.tokens.hasSession()) throw await lost('Not signed in.')
        await refresh()
        token = options.tokens.accessToken()
        if (!token) throw await lost('Could not obtain an access token.')
      }
    }

    let refreshedAfter401 = false
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await send(path, opts, token)
      } catch (error) {
        if (error instanceof ApiError && (error.kind === 'network' || error.kind === 'timeout') && attempt < maxRetries) {
          await sleep(300 * 2 ** attempt)
          continue
        }
        if (error instanceof ApiError) log.record(`${error.kind} ${method} ${path.split('?')[0]}`)
        throw error
      }
      if (response.ok) return parse<T>(response)
      if (response.status === 401 && authenticated) {
        if (refreshedAfter401) throw await lost('The server rejected the new token.')
        refreshedAfter401 = true
        // Another request may already have refreshed while this one was in flight; then just retry.
        if (options.tokens.accessToken(0) === token || options.tokens.accessToken(0) === null) await refresh()
        token = options.tokens.accessToken()
        if (!token) throw await lost('Could not obtain an access token.')
        attempt--
        continue
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await sleep(300 * 2 ** attempt)
        continue
      }
      throw await failure(response, path)
    }
  }

  async function stream(path: string, opts: { query?: Query; signal?: AbortSignal } = {}): Promise<Response> {
    let token = options.tokens.accessToken()
    if (!token) {
      if (!options.tokens.hasSession()) throw await lost('Not signed in.')
      await refresh()
      token = options.tokens.accessToken()
      if (!token) throw await lost('Could not obtain an access token.')
    }
    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetchImpl(buildUrl(await base(), path, opts.query), {
          method: 'GET', headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }, signal: opts.signal, cache: 'no-store',
        })
      } catch (error) {
        if (error instanceof ApiError) throw error
        if (opts.signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
        log.record(`network GET ${path.split('?')[0]}`)
        throw new ApiError('network', 'Could not reach the server.')
      }
      if (response.status === 401 && attempt === 0) {
        if (options.tokens.accessToken(0) === token || options.tokens.accessToken(0) === null) await refresh()
        token = options.tokens.accessToken()
        if (!token) throw await lost('Could not obtain an access token.')
        continue
      }
      if (!response.ok || !response.body) throw await failure(response, path)
      return response
    }
  }

  return {
    request,
    stream,
    get: (path, query, extra) => request(path, { ...extra, method: 'GET', query }),
    post: (path, body, extra) => request(path, { ...extra, method: 'POST', body }),
    put: (path, body, extra) => request(path, { ...extra, method: 'PUT', body }),
    del: (path, extra) => request(path, { ...extra, method: 'DELETE' }),
    refresh,
    adopt: bundle => options.tokens.setBundle(bundle),
  }
}
