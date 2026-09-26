import { describe, expect, it } from 'vitest'
import type { DesktopTradingSnapshot } from './contracts'
import { entryQuantity, equityEntryEnabled, instrumentLotSize, validateEntryStop } from './tradingInstrument'

const snapshot = { session: { symbol: 'TATPOW', instrument_type: 'equity', state: 'running', lot_size: 1 }, option_lot_size: 2700 } as DesktopTradingSnapshot

describe('desktop equity and attached option entry', () => {
  it('allows equity entry only for the active session underlying', () => {
    expect(equityEntryEnabled('spot', 'TATPOW', snapshot)).toBe(true)
    expect(equityEntryEnabled('spot', 'RELIND', snapshot)).toBe(false)
    expect(equityEntryEnabled('spot', 'TATPOW', null)).toBe(false)
    expect(equityEntryEnabled('spot', 'TATPOW', { ...snapshot, session: { ...snapshot.session, instrument_type: 'options' } })).toBe(false)
    expect(equityEntryEnabled('spot', 'TATPOW', { ...snapshot, session: { ...snapshot.session, state: 'ended' } })).toBe(false)
  })
  it('sizes attached options by their own lot size and equity by shares', () => {
    expect(instrumentLotSize('spot', snapshot)).toBe(1)
    expect(entryQuantity('spot', '125', snapshot)).toBe(125)
    expect(entryQuantity('option', '2', snapshot)).toBe(5400)
    expect(() => entryQuantity('spot', '1.5', snapshot)).toThrow()
    expect(() => entryQuantity('spot', '0', snapshot)).toThrow()
  })
  it('validates opposite stop directions for long and short trades', () => {
    expect(() => validateEntryStop('BUY', 100, 99)).not.toThrow()
    expect(() => validateEntryStop('SELL', 100, 101)).not.toThrow()
    expect(() => validateEntryStop('BUY', 100, 101)).toThrow('below')
    expect(() => validateEntryStop('SELL', 100, 99)).toThrow('above')
    expect(() => validateEntryStop('SELL', 100, 100)).toThrow()
  })
})
