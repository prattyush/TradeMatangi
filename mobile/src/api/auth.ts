import { ApiError } from './errors'
import type { ApiClient } from './transport'
import type { TokenBundle, TokenStore } from './tokenStore'
import type { KeyValueStore } from './storage'

const ACCOUNT_KEY = 'tm.account_label'
export const DEVICE_NAME = 'Android phone app'

export type SessionState = 'signedIn' | 'signedOut'

export class SignInError extends Error {}

/** A Google account the server does not know yet: it needs a name for the new account (the website asks the same). */
export class AccountNameRequired extends Error {
  constructor() { super('Choose a name for your new account.') }
}

export interface AuthService {
  /** Load the saved session. No network: the first request refreshes the access token. */
  restore(): Promise<SessionState>
  signInWithPassword(email: string, password: string): Promise<void>
  /**
   * Sign in with a Google ID token from the native Google sign-in. A Google account the server has not seen needs
   * `accountName`; without it this throws `AccountNameRequired` (the server answers 401 for both "bad token" and
   * "new account", so the first 401 without a name is read as the second; a 401 with a name is a rejected token).
   * `label` is the text shown for the account (the Google email).
   */
  signInWithGoogle(idToken: string, accountName?: string, label?: string): Promise<void>
  signOut(): Promise<void>
  /** Short text for the signed-in account (the email used to sign in), or null. */
  accountLabel(): Promise<string | null>
}

export function createAuthService(deps: { client: ApiClient; tokens: TokenStore; prefs: KeyValueStore }): AuthService {
  const { client, tokens, prefs } = deps

  async function adoptBundle(request: () => Promise<TokenBundle>, label: string | null, rejected?: (error: ApiError) => Error): Promise<void> {
    let bundle: TokenBundle
    try {
      bundle = await request()
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'http' && error.status === 401) {
        if (rejected) throw rejected(error)
        throw new SignInError(error.detail && error.detail !== 'Not authenticated' ? error.detail : 'Invalid email or password.')
      }
      if (error instanceof ApiError && error.kind === 'http' && error.status === 422) throw new SignInError('Enter your email and password.')
      throw error
    }
    await client.adopt(bundle)
    if (label) await prefs.set(ACCOUNT_KEY, label)
  }

  return {
    async restore() {
      await tokens.load()
      return tokens.hasSession() ? 'signedIn' : 'signedOut'
    },
    signInWithPassword(email, password) {
      const trimmed = email.trim()
      if (!trimmed || !password) return Promise.reject(new SignInError('Enter your email and password.'))
      return adoptBundle(
        () => client.post<TokenBundle>('/api/auth/desktop/token', { email: trimmed, password, device_name: DEVICE_NAME }, { auth: false, retries: 0 }),
        trimmed,
      )
    },
    signInWithGoogle(idToken, accountName, label) {
      const name = accountName?.trim()
      if (accountName !== undefined && !name) return Promise.reject(new SignInError('Enter a name for your account.'))
      return adoptBundle(
        () => client.post<TokenBundle>('/api/auth/desktop/google-token',
          { id_token: idToken, account_name: name, device_name: DEVICE_NAME }, { auth: false, retries: 0 }),
        label ?? null,
        () => name
          ? new SignInError('The server did not accept this Google sign-in. Try again; if it keeps failing, use your email and password.')
          : new AccountNameRequired(),
      )
    },
    async signOut() {
      const refreshToken = tokens.refreshToken()
      if (refreshToken) {
        // Best effort: if the server is unreachable the local sign-out must still happen.
        try { await client.post('/api/auth/desktop/logout', { refresh_token: refreshToken }, { auth: false, retries: 0, timeoutMs: 5000 }) } catch { /* signed out locally */ }
      }
      await tokens.clear()
      await prefs.remove(ACCOUNT_KEY)
    },
    accountLabel: () => prefs.get(ACCOUNT_KEY),
  }
}
