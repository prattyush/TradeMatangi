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

// ── CE and PE each have their own strike ──────────────────────────────────────

export type OptionRight = 'CE' | 'PE'

/** How one side (CE or PE) picks its contract: a strike from the ladder, or the first strike whose premium is at or below a cap. */
export interface RightPick {
  mode: 'manual' | 'max_price'
  strike: number | null
  /** The premium cap in rupees; only used in Max Price mode. */
  cap: number | null
}

export const emptyPicks = (): Record<OptionRight, RightPick> => ({
  CE: { mode: 'manual', strike: null, cap: null },
  PE: { mode: 'manual', strike: null, cap: null },
})

/** Keep `current` while it is still listed; otherwise the strike in the middle of the ladder (nearest the money). */
export function keepStrike(current: number | null, ladder: number[]): number | null {
  if (!ladder.length) return current
  return current !== null && ladder.includes(current) ? current : ladder[Math.floor(ladder.length / 2)]
}

/** A premium cap typed by the user: a positive number, else null. */
export function parseCap(text: string): number | null {
  const value = Number(text.trim())
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null
}

/** The underlying's price at this time of day picks the strikes searched (as the ladder does), so Max Price uses the same moment. */
export const MAX_PRICE_REFERENCE_TIME = '09:30:00'
export const PREPARE_PATH = '/api/desktop/v1/trading/prepare-session'

/** Body for the server's session preparation, the same Max Price search the desktop picker uses (one option pane). */
export function maxPriceRequest(symbol: string, date: string, expiry: string, right: OptionRight, cap: number) {
  return {
    mode: 'browse', date, reference_time: MAX_PRICE_REFERENCE_TIME,
    panes: [{ id: 'browse', kind: 'option', symbol, interval: '3', tradingDate: date, expiry, strike: '', right, selection_mode: 'max_price', max_price: cap }],
  }
}

export interface PreparedPane { pane: { strike: string }; availability: 'available' | 'waiting' | 'unavailable' | 'error'; reason: string | null; premium: number | null }

/** The strike and premium the server found, or an Error carrying its reason. */
export function readMaxPrice(response: { panes?: PreparedPane[] } | null | undefined): { strike: number; premium: number | null } {
  const pane = response?.panes?.[0]
  if (!pane) throw new Error('The server returned no strike')
  const strike = Number(pane.pane?.strike)
  if ((pane.availability === 'available' || pane.availability === 'waiting') && Number.isFinite(strike) && strike > 0) return { strike, premium: pane.premium }
  throw new Error(pane.reason ?? 'No strike was found for this premium cap')
}
