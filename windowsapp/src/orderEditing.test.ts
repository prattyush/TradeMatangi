import { describe, expect, it } from 'vitest'
import { availableExitQuantity, incrementValue } from './orderEditing'
import type { DesktopOrder } from './contracts'

const order = { order_id: 'edited', status: 'PENDING', symbol: 'BSESEN', right: 'CE', strike: 71700, expiry: '2026-10-08', side: 'SELL', quantity: 40, broker_filled_quantity: 20 } as DesktopOrder
describe('lot-aware editing', () => {
  it('increments one full lot, aligns off-grid input, and clamps', () => {
    expect(incrementValue('40', 1, 20, 20, 60)).toBe('60')
    expect(incrementValue('60', 1, 20, 20, 60)).toBe('60')
    expect(incrementValue('45', -1, 20, 20, 60)).toBe('40')
    expect(incrementValue('20', -1, 20, 20, 60)).toBe('20')
    expect(incrementValue('5', 1, 1, 1)).toBe('6')
  })
  it('uses quarter-rupee steps without rounding a directly typed finer price on save', () => {
    expect(incrementValue('100.25', 1, .25, .01)).toBe('100.5')
    expect(incrementValue('100.05', 1, .25, .01)).toBe('100.3')
  })
  it('counts only same-contract closing reservations and remaining fills', () => {
    const position = { symbol: 'BSESEN', side: 'LONG', quantity: 80, avg_entry_price: 100, entry_commission: 0 } as const
    const orders = [order, { ...order, order_id: 'other', quantity: 40 }, { ...order, order_id: 'other-strike', strike: 71800, quantity: 100 }, { ...order, order_id: 'entry', side: 'BUY' } as DesktopOrder]
    expect(availableExitQuantity(order, position, orders, order.order_id)).toBe(60)
    expect(availableExitQuantity(order, { ...position, side: 'FLAT' }, orders)).toBe(0)
  })
})
