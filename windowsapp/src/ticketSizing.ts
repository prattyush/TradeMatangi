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

export function ticketSizingLabel(settings: DesktopTradingSettings, key: string): string {
  if (settings.desktop_order_size_mode === 'quantity') return key
  const capital = settings.desktop_order_size_mode === 'funds_ratio'
  const value = percentage(settings, key) * (capital ? 100 : 1)
  return `${capital ? 'Capital' : 'Risk'} ${Math.round(value * 100) / 100}%`
}

/** Change captured ticket settings only; shared settings stay unchanged. */
export function switchTicketSizing<T extends { settings: DesktopTradingSettings; sizeKey?: string }>(ticket: T, mode: 'risk_ratio' | 'funds_ratio'): T {
  return { ...ticket, sizeKey: undefined, settings: { ...ticket.settings, desktop_order_size_mode: mode } }
}
