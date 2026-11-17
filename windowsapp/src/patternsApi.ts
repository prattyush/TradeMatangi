export type PatternsMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'
export type PatternsRequest = <T>(path: string, method: PatternsMethod, body?: unknown, signal?: AbortSignal) => Promise<T>

const ID = '[A-Za-z0-9_-]+'
const SYMBOL = '[A-Za-z0-9_&-]+'
const DATE = '[0-9-]{10}'

/** Mirror of `valid_patterns_path` in src-tauri/src/lib.rs. Keep the two in step (parity test in patternsApi.test.ts). */
const ALLOWED: Record<PatternsMethod, RegExp> = {
  GET: new RegExp(`^(pattern/(strategies|categories|charts|chart/by-date|chart/${ID}|ohlc/(equity|options)|traded|traded/summary)|chart-structures/(types|structures|structure/${ID}|ohlc/${SYMBOL}/${DATE})|fine-structures/(definitions|flows|flow/${ID}|(ohlc|ohlc-options)/${SYMBOL}/${DATE})|deep-dive/(dives|dive|stats|stats/all|practice/(strategies|runs|evaluate))|data/(symbols|price-at|expiry|options/find-strike-by-price))$`),
  POST: new RegExp('^(pattern/(strategies|categories|chart|charts|charts/bulk-delete|traded/save)|chart-structures/structure|fine-structures/(definition|flow|search)|deep-dive/(tags|setup/save-to-patterns|practice/pick)|deep-dive/tags/[A-Za-z0-9_-]+/(update|archive|restore))$'),
  PUT: new RegExp(`^(pattern/chart/${ID}|chart-structures/structure/${ID}|fine-structures/(definition|flow)/${ID}|deep-dive/setup|deep-dive/setup/tag-values)$`),
  DELETE: new RegExp(`^(pattern/chart/${ID}|chart-structures/structure/${ID}|fine-structures/(definition|flow)/${ID}|deep-dive/setup)$`),
}

export function validPatternsPath(path: string, method: string): boolean {
  const route = path.split('?')[0]
  if (!route || route.startsWith('/') || route.includes('%') || route.includes('#') || route.includes('\\') || route.split('/').some(p => p === '.' || p === '..')) return false
  const pattern = (ALLOWED as Record<string, RegExp | undefined>)[method]
  return pattern ? pattern.test(route) : false
}

type Native = (command: string, args: Record<string, unknown>) => Promise<unknown>

/** Requests go through the native command (bearer held by the Rust host). `native` is injectable for tests. */
export function patternsRequest(baseUrl: string, native: Native): PatternsRequest {
  return async <T,>(path: string, method: PatternsMethod, body: unknown = null, signal?: AbortSignal) => {
    if (!validPatternsPath(path, method)) throw new Error('Invalid patterns request')
    if (signal?.aborted) throw new DOMException('Patterns request cancelled', 'AbortError')
    const call = native('desktop_patterns_request', { baseUrl, path, method, body }) as Promise<T>
    if (!signal) return call
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('Patterns request cancelled', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      call.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}
