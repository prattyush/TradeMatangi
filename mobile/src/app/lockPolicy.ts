/** How long the app may be out of the foreground before it asks for the fingerprint / screen lock again. */
export const LOCK_GRACE_MS = 30_000

/** Pure rule for "should the lock screen come back now". `backgroundedAt` is when the app left the foreground. */
export function shouldLock(input: { enabled: boolean; backgroundedAt: number | null; now: number }): boolean {
  if (!input.enabled) return false
  if (input.backgroundedAt === null) return true
  return input.now - input.backgroundedAt >= LOCK_GRACE_MS
}
