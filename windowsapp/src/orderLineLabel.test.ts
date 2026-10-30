import { describe, expect, it } from 'vitest'
import { orderLineLabel } from './orderLineLabel'
import type { DesktopOrder, DesktopPosition, DesktopTradingSettings } from './contracts'

const position = { side: 'LONG', quantity: 100, avg_entry_price: 100, entry_commission: 0 } as DesktopPosition
const order = (extra: Partial<DesktopOrder> = {}) => ({ side: 'SELL', order_type: 'STOPLOSS', quantity: 40, trigger_price: 95, limit_price: 0, is_stoploss: true, ...extra }) as DesktopOrder
const percent = { desktop_pnl_display_mode: 'percent' } as DesktopTradingSettings
const value = { desktop_pnl_display_mode: 'value' } as DesktopTradingSettings

describe('orderLineLabel', () => {
  it('shows order, whole-position and session P&L in percent mode', () => {
    expect(orderLineLabel(order(), position, percent, 20000, 110, 1000, 0)).toBe('SL 40 -1.0% | -2.5% | -2.6%')
  })
  it('drops the session figure without a price or total, and in compact mode', () => {
    expect(orderLineLabel(order(), position, percent, 20000)).toBe('SL 40 -1.0% | -2.5%')
    expect(orderLineLabel(order(), position, percent, 20000, 110, 1000, 0, true)).toBe('SL 40 -1.0%')
  })
  it('uses currency in value mode and handles shorts', () => {
    expect(orderLineLabel(order({ order_type: 'LIMIT', is_stoploss: false, limit_price: 110, quantity: 100 }), position, value, 20000)).toBe('L +1000 | +1000')
    const short = { ...position, side: 'SHORT', quantity: 50 } as DesktopPosition
    expect(orderLineLabel(order({ side: 'BUY', quantity: 25, trigger_price: 110 }), short, percent, 10000)).toBe('SL 25 -2.5% | -5.0%')
  })
  it('keeps the plain label for non-exit orders', () => {
    expect(orderLineLabel(order({ side: 'BUY', order_type: 'LIMIT', quantity: 75 }), position, percent, 20000)).toBe('BL 75')
  })
})
