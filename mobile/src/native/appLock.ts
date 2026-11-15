import { Capacitor, registerPlugin } from '@capacitor/core'

/** What the native plugin (android/.../AppLockPlugin.java) offers. */
interface AppLockNative {
  isAvailable(): Promise<{ available: boolean }>
  authenticate(options: { title?: string }): Promise<void>
}

declare global {
  interface Window { __TM_APP_LOCK__?: AppLockNative }
}

const native = registerPlugin<AppLockNative>('AppLock', {
  web: (): AppLockNative => ({
    async isAvailable() { return window.__TM_APP_LOCK__ ? window.__TM_APP_LOCK__.isAvailable() : { available: false } },
    async authenticate(options) {
      if (!window.__TM_APP_LOCK__) throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
      return window.__TM_APP_LOCK__.authenticate(options)
    },
  }),
})

export type UnlockResult = 'ok' | 'cancelled' | 'unavailable' | 'failed'

export interface AppLockClient {
  /** True when the phone has a fingerprint, face or screen lock the app can ask for. */
  isAvailable(): Promise<boolean>
  /** Ask the owner of the phone to prove they are there. Never throws. */
  authenticate(title?: string): Promise<UnlockResult>
}

export function createAppLock(): AppLockClient {
  const present = () => Capacitor.isNativePlatform() || window.__TM_APP_LOCK__ !== undefined
  return {
    async isAvailable() {
      if (!present()) return false
      try { return (await native.isAvailable()).available } catch { return false }
    },
    async authenticate(title) {
      if (!present()) return 'unavailable'
      try {
        await native.authenticate({ title })
        return 'ok'
      } catch (error) {
        const code = (error as { code?: string }).code
        return code === 'cancelled' ? 'cancelled' : code === 'unavailable' ? 'unavailable' : 'failed'
      }
    },
  }
}
