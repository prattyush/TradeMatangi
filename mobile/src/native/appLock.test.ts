import { describe, expect, it } from 'vitest'
import { shouldLock, LOCK_GRACE_MS } from '../app/lockPolicy'
import { mapGoogleError } from './googleSignIn'

describe('shouldLock', () => {
  it('never locks when the lock is off', () => {
    expect(shouldLock({ enabled: false, backgroundedAt: 0, now: 10 * LOCK_GRACE_MS })).toBe(false)
  })
  it('stays unlocked for a short trip out of the app and locks after the grace period', () => {
    expect(shouldLock({ enabled: true, backgroundedAt: 1000, now: 1000 + LOCK_GRACE_MS - 1 })).toBe(false)
    expect(shouldLock({ enabled: true, backgroundedAt: 1000, now: 1000 + LOCK_GRACE_MS })).toBe(true)
  })
  it('locks when the time of leaving is unknown', () => {
    expect(shouldLock({ enabled: true, backgroundedAt: null, now: 5 })).toBe(true)
  })
})

describe('mapGoogleError', () => {
  it('names the cancelled, no-account and Play services cases', () => {
    expect(mapGoogleError({ code: 'cancelled' }).reason).toBe('cancelled')
    expect(mapGoogleError({ code: 'no_account' }).reason).toBe('no_account')
    expect(mapGoogleError({ code: 'provider' }).reason).toBe('provider')
  })
  it('explains the 28444 developer-console error as a setup problem', () => {
    const error = mapGoogleError({ code: 'failed', message: 'TYPE_UNKNOWN: During begin sign in, failure response from one tap: 28444: Developer console is not set up correctly.' })
    expect(error.reason).toBe('setup')
    expect(error.message).toContain('signing key')
  })
  it('keeps the text of unknown failures', () => {
    expect(mapGoogleError({ code: 'failed', message: 'boom' }).message).toContain('boom')
  })
})
