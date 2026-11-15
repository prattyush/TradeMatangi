import type { KeyValueStore } from './storage'

const REFRESH_KEY = 'tm.refresh_token'

/** Shape of `/api/auth/desktop/token` and `/api/auth/desktop/refresh` responses. */
export interface TokenBundle {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
}

/**
 * Where sign-in tokens live. The refresh token is the long-lived secret and goes to secure storage (Android Keystore);
 * the short-lived access token only ever exists in memory. Nothing here is logged.
 */
export interface TokenStore {
  /** Read the saved refresh token. Call once at start-up. */
  load(): Promise<void>
  /** True when there is a refresh token, so a session can be resumed. */
  hasSession(): boolean
  /** The access token, or null when there is none or it is within `skewMs` of expiring. */
  accessToken(skewMs?: number): string | null
  refreshToken(): string | null
  setBundle(bundle: TokenBundle): Promise<void>
  clear(): Promise<void>
}

export function createTokenStore(secure: KeyValueStore, now: () => number = Date.now): TokenStore {
  let access: string | null = null
  let expiresAt = 0
  let refresh: string | null = null
  return {
    async load() { refresh = await secure.get(REFRESH_KEY) },
    hasSession: () => refresh !== null,
    accessToken(skewMs = 60_000) {
      return access !== null && now() + skewMs < expiresAt ? access : null
    },
    refreshToken: () => refresh,
    async setBundle(bundle) {
      access = bundle.access_token
      expiresAt = now() + Math.max(0, bundle.expires_in) * 1000
      refresh = bundle.refresh_token
      // The refresh token rotates on every use, so the new one must replace the old one.
      await secure.set(REFRESH_KEY, bundle.refresh_token)
    },
    async clear() {
      access = null
      expiresAt = 0
      refresh = null
      await secure.remove(REFRESH_KEY)
    },
  }
}
