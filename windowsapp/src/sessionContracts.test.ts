import { describe, expect, it } from 'vitest'
import { requiredContracts, primaryLinkedScreen } from './sessionContracts'
import type { DesktopTradingSnapshot } from './contracts'

describe('shared session contracts and primary ownership', () => {
  it('restores each exposed strike and expiry, including unfilled orders, once', () => {
    const snapshot = { contracts: [{ contract_key: 'a', symbol: 'NIFTY', expiry: '2026-10-08', strike: 25000, right: 'CE' }],
      positions_by_contract: { a: { quantity: 65 } }, open_orders: [
        { symbol: 'NIFTY', expiry: '2026-10-08', strike: 25000, right: 'CE' },
        { symbol: 'NIFTY', expiry: '2026-10-15', strike: 25000, right: 'CE' },
        { symbol: 'NIFTY', expiry: '2026-10-08', strike: 25050, right: 'CE' }] } as unknown as DesktopTradingSnapshot
    expect(requiredContracts(snapshot)).toHaveLength(3)
    expect(requiredContracts(snapshot)[1].expiry).toBe('2026-10-15')
  })
  it('promotes earliest remaining linked tab without changing independent screens', () => {
    const primary = { id: 'p', saved: { linked_group_id: 's', linked_primary_id: 'p' } }
    const child = { id: 'c', saved: primary.saved }
    const other = { id: 'independent' }
    expect(primaryLinkedScreen(child, [primary, child, other])).toBe('p')
    expect(primaryLinkedScreen(child, [child, other])).toBe('c')
    expect(primaryLinkedScreen(other, [child, other])).toBe('independent')
  })
})
