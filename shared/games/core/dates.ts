/** Calendar-date helpers on `YYYY-MM-DD` strings. They use UTC arithmetic so a daylight-saving change never skips or repeats a day. */
const toUtc = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export const isDateString = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)

export function shiftDate(date: string, days: number): string {
  const shifted = new Date(toUtc(date) + days * 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((toUtc(to) - toUtc(from)) / 86_400_000)
