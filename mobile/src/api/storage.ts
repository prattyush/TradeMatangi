import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'

/** Minimal async key-value store; tests use the in-memory one. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export const isNativeApp = (): boolean => Capacitor.isNativePlatform()

export function createMemoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const values = new Map(Object.entries(initial))
  return {
    async get(key) { return values.get(key) ?? null },
    async set(key, value) { values.set(key, value) },
    async remove(key) { values.delete(key) },
  }
}

/** Non-secret settings (server URL, display name). Android SharedPreferences in the app, localStorage in a browser. */
export function createPreferencesStore(): KeyValueStore {
  return {
    async get(key) {
      if (isNativeApp()) return (await Preferences.get({ key })).value
      try { return localStorage.getItem(key) } catch { return null }
    },
    async set(key, value) {
      if (isNativeApp()) await Preferences.set({ key, value })
      else try { localStorage.setItem(key, value) } catch { /* private mode: setting is not remembered */ }
    },
    async remove(key) {
      if (isNativeApp()) await Preferences.remove({ key })
      else try { localStorage.removeItem(key) } catch { /* nothing to remove */ }
    },
  }
}

/**
 * Secrets (the refresh token). In the app they live in the Android Keystore. In a plain browser (development and
 * UI tests) nothing is persisted at all: a browser has no secure place for a long-lived token.
 */
export function createSecureStore(): KeyValueStore {
  if (!isNativeApp()) return createMemoryStore()
  return {
    async get(key) {
      try {
        const value = await SecureStorage.get(key, false, false)
        return typeof value === 'string' ? value : null
      } catch { return null }
    },
    async set(key, value) { await SecureStorage.set(key, value, false, false) },
    async remove(key) {
      try { await SecureStorage.remove(key, false) } catch { /* already gone */ }
    },
  }
}
