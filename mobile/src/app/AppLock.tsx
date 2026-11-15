import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { useAuth, useServices } from './AppContext'
import { shouldLock } from './lockPolicy'
import type { UnlockResult } from '../native/appLock'

const LOCK_KEY = 'tm.app_lock'

interface AppLockValue {
  /** The phone has a fingerprint, face or screen lock the app can ask for (null while checking). */
  supported: boolean | null
  enabled: boolean
  /** Turn the lock on (the owner must prove they are there first) or off. */
  setEnabled(on: boolean): Promise<UnlockResult>
}
const AppLockContext = createContext<AppLockValue | null>(null)

export function useAppLock(): AppLockValue {
  const value = useContext(AppLockContext)
  if (!value) throw new Error('useAppLock must be used inside <AppLockProvider>')
  return value
}

/**
 * Optional app lock. When on, the app asks for the phone's fingerprint / face / screen lock when it starts and when
 * it comes back after being away for LOCK_GRACE_MS. The setting lives in the app's preferences; signing out turns it
 * off (the next account decides for itself). While locked the screens stay mounted underneath an opaque cover.
 */
export function AppLockProvider({ children }: { children: ReactNode }) {
  const { appLock, prefs } = useServices()
  const { status, signOut } = useAuth()
  const [loaded, setLoaded] = useState(false)
  const [enabled, setEnabledState] = useState(false)
  const [supported, setSupported] = useState<boolean | null>(null)
  const [locked, setLocked] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const prompting = useRef(false)
  const backgroundedAt = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([prefs.get(LOCK_KEY), appLock.isAvailable()]).then(([flag, available]) => {
      if (cancelled) return
      const on = flag === '1'
      setEnabledState(on)
      setSupported(available)
      setLocked(on) // a cold start is locked until the owner is verified
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [appLock, prefs])

  const unlock = useCallback(async () => {
    if (prompting.current) return
    prompting.current = true
    setMessage(null)
    try {
      const result = await appLock.authenticate('Unlock TradeMatangi')
      if (result === 'ok') setLocked(false)
      else if (result === 'unavailable') setMessage('This phone has no screen lock or fingerprint set up, so the app cannot be unlocked. Set one up in the phone settings, or sign out.')
      else if (result === 'failed') setMessage('Could not unlock. Try again.')
    } finally {
      prompting.current = false
    }
  }, [appLock])

  // Ask as soon as the lock screen appears (cold start, or back after being away).
  useEffect(() => {
    if (loaded && locked && enabled && status === 'signedIn') void unlock()
  }, [loaded, locked, enabled, status, unlock])

  useEffect(() => {
    if (!enabled) return
    const handle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (prompting.current) return // the unlock dialog itself may move the app to the background for a moment
      if (!isActive) { backgroundedAt.current = Date.now(); return }
      if (shouldLock({ enabled, backgroundedAt: backgroundedAt.current, now: Date.now() })) setLocked(true)
      backgroundedAt.current = null
    })
    return () => { void handle.then(listener => listener.remove()) }
  }, [enabled])

  // Signing out ends the lock with the session.
  useEffect(() => {
    if (status !== 'signedOut') return
    setLocked(false)
    if (enabled) { setEnabledState(false); void prefs.remove(LOCK_KEY) }
  }, [status, enabled, prefs])

  const setEnabled = useCallback(async (on: boolean): Promise<UnlockResult> => {
    if (on) {
      if (prompting.current) return 'cancelled'
      prompting.current = true
      let result: UnlockResult
      try { result = await appLock.authenticate('Turn on the app lock') } finally { prompting.current = false }
      if (result !== 'ok') return result
      await prefs.set(LOCK_KEY, '1')
      setEnabledState(true)
      return 'ok'
    }
    await prefs.remove(LOCK_KEY)
    setEnabledState(false)
    setLocked(false)
    return 'ok'
  }, [appLock, prefs])

  const value = useMemo<AppLockValue>(() => ({ supported, enabled, setEnabled }), [supported, enabled, setEnabled])
  const covered = loaded && locked && enabled && status === 'signedIn'

  return (
    <AppLockContext.Provider value={value}>
      <div className="app-lock-content" aria-hidden={covered} {...(covered ? { inert: '' } : {})}>{children}</div>
      {covered && (
        <div className="app-lock" role="dialog" aria-modal="true" aria-label="App locked">
          <h2>TradeMatangi is locked</h2>
          {message && <p role="alert">{message}</p>}
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => void unlock()}>Unlock</button>
            <button type="button" className="btn" onClick={() => void signOut()}>Sign out</button>
          </div>
        </div>
      )}
    </AppLockContext.Provider>
  )
}
