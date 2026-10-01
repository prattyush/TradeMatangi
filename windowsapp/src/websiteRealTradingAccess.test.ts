/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import api, { ApiError } from '../../frontend/src/services/api'

afterEach(() => vi.unstubAllGlobals())

describe('website real trading access check', () => {
  it('uses the logged-in identity for Google and password accounts alike', async () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ userId: 'google-user' }) })
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ has_access: true }) })
    vi.stubGlobal('fetch', fetch)
    expect(await api.checkRealTradingAccess()).toEqual({ has_access: true })
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/kotak/check-access'),
      { headers: { 'X-User-Id': 'google-user' } })
  })

  it('returns a genuine permission denial from a successful check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ has_access: false }) }))
    expect(await api.checkRealTradingAccess()).toEqual({ has_access: false })
  })

  it('exposes failed checks for retry instead of treating them as permission denial', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
    await expect(api.checkRealTradingAccess()).rejects.toBeInstanceOf(ApiError)
    await expect(api.checkRealTradingAccess()).rejects.toMatchObject({ status: 503 })
  })
})
