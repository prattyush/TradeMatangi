/** Identify failures that have no HTTP response, without recording request secrets. */
export async function requestFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request
  const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase()
  const raw = isRequest ? input.url : String(input)
  let target = raw.split('?')[0].split('#')[0]
  try {
    const url = new URL(raw, globalThis.location?.origin ?? 'http://localhost')
    target = url.origin + url.pathname
  } catch { /* Preserve the path when a malformed URL fails before sending. */ }
  try {
    return await globalThis.fetch(input, init)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${method} ${target}: ${reason} (no HTTP response received)`)
  }
}
