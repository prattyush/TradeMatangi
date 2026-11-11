import type { PendingOrder, Position } from './swingTypes'

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const inrWhole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

export const price = (value: number | null | undefined): string => (value == null || !Number.isFinite(value) ? '—' : inr.format(value))
export const rupees = (value: number | null | undefined): string => (value == null || !Number.isFinite(value) ? '—' : `₹${inrWhole.format(Math.round(value))}`)
/** Signed money; `null` means the price is missing, never 0. */
export function signedRupees(value: number | null | undefined, whole = true): string {
  if (value == null || !Number.isFinite(value)) return 'Waiting for prices'
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}₹${(whole ? inrWhole : inr).format(Math.abs(whole ? Math.round(value) : value))}`
}
export const signedPct = (value: number | null | undefined): string =>
  value == null || !Number.isFinite(value) ? '' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`
export const tone = (value: number | null | undefined): 'pos' | 'neg' | 'flat' => (value == null || value === 0 ? 'flat' : value > 0 ? 'pos' : 'neg')

type Contract = { symbol: string; instrument_type?: string; right?: string | null; strike?: number | null; expiry?: string | null }

/** "HDFCBANK", "NIFTY 26 Nov 24500 CE", "RELIND FUT 26 Nov". */
export function contractName(item: Contract): string {
  const date = item.expiry ? shortDate(item.expiry) : ''
  if (item.instrument_type === 'options') return `${item.symbol} ${date} ${item.strike} ${item.right}`
  if (item.instrument_type === 'futures') return `${item.symbol} FUT ${date}`
  return item.symbol
}

/** "2026-11-26" -> "26 Nov", read as written (no timezone shift). */
export function shortDate(iso: string): string {
  const [, month, day] = iso.split('-').map(Number)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return month && day ? `${String(day).padStart(2, '0')} ${months[month - 1]}` : iso
}

export const sideWord = (position: Pick<Position, 'side'>): string => (position.side === 'SHORT' ? 'Short' : 'Long')

export function quoteNote(position: Position): string {
  if (position.mark_price == null || position.quote_status === 'unavailable') return 'no price'
  return position.quote_status === 'live' ? 'live' : 'last known'
}

export function orderSummary(order: PendingOrder): string {
  const filled = order.broker_filled_quantity ?? order.filled_quantity ?? 0
  const kind = order.order_type === 'STOPLOSS' ? 'Stoploss' : order.order_type === 'TARGET' ? 'Target' : 'Limit'
  const level = order.order_type === 'LIMIT' ? order.limit_price : order.trigger_price
  return `${order.side === 'BUY' ? 'Buy' : 'Sell'} ${order.quantity}${filled ? ` (${filled} filled)` : ''} · ${kind} ${price(level)}`
}

/** Seconds since the last update as short text ("just now", "12 s ago", "3 min ago"). */
export function ageText(updatedAt: number | null, now: number): string {
  if (updatedAt == null) return 'not updated yet'
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000))
  return seconds < 5 ? 'just now' : seconds < 90 ? `${seconds} s ago` : `${Math.round(seconds / 60)} min ago`
}
