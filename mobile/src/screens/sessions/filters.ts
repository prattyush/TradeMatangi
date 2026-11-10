/** Session filters. Every request is date-bounded: the sessions endpoint has no pagination. */

export type RangePreset = '7d' | '30d' | '90d' | '1y' | 'custom'

export interface SessionFilters {
  range: RangePreset
  /** Used when range is "custom" (YYYY-MM-DD). */
  start: string
  end: string
  style: '' | 'intraday' | 'swing'
  /** The server's session types: sim (replay), stepwise, paper, real. */
  mode: '' | 'sim' | 'stepwise' | 'paper' | 'real'
  symbol: string
  instrument: '' | 'equity' | 'options'
}

export const DEFAULT_FILTERS: SessionFilters = { range: '30d', start: '', end: '', style: '', mode: '', symbol: '', instrument: '' }

export const RANGE_LABELS: Record<Exclude<RangePreset, 'custom'>, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '1y': '1 year' }
const RANGE_DAYS: Record<Exclude<RangePreset, 'custom'>, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }
/** A custom range may not be wider than this, so the list stays a sensible size. */
export const MAX_CUSTOM_DAYS = 400

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** Start and end dates to send to the server for the current range, relative to `today` (the device's local date). */
export function rangeDates(filters: SessionFilters, today: Date = new Date()): { startDate: string; endDate: string } {
  if (filters.range === 'custom') return { startDate: filters.start, endDate: filters.end || iso(today) }
  const start = new Date(today)
  start.setDate(start.getDate() - RANGE_DAYS[filters.range])
  return { startDate: iso(start), endDate: iso(today) }
}

/** Why a custom range cannot be used, or null when it is fine. */
export function customRangeProblem(filters: SessionFilters): string | null {
  if (filters.range !== 'custom') return null
  if (!filters.start) return 'Pick a start date.'
  const start = Date.parse(`${filters.start}T00:00:00Z`)
  const end = Date.parse(`${(filters.end || iso(new Date()))}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return 'Enter valid dates.'
  if (end < start) return 'The end date is before the start date.'
  if ((end - start) / 86_400_000 > MAX_CUSTOM_DAYS) return `Choose at most ${MAX_CUSTOM_DAYS} days.`
  return null
}

/** How many filters differ from the default, for the badge on the Filters button. */
export function activeFilterCount(filters: SessionFilters): number {
  let count = 0
  if (filters.range !== DEFAULT_FILTERS.range) count++
  if (filters.style) count++
  if (filters.mode) count++
  if (filters.symbol) count++
  if (filters.instrument) count++
  return count
}

export function describeRange(filters: SessionFilters): string {
  if (filters.range === 'custom') return `${filters.start || '…'} to ${filters.end || 'today'}`
  return `Last ${RANGE_LABELS[filters.range]}`
}
