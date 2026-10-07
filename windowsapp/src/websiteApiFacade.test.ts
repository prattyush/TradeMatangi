import { afterEach, describe, expect, it, vi } from 'vitest'
import api from '../../frontend/src/services/api'
import { activeSessionSubscriptions } from '../../frontend/src/services/sessionSubscriptions'
import type { SessionGroupResponse } from '../../frontend/src/services/api'

afterEach(() => vi.unstubAllGlobals())

describe('website replay connection', () => {
  it('keeps SSE URL construction synchronous through the notification facade', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ userId: 'replay-user' }) })
    const url = api.getSSEUrl('nifty-replay', '42')
    expect(typeof url).toBe('string')
    expect(url).toContain('/api/stream/nifty-replay')
    expect(url).toContain('user_id=replay-user')
    expect(url).toContain('last_event_id=42')
  })
  it('preserves asynchronous requests and their return values', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ balance: 1000 }) }))
    const response = api.getWallet('2026-10-07')
    expect(response).toBeInstanceOf(Promise)
    expect(await response).toEqual({ balance: 1000 })
  })
  it('subscribes to a selected replay with no group, an empty group or stale ended members', () => {
    const empty = { members: [] } as unknown as SessionGroupResponse
    const ended = { members: [{ session_id: 'old', state: 'ended' }] } as SessionGroupResponse
    for (const group of [null, empty, ended]) expect(activeSessionSubscriptions(group, 'new', 'running')).toEqual(['new'])
  })
  it('deduplicates live group members and omits ended selections', () => {
    const group = { members: [{ session_id: 'a', state: 'running' }, { session_id: 'b', state: 'paused' }, { session_id: 'old', state: 'ended' }] } as SessionGroupResponse
    expect(activeSessionSubscriptions(group, 'b', 'running')).toEqual(['a', 'b'])
    expect(activeSessionSubscriptions(group, 'old', 'ended')).toEqual(['a', 'b'])
    expect(activeSessionSubscriptions(null, null, 'idle')).toEqual([])
  })
})
