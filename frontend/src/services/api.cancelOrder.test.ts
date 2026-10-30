/**
 * Tests for api.cancelOrder's force-cancel support (added alongside the
 * backend's `force=true` override for an order whose own broker
 * acknowledgement can't be confirmed within a few seconds).
 *
 * NOTE: Requires vitest. Not currently installed in this project's
 * frontend (no test runner in package.json) -- committed so the test can
 * be wired up later, matching the existing precedent in this directory
 * (see PendingLabelPanel.test.tsx, useSimulation.labeling.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/notifications', () => ({
  flashError: vi.fn(),
  getNotificationContext: vi.fn(() => undefined),
  getNotificationScope: vi.fn(() => 0),
}))

import api from './api'

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('api.cancelOrder', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('does not append a force query param by default', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { order_id: 'o1', status: 'CANCELLED' }))
    await api.cancelOrder('s1', 'o1')
    const url = vi.mocked(fetch).mock.calls[0][0] as string
    expect(url).not.toContain('force=true')
  })

  it('appends force=true when force is requested', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { order_id: 'o1', status: 'CANCELLED' }))
    await api.cancelOrder('s1', 'o1', true)
    const url = vi.mocked(fetch).mock.calls[0][0] as string
    expect(url).toContain('force=true')
  })

  it('throws an ApiError with the structured code on a 409 ambiguous-cancel response', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(409, {
      detail: { code: 'cancel_confirmation_ambiguous', message: "Couldn't confirm this order's status with the broker within a few seconds; retry, or cancel with force=true" },
    }))
    await expect(api.cancelOrder('s1', 'o1')).rejects.toMatchObject({
      status: 409,
      code: 'cancel_confirmation_ambiguous',
    })
  })

  it('still handles a plain-string 409 detail from other cancel rejections', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(409, { detail: 'Split is unconfirmed; refresh broker orders before changing this order' }))
    await expect(api.cancelOrder('s1', 'o1')).rejects.toMatchObject({
      status: 409,
      code: undefined,
      message: 'Split is unconfirmed; refresh broker orders before changing this order',
    })
  })

  it('treats a 404 as already-resolved rather than an error', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(404, {}))
    await expect(api.cancelOrder('s1', 'o1')).resolves.toBeNull()
  })
})
