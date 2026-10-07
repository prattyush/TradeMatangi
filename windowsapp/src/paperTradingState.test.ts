import { describe, expect, it } from 'vitest'
import type { DesktopPosition, DesktopTradingSnapshot } from './contracts'
import { acceptPaperSnapshot, applyPaperStreamEvent } from './paperTradingState'

const flat: DesktopPosition = { symbol: 'NIFTY', side: 'FLAT', quantity: 0, avg_entry_price: 0, entry_commission: 0 }
const key = 'NIFTY:2026-10-01:24000:CE'
const snapshot = (): DesktopTradingSnapshot => ({
  version: 1, event_cursor: 10,
  session: { session_id: 'paper-1', symbol: 'NIFTY', expiry: '2026-10-01', strike_ce: 24000, strike_pe: 24000, session_capital: 100000, brokerage_per_order: 1, instrument_type: 'options' } as DesktopTradingSnapshot['session'],
  current_time: 100, current_bar_index: 0, current_price: 24000, current_price_ce: 100, current_price_pe: 90,
  positions: { equity: flat, CE: flat, PE: flat }, positions_by_contract: {},
  contract_quotes: { [key]: { symbol: 'NIFTY', expiry: '2026-10-01', strike: 24000, right: 'CE', contract_key: key, price: 100, timestamp: 100, source: 'live_paper' } },
  trades: [], open_orders: [], strategies: [], contracts: [], wallet_balance: 100500,
  pnl: { equity: 0, ce: 0, pe: 0, contracts: {}, day: 500, day_pct: 0.5 },
  settings: {} as DesktopTradingSnapshot['settings'],
})
const tick = (eventId: number, price: number, time = 101) => ({ type: 'tick', event_id: eventId, close: price, time, right: 'CE', contract_key: key, strike: 24000, expiry: '2026-10-01' })

describe('Paper trading incremental state', () => {
  it('updates an existing split exit without duplicating its order', () => {
    let current = snapshot()
    current = applyPaperStreamEvent(current, { type: 'order_placed', event_id: 11, order_id: 'exit', status: 'PENDING', quantity: 100, trigger_price: 90 })
    const next = applyPaperStreamEvent(current, { type: 'order_updated', event_id: 12, order_id: 'exit', status: 'PENDING', quantity: 50 })
    expect(next.open_orders).toHaveLength(1)
    expect(next.open_orders[0]).toMatchObject({ quantity: 50, trigger_price: 90 })
  })

  it('applies split siblings and removes a retained order filled during confirmation', () => {
    let current = snapshot()
    current = applyPaperStreamEvent(current, { type: 'order_updated', event_id: 11, order_id: 'retained', status: 'PENDING', quantity: 40, limit_price: 100 })
    current = applyPaperStreamEvent(current, { type: 'order_updated', event_id: 12, order_id: 'child', status: 'PENDING', quantity: 20, limit_price: 100 })
    expect(current.open_orders.map(order => order.quantity)).toEqual([40, 20])
    current = applyPaperStreamEvent(current, { type: 'order_updated', event_id: 13, order_id: 'retained', status: 'FILLED' })
    expect(current.open_orders.map(order => order.order_id)).toEqual(['child'])
  })

  it('applies a committed fill to orders, markers, position, and P&L without a snapshot', () => {
    const current = snapshot()
    current.open_orders = [{ order_id: 'order-1', session_id: 'paper-1', user_id: 'u', symbol: 'NIFTY', side: 'BUY', order_type: 'LIMIT', quantity: 50, trigger_price: 0, limit_price: 101, status: 'PENDING', created_at: 100, is_stoploss: false, right: 'CE', strike: 24000, expiry: '2026-10-01' }]
    const position = { ...flat, side: 'LONG' as const, quantity: 50, avg_entry_price: 100 }
    const event = {
      type: 'order_filled', event_id: 11, order_id: 'order-1', right: 'CE', strike: 24000, expiry: '2026-10-01', contract_key: key, filled_at: 101,
      trade: { trade_id: 'order-1', session_id: 'paper-1', symbol: 'NIFTY', side: 'BUY', quantity: 50, price: 100, timestamp: 101, right: 'CE', strike: 24000, expiry: '2026-10-01' },
      position, open_trade_ids: ['order-1'], pnl: { equity: 0, ce: -2, pe: 0, contracts: { [key]: -2 }, day: 498, day_pct: 0.498 },
    }
    const filled = applyPaperStreamEvent(current, event)
    expect(filled.open_orders).toHaveLength(0)
    expect(filled.trades).toMatchObject([{ trade_id: 'order-1', is_open: true }])
    expect(filled.positions_by_contract[key]).toEqual(position)
    expect(filled.positions.CE).toEqual(position)
    expect(filled.pnl.day).toBe(498)
    expect(applyPaperStreamEvent(filled, event)).toBe(filled)
    expect(applyPaperStreamEvent(filled, { type: 'order_placed', event_id: 10, ...current.open_orders[0] })).toBe(filled)
  })

  it('keeps the primary option position when a secondary strike fills', () => {
    const current = snapshot()
    const secondary = 'NIFTY:2026-10-01:24100:CE'
    const position = { ...flat, side: 'LONG' as const, quantity: 50, avg_entry_price: 80 }
    const next = applyPaperStreamEvent(current, {
      type: 'order_filled', event_id: 11, order_id: 'secondary', right: 'CE', strike: 24100,
      expiry: '2026-10-01', contract_key: secondary, filled_at: 101,
      trade: { trade_id: 'secondary', session_id: 'paper-1', symbol: 'NIFTY', side: 'BUY', quantity: 50, price: 80, timestamp: 101 },
      position, open_trade_ids: ['secondary'], pnl: current.pnl,
    })
    expect(next.positions.CE).toBe(current.positions.CE)
    expect(next.positions_by_contract[secondary]).toEqual(position)
  })

  it('preserves realized profit after all positions close', () => {
    expect(applyPaperStreamEvent(snapshot(), tick(11, 105)).pnl.day).toBe(500)
  })

  it.each(['LONG', 'SHORT'] as const)('changes day P&L by only the open %s contract mark', side => {
    const current = snapshot()
    const position = { ...flat, side, quantity: 50, avg_entry_price: 95, entry_commission: 2 }
    current.positions.CE = position
    current.positions_by_contract[key] = position
    const next = applyPaperStreamEvent(current, tick(11, 105))
    expect(next.pnl.day).toBe(side === 'LONG' ? 750 : 250)
    expect(next.pnl.day_pct).toBe(side === 'LONG' ? 0.75 : 0.25)
    // Backend exit charges for 50 lots at 105: SELL=7.99825, BUY=1.3571575.
    expect(next.pnl.contracts?.[key]).toBe(side === 'LONG' ? 490 : -503.36)
    expect(next.pnl.ce).toBe(next.pnl.contracts?.[key])
  })

  it('handles equity alongside an option without double counting', () => {
    const current = snapshot()
    current.positions.equity = { ...flat, side: 'LONG', quantity: 2, avg_entry_price: 23000 }
    current.positions_by_contract[key] = { ...flat, side: 'SHORT', quantity: 50, avg_entry_price: 95 }
    const next = applyPaperStreamEvent(current, { type: 'tick', event_id: 11, close: 24010, time: 101 })
    expect(next.pnl.day).toBe(520)
  })

  it('marks the first option quote from the entry premium, not zero or the underlying', () => {
    const current = snapshot()
    const position = { ...flat, side: 'LONG' as const, quantity: 50, avg_entry_price: 100, entry_commission: 2 }
    current.positions.CE = position
    current.positions_by_contract[key] = position
    current.contract_quotes = {}
    current.current_price_ce = 0
    current.pnl.day = -2
    current.pnl.day_pct = 0
    const next = applyPaperStreamEvent(current, tick(11, 110))
    expect(next.pnl.day).toBe(498)
    expect(next.pnl.day_pct).toBe(0.5)
    expect(next.current_price).toBe(24000)
  })

  it('ignores ticks buffered before a recovery snapshot, including same-second ticks', () => {
    const recovered = { ...snapshot(), event_cursor: 20, current_price_ce: 110 }
    recovered.contract_quotes = { ...recovered.contract_quotes, [key]: { ...recovered.contract_quotes[key], price: 110 } }
    expect(applyPaperStreamEvent(recovered, tick(19, 99, 100))).toBe(recovered)
    expect(applyPaperStreamEvent(recovered, tick(20, 100, 100))).toBe(recovered)
    const next = applyPaperStreamEvent(recovered, tick(21, 111, 100))
    expect(next.current_price_ce).toBe(111)
    expect(applyPaperStreamEvent(next, tick(21, 111, 100))).toBe(next)
  })

  it('rejects an obsolete recovery response and an older stream snapshot', () => {
    const current = { ...snapshot(), event_cursor: 21 }
    expect(acceptPaperSnapshot(current, snapshot())).toBe(current)
    expect(applyPaperStreamEvent(current, snapshot() as unknown as Record<string, unknown>)).toBe(current)
    const other = { ...snapshot(), session: { ...snapshot().session, session_id: 'other' }, event_cursor: 30 }
    expect(acceptPaperSnapshot(current, other)).toBe(current)
  })

  it('does not rewind the shared clock on a later event with an older contract timestamp', () => {
    expect(applyPaperStreamEvent(snapshot(), tick(11, 105, 99)).current_time).toBe(100)
  })

  it('keeps the primary CE price when an attached CE strike ticks', () => {
    const next = applyPaperStreamEvent(snapshot(), { ...tick(11, 150), contract_key: 'NIFTY:2026-10-01:24100:CE', strike: 24100 })
    expect(next.current_price_ce).toBe(100)
    expect(next.contract_quotes['NIFTY:2026-10-01:24100:CE'].price).toBe(150)
  })
})
