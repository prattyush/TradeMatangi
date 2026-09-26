import { describe, expect, it } from 'vitest'
import type { DesktopPosition, DesktopTradingSnapshot } from './contracts'
import { acceptPaperSnapshot, applyPaperStreamEvent } from './paperTradingState'

const flat: DesktopPosition = { symbol: 'NIFTY', side: 'FLAT', quantity: 0, avg_entry_price: 0, entry_commission: 0 }
const key = 'NIFTY:2026-10-01:24000:CE'
const snapshot = (): DesktopTradingSnapshot => ({
  version: 1, event_cursor: 10,
  session: { session_id: 'paper-1', symbol: 'NIFTY', session_capital: 100000, brokerage_per_order: 1, instrument_type: 'options' } as DesktopTradingSnapshot['session'],
  current_time: 100, current_bar_index: 0, current_price: 24000, current_price_ce: 100, current_price_pe: 90,
  positions: { equity: flat, CE: flat, PE: flat }, positions_by_contract: {},
  contract_quotes: { [key]: { symbol: 'NIFTY', expiry: '2026-10-01', strike: 24000, right: 'CE', contract_key: key, price: 100, timestamp: 100, source: 'live_paper' } },
  trades: [], open_orders: [], strategies: [], contracts: [], wallet_balance: 100500,
  pnl: { equity: 0, ce: 0, pe: 0, contracts: {}, day: 500, day_pct: 0.5 },
  settings: {} as DesktopTradingSnapshot['settings'],
})
const tick = (eventId: number, price: number, time = 101) => ({ type: 'tick', event_id: eventId, close: price, time, right: 'CE', contract_key: key, strike: 24000, expiry: '2026-10-01' })

describe('Paper trading incremental state', () => {
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
})
