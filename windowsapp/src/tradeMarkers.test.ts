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
      { id: 't1', timestamp: 1746522900, price: 123.45, text: '', color: '#FFFFFF' },
    ])
  })

  it.each(['CE', 'PE'] as const)('keeps %s buy/sell colors without text', right => {
    const markers = buildTradeMarkers([
      trade({ right, strike: 24000 }),
      trade({ trade_id: 'sell', right, strike: 24000, side: 'SELL' }),
    ], { kind: 'option', right, strike: 24000 }, 180)
    expect(markers.map(marker => [marker.color, marker.text])).toEqual([['#FFFFFF', ''], ['#00AAFF', '']])
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

  it('shows only open-position markers when historical markers are hidden', () => {
    expect(buildTradeMarkers([
      trade({ trade_id: 'closed', right: 'CE', strike: 24000, is_open: false }),
      trade({ trade_id: 'open', right: 'CE', strike: 24000, timestamp: 1746523179, is_open: true }),
    ], { kind: 'option', right: 'CE', strike: 24000 }, 180, false)).toEqual([
      { id: 'open', timestamp: 1746523080, price: 123.45, text: '', color: '#FFFFFF' },
    ])
  })
})

it('matches Futures expiry and keeps Futures prices off underlying charts', () => {
  const rows = [trade({ instrument_type: 'futures', expiry: '2026-10-27' }), trade({trade_id:'next',instrument_type:'futures',expiry:'2026-11-24'})]
  expect(buildTradeMarkers(rows,{kind:'future',underlying:'NIFTY',expiry:'2026-10-27'},180).map(m=>m.id)).toEqual(['t1'])
  expect(buildTradeMarkers(rows,{kind:'index',symbol:'NIFTY'},180)).toEqual([])
})
