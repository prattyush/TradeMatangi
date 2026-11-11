import { describe, expect, it } from 'vitest'
import { presetFor } from './positionActions'
import type { Position } from './swingTypes'

const position = (patch: Partial<Position>): Position => ({ session_id: 's', symbol: 'HDFCBANK', instrument_type: 'equity', side: 'LONG', quantity: 100, avg_entry_price: 1500, mark_price: 1600, quote_status: 'live', ...patch })

describe('actions on a position', () => {
  it('exit sells a long at the last price, everything that is free', () => {
    const preset = presetFor(position({}), 'exit')
    expect(preset.draft).toMatchObject({ side: 'SELL', type: 'LIMIT', price: '1600', instrument: 'equity' })
    expect(preset.exitAll).toBe(true)
  })

  it('a stoploss on a long sits 3% below the price, on a short 3% above, as a buy to cover', () => {
    expect(presetFor(position({}), 'stoploss').draft).toMatchObject({ side: 'SELL', type: 'STOPLOSS', price: '1552' })
    const short = presetFor(position({ symbol: 'RELIND', instrument_type: 'futures', side: 'SHORT', expiry: '2026-11-26', mark_price: 1300 }), 'stoploss')
    expect(short.draft).toMatchObject({ side: 'BUY', type: 'STOPLOSS', price: '1339', instrument: 'futures', expiry: '2026-11-26' })
  })

  it('exiting a short buys it back and adding to a short sells more', () => {
    const shortFuture = position({ symbol: 'RELIND', instrument_type: 'futures', side: 'SHORT', expiry: '2026-11-26', mark_price: 1300 })
    expect(presetFor(shortFuture, 'exit').draft.side).toBe('BUY')
    expect(presetFor(shortFuture, 'buy_more').draft.side).toBe('SELL')
    expect(presetFor(position({}), 'buy_more').draft).toMatchObject({ side: 'BUY', quantity: '1' })
    expect(presetFor(position({}), 'buy_more').exitAll).toBeUndefined()
  })

  it('an option keeps its exact contract, and a missing price leaves the price empty', () => {
    const option = presetFor(position({ symbol: 'NIFTY', instrument_type: 'options', right: 'PE', strike: 24500, expiry: '2026-11-26', mark_price: null }), 'exit')
    expect(option.draft).toMatchObject({ instrument: 'options', right: 'PE', strike: '24500', expiry: '2026-11-26', price: '' })
    expect(option.lastPrice).toBeNull()
  })
})
