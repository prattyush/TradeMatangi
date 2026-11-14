import { useEffect } from 'react'

/** Keep the screen on while `active` (a video is playing); released when it stops or the screen closes. No-op where unsupported. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    let lock: { release(): Promise<void> } | null = null
    let cancelled = false
    const acquire = async () => {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }
        const got = await nav.wakeLock?.request('screen')
        if (!got) return
        if (cancelled) void got.release().catch(() => undefined)
        else lock = got
      } catch { /* not allowed (battery saver, background): the video still plays */ }
    }
    void acquire()
    // The lock is dropped when the app goes to the background; take it again on return.
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => undefined)
    }
  }, [active])
}
