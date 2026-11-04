import type { Unit } from './habitStats'

export const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
export const fmtPct = (n: number | null | undefined, digits = 2) => (n == null ? '—' : `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}%`)
export const fmtSigned = (n: number | null | undefined, unit: Unit) =>
  n == null ? '—' : unit === 'pct' ? `${n > 0 ? '+' : ''}${fmtPct(n)}` : `${n > 0 ? '+' : ''}${fmtMoney(n)}`
export const fmtValue = (n: number | null | undefined, unit: Unit) => (unit === 'pct' ? fmtPct(n) : fmtMoney(n))
export const fmtNumber = (n: number | null | undefined, digits = 1) => (n == null ? '—' : n.toFixed(digits))
export const fmtShare = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(0)}%`)

/** 95 s → "1m 35s"; 3 700 s → "1h 2m". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  const total = Math.round(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** CSS tint class from the sign of a value (positive = good). */
export const tint = (n: number | null | undefined) => (n == null || n === 0 ? '' : n > 0 ? 'positive' : 'negative')
