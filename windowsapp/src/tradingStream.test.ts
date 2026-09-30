import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopTradingSnapshot } from './contracts'
import { applyPaperStreamEvent } from './paperTradingState'
import { TradingEventJournal, TradingSseDecoder, TradingStreamController, TradingStreamDrain, TradingStreamLifecycle } from './tradingStream'

const snapshot = (cursor = 10): DesktopTradingSnapshot => ({
  session: { session_id: 'replay', session_capital: 10000, state: 'running' },
  event_cursor: cursor, current_time: 100, current_price: 100,
  current_price_ce: 0, current_price_pe: 0,
  open_orders: [{ order_id: 'stop', status: 'PENDING' }], trades: [], strategies: [],
  positions: { equity: { side: 'LONG', quantity: 1, avg_entry_price: 100, entry_commission: 0 } },
  pnl: { day: 0 }, settings: {},
} as unknown as DesktopTradingSnapshot)
const tick = (id: number, price: number) => ({ type: 'tick', event_id: id, close: price, time: 100 + id })
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('trading stream recovery', () => {
  it('removes a legacy filled order immediately and consumes later changes during a slow snapshot', async () => {
    let current = snapshot()
    let finish!: (snapshot: DesktopTradingSnapshot) => void
    const fetchSnapshot = vi.fn(() => new Promise<DesktopTradingSnapshot>(resolve => { finish = resolve }))
    const controller = new TradingStreamController({ current: () => current, publish: value => { current = value }, fetchSnapshot, onError: vi.fn() })
    controller.receive([{ type: 'order_filled', event_id: 11, order_id: 'stop' }])
    expect(current.open_orders).toEqual([])
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    controller.receive([{ type: 'order_placed', event_id: 12, order_id: 'new', status: 'PENDING' }, tick(13, 105)])
    expect(current.open_orders[0].order_id).toBe('new')
    expect(current.current_price).toBe(105)
    const authoritative = snapshot(11)
    authoritative.open_orders = []
    authoritative.pnl.day = 50
    finish(authoritative)
    await flush()
    expect(current.event_cursor).toBe(13)
    expect(current.open_orders.map(order => order.order_id)).toEqual(['new'])
    expect(current.current_price).toBe(105)
    expect(current.pnl.day).toBe(55)
    controller.stop()
  })

  it('updates complete fills atomically without requesting a snapshot and deduplicates reconnect events', () => {
    let current = snapshot()
    const fetchSnapshot = vi.fn()
    const controller = new TradingStreamController({ current: () => current, publish: value => { current = value }, fetchSnapshot, onError: vi.fn() })
    const fill = { type: 'order_filled', event_id: 11, order_id: 'stop', filled_at: 101,
      trade: { trade_id: 'stop', session_id: 'replay' }, position: { side: 'FLAT', quantity: 0 }, pnl: { day: 20 }, open_trade_ids: [], wallet_balance: 10020 }
    controller.receive([fill])
    controller.receive([fill])
    expect(fetchSnapshot).not.toHaveBeenCalled()
    expect(current.open_orders).toEqual([])
    expect(current.trades).toHaveLength(1)
    expect(current.positions.equity.side).toBe('FLAT')
    expect(current.pnl.day).toBe(20)
    expect(current.wallet_balance).toBe(10020)
  })

  it('rejects recovery outside the bounded journal rather than rolling prices backward', () => {
    const journal = new TradingEventJournal(2)
    let current = snapshot()
    for (const event of [tick(11, 101), tick(12, 102), tick(13, 103)]) {
      journal.record(event)
      current = applyPaperStreamEvent(current, event)
    }
    expect(journal.reconcile(current, snapshot(10))).toEqual({ snapshot: current, retry: true })
    expect(journal.reconcile(current, snapshot(11)).snapshot.current_price).toBe(103)
    expect(journal.reconcile(current, { ...snapshot(14), session: { ...current.session, session_id: 'other' } }).snapshot).toBe(current)
  })

  it('retries a failed recovery without blocking events and cancels retries on cleanup', async () => {
    vi.useFakeTimers()
    let current = snapshot()
    const fetchSnapshot = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot(12))
    const onError = vi.fn()
    const controller = new TradingStreamController({ current: () => current, publish: value => { current = value }, fetchSnapshot, onError })
    controller.recover()
    await flush()
    controller.receive([tick(11, 110)])
    expect(current.current_price).toBe(110)
    expect(onError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    controller.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('ignores an obsolete response after the session controller stops', async () => {
    let current = snapshot()
    let finish!: (snapshot: DesktopTradingSnapshot) => void
    const publish = vi.fn(value => { current = value })
    const controller = new TradingStreamController({ current: () => current, publish,
      fetchSnapshot: () => new Promise(resolve => { finish = resolve }), onError: vi.fn() })
    controller.recover()
    controller.stop()
    finish(snapshot(20))
    await flush()
    expect(publish).not.toHaveBeenCalled()
  })

  it('requires recovery to cover missing events instead of replaying across an unresolved gap', async () => {
    vi.useFakeTimers()
    let current = snapshot()
    // Event 11 cancelled the stop, but the transport only retained event 12.
    const authoritative = snapshot(11)
    authoritative.open_orders = []
    const fetchSnapshot = vi.fn().mockResolvedValueOnce(snapshot(10)).mockResolvedValueOnce(authoritative)
    const controller = new TradingStreamController({ current: () => current, publish: value => { current = value }, fetchSnapshot, onError: vi.fn() })
    controller.receive([tick(12, 105)], true)
    await flush()
    expect(current.event_cursor).toBe(12)
    expect(current.current_price).toBe(105)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(current.open_orders).toEqual([])
    expect(current.event_cursor).toBe(12)
    controller.stop()
  })
})

describe('native trading wakeups', () => {
  it('finishes obsolete startup and cleanup before starting the replacement stream', async () => {
    const lifecycle = new TradingStreamLifecycle()
    const calls: string[] = []
    let finish!: () => void
    const first = lifecycle.run('session', async () => {
      calls.push('starting')
      await new Promise<void>(resolve => { finish = resolve })
      calls.push('started')
    })
    await flush()
    const cleanup = lifecycle.run('session', async () => { calls.push('stopped') })
    const replacement = lifecycle.run('session', async () => { calls.push('replacement') })
    finish()
    await Promise.all([first, cleanup, replacement])
    expect(calls).toEqual(['starting', 'started', 'stopped', 'replacement'])
  })

  it('serializes reads and drains again for wakeups received during a read', async () => {
    let finish!: () => void
    const read = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve })).mockResolvedValue(undefined)
    const drain = new TradingStreamDrain(read, vi.fn())
    const first = drain.wake()
    await drain.wake()
    await drain.wake()
    expect(read).toHaveBeenCalledTimes(1)
    finish()
    await first
    expect(read).toHaveBeenCalledTimes(2)
    drain.stop()
    await drain.wake()
    expect(read).toHaveBeenCalledTimes(2)
  })
})

describe('browser trading SSE', () => {
  it('delivers a fill from split frames immediately and continues after invalid frames', () => {
    let current = snapshot()
    const fetchSnapshot = vi.fn(() => new Promise<DesktopTradingSnapshot>(() => {}))
    const controller = new TradingStreamController({ current: () => current, publish: value => { current = value }, fetchSnapshot, onError: vi.fn() })
    const delivered = vi.fn((event, id) => controller.receive([{ ...event, event_id: id }]))
    const decoder = new TradingSseDecoder(delivered, () => controller.recover())
    const encoder = new TextEncoder()
    decoder.push(encoder.encode(': heartbeat\r\n\r\nid: 11\r\ndata: {"type":"order_filled","order_id":"stop"}\r'))
    expect(delivered).not.toHaveBeenCalled()
    decoder.push(encoder.encode('\n\r\n'))
    expect(current.open_orders).toEqual([])
    decoder.push(encoder.encode('data: invalid\n\nid: 12\ndata: {"type":"order_placed","order_id":"new","status":"PENDING"}\n\n'))
    expect(current.open_orders.map(order => order.order_id)).toEqual(['new'])
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    controller.stop()
  })
})
