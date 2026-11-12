import { describe, expect, it } from 'vitest'
import type { DesktopTradingSettings } from './contracts'
import { ticketQuantityTiers, ticketSizingLabel, ticketSizingPayload, switchTicketSizing } from './ticketSizing'

const settings = {
  desktop_order_size_mode: 'funds_ratio',
  funds_ratio_l_pct: .03, funds_ratio_m_pct: .06, funds_ratio_h_pct: .12,
  risk_ratio_l_pct: 1, risk_ratio_m_pct: 2, risk_ratio_h_pct: 4,
} as DesktopTradingSettings

describe('shared ticket sizing', () => {
  it('sends 12% capital without applying equity leverage in the renderer', () => {
    expect(ticketSizingPayload(settings, 'h', () => { throw new Error('quantity path') })).toEqual({ funds_ratio_pct: .12 })
    expect(ticketSizingLabel(settings, 'h')).toBe('Capital 12%')
  })
  it('keeps the captured capital setting when a later snapshot changes to risk', () => {
    const ticketSettings = { ...settings }
    const later = { ...settings, desktop_order_size_mode: 'risk_ratio' as const }
    expect(ticketSizingPayload(later, 'h', () => 1)).toEqual({ risk_pct: 4 })
    expect(ticketSizingPayload(ticketSettings, 'h', () => 1)).toEqual({ funds_ratio_pct: .12 })
    expect(ticketSizingLabel(later, 'h')).toBe('Risk 4%')
  })
  it('uses instrument quantity only in quantity mode', () => {
    expect(ticketSizingPayload({ ...settings, desktop_order_size_mode: 'quantity' }, '2', () => 100)).toEqual({ quantity: 100 })
  })
  it('rejects missing or invalid presets rather than silently using a different size', () => {
    expect(() => ticketSizingPayload(settings, '1', () => 1)).toThrow('preset')
    expect(() => ticketSizingPayload({ ...settings, funds_ratio_h_pct: 12 }, 'h', () => 1)).toThrow('percentage')
  })
})

describe('one-off ticket mode', () => {
  it('overrides presets without changing settings and resets the selection', () => {
    const shared = { ...settings, desktop_order_size_mode: 'risk_ratio' as const }
    const ticket = { settings: { ...shared }, sizeKey: 'h', orderType: 'LIMIT', slPrice: 90 }
    const capital = switchTicketSizing(ticket, 'funds_ratio')
    expect(capital.sizeKey).toBeUndefined()
    expect(capital.orderType).toBe('LIMIT')
    expect(capital.slPrice).toBe(90)
    expect(ticketSizingPayload(capital.settings, 'h', () => 1)).toEqual(ticketSizingPayload(settings, 'h', () => 1))
    expect(ticketSizingLabel(capital.settings, 'h')).toBe('Capital 12%')
    expect(shared.desktop_order_size_mode).toBe('risk_ratio')
    expect(ticket.sizeKey).toBe('h')
    expect(ticketSizingPayload({ ...shared }, 'h', () => 1)).toEqual({ risk_pct: 4 })
    const risk = switchTicketSizing({ ...capital, sizeKey: 'l' }, 'risk_ratio')
    expect(risk.sizeKey).toBeUndefined()
    expect(ticketSizingLabel(risk.settings, 'l')).toBe('Risk 1%')
    expect(ticketSizingPayload(risk.settings, 'l', () => 1)).toEqual({ risk_pct: 1 })
  })
})

describe('quantity as a one-off ticket choice', () => {
  const quantitySettings = { ...settings, quantity_l: 1, quantity_m: 3, quantity_h: 7 } as DesktopTradingSettings
  it('switches from capital or risk to quantity without changing the saved mode', () => {
    for (const from of ['funds_ratio', 'risk_ratio'] as const) {
      const shared = { ...quantitySettings, desktop_order_size_mode: from }
      const ticket = { settings: { ...shared }, sizeKey: 'h', orderType: 'LIMIT' }
      const quantity = switchTicketSizing(ticket, 'quantity')
      expect(quantity.sizeKey).toBeUndefined()
      expect(quantity.settings.desktop_order_size_mode).toBe('quantity')
      expect(ticket.settings.desktop_order_size_mode).toBe(from)
      expect(ticketSizingPayload(quantity.settings, '7', () => 7 * 75)).toEqual({ quantity: 525 })
      const back = switchTicketSizing(quantity, from)
      expect(ticketSizingPayload(back.settings, 'm', () => 1)).toEqual(from === 'funds_ratio' ? { funds_ratio_pct: .06 } : { risk_pct: 2 })
    }
  })
  it('reads the saved Low/Medium/High quantities and falls back to the server defaults', () => {
    expect(ticketQuantityTiers(quantitySettings)).toEqual([1, 3, 7])
    expect(ticketQuantityTiers(settings)).toEqual([1, 2, 5])
    expect(ticketQuantityTiers({ ...settings, quantity_l: 0, quantity_m: 2.5, quantity_h: undefined } as DesktopTradingSettings)).toEqual([1, 2, 5])
  })
  it('labels quantity buttons with their value', () => {
    expect(ticketSizingLabel({ ...settings, desktop_order_size_mode: 'quantity' }, '5')).toBe('Qty 5')
  })
})
