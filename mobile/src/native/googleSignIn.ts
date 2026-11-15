import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * The server's Google *Web* client ID: the ID token Google issues for this app must name it as its audience, because
 * that is what `/api/auth/desktop/google-token` accepts (the website uses the same ID; it is public, not a secret).
 * The Android OAuth client created in Google Cloud for this package and signing key is what lets the phone ask for it.
 */
export const GOOGLE_WEB_CLIENT_ID: string =
  (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined)?.trim() ||
  '249337992826-jm174i5bqdhr4bfqpmip44gnnp4eo2eh.apps.googleusercontent.com'

export interface GoogleAccount {
  idToken: string
  email?: string
  name?: string
}

/** What the native plugin (android/.../GoogleSignInPlugin.java) offers. */
interface GoogleSignInNative {
  signIn(options: { serverClientId: string }): Promise<GoogleAccount>
}

export type GoogleFailure = 'cancelled' | 'no_account' | 'provider' | 'setup' | 'unavailable' | 'failed'

export class GoogleSignInError extends Error {
  constructor(readonly reason: GoogleFailure, message: string) { super(message) }
}

/** Test seam: the landscape UI tests run the web bundle in a browser, where they provide this object. */
declare global {
  interface Window { __TM_GOOGLE_SIGNIN__?: Pick<GoogleSignInNative, 'signIn'> }
}

const native = registerPlugin<GoogleSignInNative>('GoogleSignIn', {
  web: (): GoogleSignInNative => ({
    async signIn(options) {
      const fake = window.__TM_GOOGLE_SIGNIN__
      if (!fake) throw Object.assign(new Error('Google sign-in is only available in the app'), { code: 'unavailable' })
      return fake.signIn(options)
    },
  }),
})

/** Plain-language message for a plugin failure. Google's own text is kept only for the unknown cases. */
export function mapGoogleError(error: unknown): GoogleSignInError {
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  const text = message ?? ''
  if (code === 'cancelled') return new GoogleSignInError('cancelled', 'Google sign-in was cancelled.')
  if (code === 'no_account') return new GoogleSignInError('no_account', 'No Google account is signed in on this phone. Add one in the phone settings, then try again.')
  if (code === 'provider') return new GoogleSignInError('provider', 'Google Play services is missing or needs an update on this phone.')
  if (code === 'unavailable') return new GoogleSignInError('unavailable', 'Google sign-in is only available in the phone app.')
  // 28444 / "Developer console is not set up correctly": the Android OAuth client does not match this app's package or signing key.
  if (/28444|developer console/i.test(text))
    return new GoogleSignInError('setup', 'Google sign-in is not set up for this build of the app (the Android OAuth client in Google Cloud must match the package name and signing key; see docs/phone-google-signin-setup.md).')
  return new GoogleSignInError('failed', text ? `Google sign-in failed: ${text}` : 'Google sign-in failed.')
}

export interface GoogleSignInClient {
  /** True when this build can show the Google button (the app, or a browser test with the seam). */
  available(): boolean
  signIn(): Promise<GoogleAccount>
}

export function createGoogleSignIn(clientId: string = GOOGLE_WEB_CLIENT_ID): GoogleSignInClient {
  return {
    available: () => Capacitor.isNativePlatform() || window.__TM_GOOGLE_SIGNIN__ !== undefined,
    async signIn() {
      let account: GoogleAccount
      try {
        account = await native.signIn({ serverClientId: clientId })
      } catch (error) {
        throw mapGoogleError(error)
      }
      if (!account?.idToken) throw new GoogleSignInError('failed', 'Google did not return a sign-in token.')
      return account
    },
  }
}
