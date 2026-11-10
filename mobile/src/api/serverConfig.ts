import { createPreferencesStore, type KeyValueStore } from './storage'

const SERVER_KEY = 'tm.server_url'

/** Production server baked in at build time (VITE_API_BASE_URL), used until the user picks another. */
export const BUILD_SERVER_URL = 'https://tradematangi.co.in'

/** Debug builds may use a plain-http dev server; release builds never do. */
export const allowsInsecureHttp = (): boolean =>
  Boolean(import.meta.env.DEV) || import.meta.env.VITE_ALLOW_HTTP === '1'

export function defaultServerUrl(): string {
  const configured = String(import.meta.env.VITE_API_BASE_URL ?? '').trim()
  return configured ? normalizeServerUrl(configured, { allowHttp: true }) : BUILD_SERVER_URL
}

export class ServerUrlError extends Error {}

/**
 * Turn what the user typed into a base URL. "tradematangi.co.in" becomes https://tradematangi.co.in; a trailing
 * slash or path is dropped. http is refused unless the build allows it, and credentials or query strings are never kept.
 */
export function normalizeServerUrl(input: string, options: { allowHttp?: boolean } = {}): string {
  const text = input.trim()
  if (!text) throw new ServerUrlError('Enter the server address.')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  let url: URL
  try { url = new URL(withScheme) } catch { throw new ServerUrlError('That is not a valid server address.') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ServerUrlError('The server address must start with https://')
  if (url.protocol === 'http:' && !(options.allowHttp ?? allowsInsecureHttp()))
    throw new ServerUrlError('Use an https:// address. Plain http is not allowed in this app.')
  if (!url.hostname) throw new ServerUrlError('That is not a valid server address.')
  if (url.username || url.password) throw new ServerUrlError('Do not put a user name or password in the server address.')
  return url.origin
}

export interface ServerConfig {
  get(): Promise<string>
  set(input: string): Promise<string>
  reset(): Promise<string>
}

export function createServerConfig(store: KeyValueStore = createPreferencesStore()): ServerConfig {
  return {
    async get() {
      const saved = await store.get(SERVER_KEY)
      if (saved) {
        try { return normalizeServerUrl(saved) } catch { /* a saved value that is no longer allowed falls back to the default */ }
      }
      return defaultServerUrl()
    },
    async set(input) {
      const url = normalizeServerUrl(input)
      await store.set(SERVER_KEY, url)
      return url
    },
    async reset() {
      await store.remove(SERVER_KEY)
      return defaultServerUrl()
    },
  }
}
