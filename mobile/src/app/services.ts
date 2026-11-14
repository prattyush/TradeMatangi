import { createApiClient, type ApiClient } from '../api/transport'
import { createAuthService, type AuthService } from '../api/auth'
import { createServerConfig, allowsInsecureHttp, type ServerConfig } from '../api/serverConfig'
import { createPreferencesStore, createSecureStore, type KeyValueStore } from '../api/storage'
import { createTokenStore, type TokenStore } from '../api/tokenStore'
import { diagnostics, type Diagnostics } from '../api/diagnostics'
import { createGoogleSignIn, type GoogleSignInClient } from '../native/googleSignIn'
import { createAppLock, type AppLockClient } from '../native/appLock'

/** Everything the screens share. Built once at start-up; tests build their own with in-memory stores. */
export interface AppServices {
  prefs: KeyValueStore
  serverConfig: ServerConfig
  tokens: TokenStore
  client: ApiClient
  auth: AuthService
  diagnostics: Diagnostics
  google: GoogleSignInClient
  appLock: AppLockClient
  /** Subscribe to "the session cannot continue" (refresh token rejected). Returns an unsubscribe function. */
  onAuthLost(listener: () => void): () => void
}

export function createServices(overrides: { prefs?: KeyValueStore; secure?: KeyValueStore; fetchImpl?: typeof fetch; google?: GoogleSignInClient; appLock?: AppLockClient } = {}): AppServices {
  const prefs = overrides.prefs ?? createPreferencesStore()
  const secure = overrides.secure ?? createSecureStore()
  const serverConfig = createServerConfig(prefs)
  const tokens = createTokenStore(secure)
  const listeners = new Set<() => void>()
  const client = createApiClient({
    baseUrl: () => serverConfig.get(),
    tokens,
    fetchImpl: overrides.fetchImpl,
    allowHttp: allowsInsecureHttp(),
    diagnostics,
    onAuthLost: () => listeners.forEach(listener => listener()),
  })
  return {
    prefs, serverConfig, tokens, client, diagnostics,
    google: overrides.google ?? createGoogleSignIn(),
    appLock: overrides.appLock ?? createAppLock(),
    auth: createAuthService({ client, tokens, prefs }),
    onAuthLost: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
