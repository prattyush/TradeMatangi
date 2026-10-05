import { describe, expect, it, vi } from 'vitest'
import { TradingRefresh, eventNeedsTradingRefresh, backupReconciliationEnabled, readStreamChunk, STREAM_IDLE_TIMEOUT_MS } from './tradingRefresh'

describe('trading snapshot reconciliation', () => {
  it('waits five minutes and resets the deadline after Next Bar', () => {
    const refresh = new TradingRefresh()
    expect(refresh.due('session', 1000)).toBe(false)
    expect(refresh.due('session', 300999)).toBe(false)
    expect(refresh.due('session', 301000)).toBe(true)
    refresh.mark('session', 301000)
    expect(refresh.due('session', 301001)).toBe(false)
  })
  it('coalesces requests from events and local actions', async () => {
    const refresh = new TradingRefresh()
    let finish!: (value: number) => void
    let requests = 0
    const fetch = () => { requests++; return new Promise<number>(resolve => { finish = resolve }) }
    const first = refresh.request('session', fetch)
    const second = refresh.request('session', fetch)
    expect(requests).toBe(1)
    finish(5)
    expect(await first).toBe(5)
    expect(await second).toBe(5)
    expect(refresh.due('session')).toBe(false)
  })
  it('isolates sessions and permits retry after failure', async () => {
    const refresh = new TradingRefresh()
    await expect(refresh.request('a', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(await refresh.request('a', async () => 2)).toBe(2)
    refresh.mark('b', 0)
    expect(refresh.due('b', 300000)).toBe(true)
    expect(refresh.due('a')).toBe(false)
  })
  it('refreshes on changes not already covered by an authoritative snapshot', () => {
    expect(eventNeedsTradingRefresh({ type: 'tick', event_id: 6 }, 5)).toBe(false)
    expect(eventNeedsTradingRefresh({ type: 'bar_paused', event_id: 6 }, 5)).toBe(false)
    expect(eventNeedsTradingRefresh({ type: 'order_filled', event_id: 5 }, 5)).toBe(false)
    expect(eventNeedsTradingRefresh({ type: 'order_filled', event_id: 6 }, 5)).toBe(true)
    expect(eventNeedsTradingRefresh({ type: 'order_filled', event_id: 6, trade: {}, position: {}, pnl: {} }, 5)).toBe(false)
    expect(eventNeedsTradingRefresh({ type: 'order_placed', event_id: 7 }, 5)).toBe(false)
    expect(eventNeedsTradingRefresh({ type: 'stream_reset' }, 5)).toBe(true)
  })
})


describe('idle traffic and transport liveness', () => {
  it('backs up running modes but skips paused, stopped and waiting Stepwise', () => {
    expect(backupReconciliationEnabled('Paper', 'running')).toBe(true)
    expect(backupReconciliationEnabled('Replay', 'running')).toBe(true)
    for (const state of ['idle', 'paused', 'ended']) expect(backupReconciliationEnabled('Paper', state)).toBe(false)
    expect(backupReconciliationEnabled('Stepwise', 'running')).toBe(false)
  })

  it('restarts the transport deadline on heartbeat bytes without snapshot requests', async () => {
    vi.useFakeTimers()
    try {
      const heartbeat = new TextEncoder().encode(': heartbeat\n\n')
      const reader = { read: vi.fn().mockResolvedValue({ done: false, value: heartbeat }), cancel: vi.fn().mockResolvedValue(undefined) }
      await readStreamChunk(reader as unknown as ReadableStreamDefaultReader<Uint8Array>)
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS * 2)
      expect(reader.cancel).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('cancels a silently stalled reader after sixty seconds', async () => {
    vi.useFakeTimers()
    try {
      const reader = { read: vi.fn(() => new Promise(() => undefined)), cancel: vi.fn().mockResolvedValue(undefined) }
      const result = readStreamChunk(reader as unknown as ReadableStreamDefaultReader<Uint8Array>)
      const assertion = expect(result).rejects.toThrow('heartbeat timed out')
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS)
      await assertion
      expect(reader.cancel).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
