import type { DesktopTradingSettings } from './contracts'

function percentage(settings: DesktopTradingSettings, key: string): number {
  if (!['l', 'm', 'h'].includes(key)) throw new Error('Select a sizing preset')
  const field = `${settings.desktop_order_size_mode === 'funds_ratio' ? 'funds' : 'risk'}_ratio_${key}_pct` as keyof DesktopTradingSettings
  const value = Number(settings[field])
  const max = settings.desktop_order_size_mode === 'funds_ratio' ? 1 : 100
  if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error('Invalid sizing percentage in shared settings')
  return value
}

export function ticketSizingPayload(settings: DesktopTradingSettings, key: string, quantity: () => number): Record<string, number> {
  if (settings.desktop_order_size_mode === 'funds_ratio') return { funds_ratio_pct: percentage(settings, key) }
  if (settings.desktop_order_size_mode === 'risk_ratio') return { risk_pct: percentage(settings, key) }
  if (settings.desktop_order_size_mode !== 'quantity') throw new Error('Invalid shared sizing mode')
  return { quantity: quantity() }
}

export type TicketSizingMode = DesktopTradingSettings['desktop_order_size_mode']
export const TICKET_SIZING_CHOICES: ReadonlyArray<readonly [TicketSizingMode, string, string]> = [
  ['quantity', 'Qty', 'Use fixed quantity for this order'],
  ['funds_ratio', 'Capital %', 'Use Capital % for this order'],
  ['risk_ratio', 'Risk %', 'Use Risk % for this order'],
]

/** Saved Low/Medium/High quantities (units: shares, or lots for options); same defaults as the server. */
export function ticketQuantityTiers(settings: DesktopTradingSettings): [number, number, number] {
  const tier = (value: number | undefined, fallback: number) => Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback
  return [tier(settings.quantity_l, 1), tier(settings.quantity_m, 2), tier(settings.quantity_h, 5)]
}

export function ticketSizingLabel(settings: DesktopTradingSettings, key: string): string {
  if (settings.desktop_order_size_mode === 'quantity') return `Qty ${key}`
  const capital = settings.desktop_order_size_mode === 'funds_ratio'
  const value = percentage(settings, key) * (capital ? 100 : 1)
  return `${capital ? 'Capital' : 'Risk'} ${Math.round(value * 100) / 100}%`
}

/** Change captured ticket settings only; shared settings stay unchanged. */
export function switchTicketSizing<T extends { settings: DesktopTradingSettings; sizeKey?: string }>(ticket: T, mode: TicketSizingMode): T {
  return { ...ticket, sizeKey: undefined, settings: { ...ticket.settings, desktop_order_size_mode: mode } }
}
