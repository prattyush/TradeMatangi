/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import api from '../../frontend/src/services/api'

let values: Map<string, string>
beforeEach(() => {
  values = new Map([['auth_user', JSON.stringify({ userId: 'gap-user' })]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  vi.stubGlobal('CustomEvent', class { detail: unknown; constructor(public type: string, options: { detail: unknown }) { this.detail = options.detail } })
})
afterEach(() => vi.unstubAllGlobals())
const response = (body: unknown) => ({ ok: true, json: async () => body })
const saved = { historical_days: 2, target_deviation_pct: .02, stoploss_limit_gap_pct: .03, target_deviation_configured: true }

describe('shared execution gap settings', () => {
  it('uses backend values over a stale browser setting', async () => {
    values.set('targetDeviationPct', '5')
    const fetch = vi.fn().mockResolvedValue(response(saved))
    vi.stubGlobal('fetch', fetch)
    expect(await api.getUserSettings()).toEqual(saved)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(values.get('targetDeviationPct')).toBe('2')
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ detail: saved }))
  })
  it('imports a legacy browser value only when backend reports no saved target gap', async () => {
    values.set('targetDeviationPct', '2')
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...saved, target_deviation_configured: false }))
      .mockResolvedValueOnce(response(saved))
    vi.stubGlobal('fetch', fetch)
    expect(await api.getUserSettings()).toEqual(saved)
    expect(fetch.mock.calls[1][0]).toContain('/settings/target-gap-migration')
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ target_deviation_pct: .02 })
  })
  it('does not cache defaults as a legacy override', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...saved, target_deviation_configured: false })))
    await api.getUserSettings()
    expect(values.has('targetDeviationPct')).toBe(false)
  })
  it('refreshes settings before submission and preserves market execution intent', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(saved)).mockResolvedValueOnce(response({ order_id: 'market' }))
    vi.stubGlobal('fetch', fetch)
    await api.placeOrder('session', 'BUY', 'LIMIT', 101, 1, { market_order: true, execute_immediately: true, target_deviation_pct: .08 })
    const body = JSON.parse(fetch.mock.calls[1][1].body)
    expect(body).toMatchObject({ market_order: true, execute_immediately: true, target_deviation_pct: .02 })
  })
  it('does not submit an order when settings cannot be loaded', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    vi.stubGlobal('fetch', fetch)
    await expect(api.placeOrder('session', 'BUY', 'LIMIT', 101, 1, { market_order: true })).rejects.toThrow('Load user settings failed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('propagates settings save failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: 'Database unavailable' }) }))
    await expect(api.updateUserSettings({ stoploss_limit_gap_pct: .03 })).rejects.toThrow('Database unavailable')
  })
})
