/** The instruments Browse can chart, as `GET /api/desktop/v1/catalogue` lists them. */
export interface Instrument {
  symbol: string
  display_name: string
  exchange?: string
  chart_type?: string
  option_eligible?: boolean
  supported_intervals?: number[]
}

/** `GET /api/desktop/v1/option-metadata`: the expiry to use on a day and the gap between strikes. */
export interface OptionMetadata {
  symbol: string
  as_of_date: string
  expiries: string[]
  strike_interval: number
  available: boolean
  unavailable_reason?: string | null
}

export const FALLBACK_INSTRUMENTS: Instrument[] = [
  { symbol: 'NIFTY', display_name: 'NIFTY 50', exchange: 'NSE', chart_type: 'index', option_eligible: true, supported_intervals: [1, 3, 5, 15, 30, 60] },
]

const DAY_MS = 86_400_000
const toUtc = (iso: string) => new Date(`${iso}T00:00:00Z`)
const toIso = (date: Date) => date.toISOString().slice(0, 10)
const isValidIso = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(toUtc(iso).getTime()) && toIso(toUtc(iso)) === iso

export function isWeekday(iso: string): boolean {
  if (!isValidIso(iso)) return false
  const day = toUtc(iso).getUTCDay()
  return day !== 0 && day !== 6
}

/** The next (+1) or previous (-1) weekday. Exchange holidays are not known here: the server answers for those days. */
export function shiftTradingDay(iso: string, direction: 1 | -1): string {
  let date = toUtc(iso)
  do { date = new Date(date.getTime() + direction * DAY_MS) } while (date.getUTCDay() === 0 || date.getUTCDay() === 6)
  return toIso(date)
}

/** Local calendar date of `now` as YYYY-MM-DD. */
export function localIso(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** The last completed trading day: yesterday, or the Friday before a weekend. Today is excluded (its data is still forming). */
export function latestBrowseDate(now: Date = new Date()): string {
  return shiftTradingDay(localIso(now), -1)
}

/** "Mon 9 Nov" for the date button. */
export function formatBrowseDate(iso: string): string {
  if (!isValidIso(iso)) return iso
  return toUtc(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '')
}

/** Indices first, then equities, each in catalogue order; matches symbol or name, any case. An empty query lists all. */
export function searchInstruments(list: Instrument[], query: string): Instrument[] {
  const text = query.trim().toLowerCase()
  const hits = text ? list.filter(item => `${item.symbol} ${item.display_name}`.toLowerCase().includes(text)) : list
  const isIndex = (item: Instrument) => item.chart_type === 'index' || item.symbol === 'NIFTY' || item.symbol === 'BSESEN'
  return [...hits.filter(isIndex), ...hits.filter(item => !isIndex(item))]
}

/** The listed strike nearest a price. */
export function nearestStrike(price: number, interval: number): number {
  return interval > 0 ? Math.round(price / interval) * interval : price
}

/** Strikes to choose from: `each` steps either side of the strike nearest `price`, lowest first. */
export function strikeLadder(price: number, interval: number, each = 21): number[] {
  if (!(price > 0) || !(interval > 0)) return []
  const center = nearestStrike(price, interval)
  const strikes: number[] = []
  for (let step = -each; step <= each; step++) {
    const strike = center + step * interval
    if (strike > 0) strikes.push(strike)
  }
  return strikes
}

export const RECENTS_KEY = 'tm.browse.recent'
const MAX_RECENTS = 6

/** Put `symbol` first in the recent list (no duplicates, at most six). */
export function withRecent(recents: string[], symbol: string): string[] {
  return [symbol, ...recents.filter(item => item !== symbol)].slice(0, MAX_RECENTS)
}
