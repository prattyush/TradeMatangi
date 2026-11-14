import { describe, expect, it } from 'vitest'
import { ageText, contractName, orderSummary, quoteNote, shortDate, signedPct, signedRupees, tone } from './swingFormat'
import type { PendingOrder, Position } from './swingTypes'

describe('swing formatting', () => {
  it('names contracts the way a trader reads them', () => {
    expect(contractName({ symbol: 'HDFCBANK', instrument_type: 'equity' })).toBe('HDFCBANK')
    expect(contractName({ symbol: 'NIFTY', instrument_type: 'options', expiry: '2026-11-26', strike: 24500, right: 'CE' })).toBe('NIFTY 26 Nov 24500 CE')
    expect(contractName({ symbol: 'RELIND', instrument_type: 'futures', expiry: '2026-12-01' })).toBe('RELIND FUT 01 Dec')
    expect(shortDate('2026-11-05')).toBe('05 Nov')
  })

  it('a missing price is never shown as zero', () => {
    expect(signedRupees(null)).toBe('Waiting for prices')
    expect(signedRupees(undefined)).toBe('Waiting for prices')
    expect(signedRupees(0)).toBe('₹0')
    expect(signedRupees(1234.4)).toBe('+₹1,234')
    expect(signedRupees(-850.6)).toBe('−₹851')
    expect(signedPct(null)).toBe('')
    expect(signedPct(-1.5)).toBe('−1.50%')
    expect(tone(null)).toBe('flat')
    expect(tone(-3)).toBe('neg')
  })

  it('says how fresh a price is', () => {
    const position = (patch: Partial<Position>): Position => ({ session_id: 's', symbol: 'X', instrument_type: 'equity', side: 'LONG', quantity: 1, avg_entry_price: 1, ...patch })
    expect(quoteNote(position({ mark_price: 10, quote_status: 'live' }))).toBe('live')
    expect(quoteNote(position({ mark_price: 10, quote_status: 'stale' }))).toBe('last known')
    expect(quoteNote(position({ mark_price: null, quote_status: 'unavailable' }))).toBe('no price')
  })

  it('summarises a pending order with what is filled', () => {
    const order = { order_id: 'o', session_id: 's', symbol: 'X', side: 'SELL', order_type: 'STOPLOSS', quantity: 100, trigger_price: 1400, limit_price: 1390, status: 'PENDING', instrument_type: 'equity', broker_filled_quantity: 40 } as PendingOrder
    expect(orderSummary(order)).toBe('Sell 100 (40 filled) · Stoploss 1,400.00')
  })

  it('shows the age of the last update', () => {
    expect(ageText(null, 1000)).toBe('not updated yet')
    expect(ageText(1000, 2000)).toBe('just now')
    expect(ageText(1000, 13_000)).toBe('12 s ago')
    expect(ageText(1000, 241_000)).toBe('4 min ago')
  })
})
