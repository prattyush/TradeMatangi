import { describe, expect, it } from 'vitest'
import { buildTradeMarkers } from './tradeMarkers'
import type { DesktopTrade } from './contracts'

const trade = (overrides: Partial<DesktopTrade>): DesktopTrade => ({
  trade_id: 't1', symbol: 'NIFTY', side: 'BUY', quantity: 50, price: 123.45, timestamp: 1746522999,
  ...overrides,
})

describe('desktop trade markers', () => {
  it('uses the exact filled price on the matching option chart', () => {
    expect(buildTradeMarkers([
      trade({ right: 'CE', strike: 24000 }),
      trade({ trade_id: 't2', right: 'PE', strike: 24000, price: 234.56 }),
    ], { kind: 'option', right: 'CE', strike: 24000 }, 180)).toEqual([
      { id: 't1', timestamp: 1746522900, price: 123.45, text: 'B', color: '#FFFFFF' },
    ])
  })

  it('uses website buy/sell colors and labels for underlying option markers', () => {
    expect(buildTradeMarkers([
      trade({ right: 'CE', strike: 24000, underlying_price: 23123.4 }),
      trade({ trade_id: 't2', side: 'SELL', right: 'PE', strike: 24000, underlying_price: 23124.5 }),
      trade({ trade_id: 't3', side: 'SELL', price: 23125.6 }),
    ], { kind: 'index' }, 180)).toEqual([
      { id: 't1', timestamp: 1746522900, price: 23123.4, text: 'CB', color: '#FFFFFF' },
      { id: 't2', timestamp: 1746522900, price: 23124.5, text: 'PB', color: '#FFFFFF' },
      { id: 't3', timestamp: 1746522900, price: 23125.6, text: 'S', color: '#00AAFF' },
    ])
  })

  it('does not create an underlying marker without an underlying fill snapshot', () => {
    expect(buildTradeMarkers([trade({ right: 'CE', strike: 24000 })], { kind: 'equity' }, 180)).toEqual([])
  })
})
