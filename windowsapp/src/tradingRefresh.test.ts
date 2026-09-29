import { describe, expect, it } from 'vitest'
import { TradingRefresh, eventNeedsTradingRefresh } from './tradingRefresh'

describe('trading snapshot reconciliation', () => {
  it('waits 30 seconds and resets the deadline after Next Bar', () => {
    const refresh = new TradingRefresh()
    expect(refresh.due('session', 1000)).toBe(false)
    expect(refresh.due('session', 30999)).toBe(false)
    expect(refresh.due('session', 31000)).toBe(true)
    refresh.mark('session', 31000)
    expect(refresh.due('session', 31001)).toBe(false)
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
    expect(refresh.due('b', 30000)).toBe(true)
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
