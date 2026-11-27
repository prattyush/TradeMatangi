/** Pure helpers of the Analysis Summary: the request query, wording, ordering, the deck's stepping and the daily chart's geometry. */
import { scoreBand, scoreModeName } from '../dayScore/model'
import type { PerformanceFilters } from '../performance'
import type { SummaryDay, SummaryNote, SummaryTrade } from './types'

/** The Stats filters the Summary understands (the route's `performance.filters`); anything else is left out. */
export const SUMMARY_FILTERS = ['start_date', 'end_date', 'created_from', 'created_to', 'session_type', 'client', 'symbol', 'instrument_type', 'direction'] as const

/** `?a=b&…` of the filled filters, or an empty string (empty values would be refused by the route). */
export function summaryQuery(filters: PerformanceFilters): string {
  const params = new URLSearchParams()
  for (const key of SUMMARY_FILTERS) if (filters[key]) params.set(key, filters[key])
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const money = (value: number | null | undefined) => (value == null ? '—' : `${value < 0 ? '−' : ''}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`)
export const percent = (value: number | null | undefined, digits = 2) => (value == null ? '—' : `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`)
export const tone = (value: number | null | undefined): 'pos' | 'neg' | 'flat' => (value == null || Math.abs(value) < 0.005 ? 'flat' : value > 0 ? 'pos' : 'neg')

export const longDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
export const shortDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
/** HH:MM of an epoch-second market wall clock (the data carries IST as UTC). */
export const clock = (seconds: number | null | undefined) => (seconds == null ? '' : new Date(seconds * 1000).toISOString().slice(11, 16))
export const modeName = (mode: string | null | undefined) => (mode === 'sim' ? 'Replay' : mode === 'stepwise' ? 'Stepwise' : mode === 'paper' ? 'Paper' : mode === 'real' ? 'Real' : mode ?? '')

/** "NIFTY 24500 CE · Long" */
export function tradeName(trade: SummaryTrade): string {
  const contract = [trade.symbol, trade.strike, trade.right].filter(part => part != null && part !== '').join(' ')
  return `${contract}${trade.direction ? ` · ${trade.direction === 'LONG' ? 'Long' : 'Short'}` : ''}`
}

/** The day's net P&L in rupees and as a percent of capital (the sum of its trades' percents). */
export const dayPnl = (day: SummaryDay) => ({ money: day.totals.net_pnl, pct: day.totals.pnl_pct })

/** The note parts that were written, in the order they are shown (the context first: it is what makes the day understood). */
export function noteParts(note: SummaryNote | null | undefined): Array<{ key: string; title: string; text: string }> {
  if (!note) return []
  const parts: Array<[string, string, string]> = [['context', 'Context', note.context], ['went_well', 'What went well', note.went_well], ['to_improve', 'To improve', note.to_improve], ['specific_points', 'Specific points', note.specific_points]]
  return parts.filter(([, , text]) => (text ?? '').trim()).map(([key, title, text]) => ({ key, title, text: text.trim() }))
}

/** "Replay 64, Paper 82": the day's stored scores in words (for hovers and labels). */
export const scoreWords = (day: Pick<SummaryDay, 'scores'>): string => day.scores.map(row => `${scoreModeName(row.mode)} ${row.score}`).join(', ')

/** The colour of a day on the deck's strip: its score band when it has a score, otherwise the sign of its P&L. */
export function stripTone(day: SummaryDay): 'good' | 'fair' | 'poor' | 'pos' | 'neg' | 'flat' {
  if (day.scores.length) return scoreBand(Math.round(day.scores.reduce((sum, row) => sum + row.score, 0) / day.scores.length))
  return tone(day.totals.net_pnl)
}

/** The days oldest first: the order a deck is gone through. The server sends them newest first. */
export const chronological = (days: readonly SummaryDay[]): SummaryDay[] => [...days].sort((a, b) => a.date.localeCompare(b.date))

/** The index a key press moves a deck to (`null` when the key means something else); never leaves the deck. */
export function deckStep(key: string, index: number, length: number): number | null {
  if (!length) return null
  const to = key === 'ArrowLeft' ? index - 1 : key === 'ArrowRight' ? index + 1 : key === 'Home' ? 0 : key === 'End' ? length - 1 : null
  return to === null ? null : Math.max(0, Math.min(length - 1, to))
}

/**
 * The symbol whose chart a day shows: the wanted one when the day has it, otherwise the first in alphabetical order (the order of the
 * day chart's tabs), so the daily chart and the day chart always agree.
 */
export function chartSymbol(day: SummaryDay, wanted?: string): string {
  const names = [...new Set(day.symbols.map(symbol => symbol.symbol))].sort((a, b) => a.localeCompare(b))
  return wanted && names.includes(wanted) ? wanted : names[0] ?? ''
}

/** What the headline over a list of days says. */
export function totalsOf(days: readonly SummaryDay[]) {
  return { days: days.length, trades: days.reduce((sum, day) => sum + day.totals.trades, 0), net_pnl: days.reduce((sum, day) => sum + day.totals.net_pnl, 0),
    winning_days: days.filter(day => day.totals.net_pnl > 0.005).length, losing_days: days.filter(day => day.totals.net_pnl < -0.005).length }
}

// ── The small daily chart ────────────────────────────────────────────────────

export interface DailyCandle { timestamp: number; open: number; high: number; low: number; close: number }
export interface DailyBar { x: number; wickTop: number; wickBottom: number; bodyTop: number; bodyBottom: number; up: boolean; highlighted: boolean; date: string }

/** The raw candles of `browse/history` as daily candles, oldest first, ending at the day itself (nothing after it). */
export function dailyCandles(raw: ReadonlyArray<{ time?: number; timestamp?: number; open: number; high: number; low: number; close: number }>, date: string, count = 90): DailyCandle[] {
  const candles = raw.map(c => ({ timestamp: c.timestamp ?? c.time ?? 0, open: c.open, high: c.high, low: c.low, close: c.close }))
    .filter(c => c.timestamp > 0 && [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.timestamp - b.timestamp)
  const until = candles.filter(c => new Date(c.timestamp * 1000).toISOString().slice(0, 10) <= date)
  return until.slice(-count)
}

/** Bars of a daily chart in a `width` by `height` box (the price axis fitted to the candles, a little padding). */
export function dailyGeometry(candles: readonly DailyCandle[], date: string, width: number, height: number, pad = 4): { bars: DailyBar[]; low: number; high: number; step: number } {
  if (!candles.length) return { bars: [], low: 0, high: 0, step: 0 }
  const low = Math.min(...candles.map(c => c.low)), high = Math.max(...candles.map(c => c.high))
  const range = high - low || 1
  const y = (price: number) => pad + (1 - (price - low) / range) * (height - 2 * pad)
  const step = (width - 2 * pad) / candles.length
  const bars = candles.map((c, index) => ({
    x: pad + step * (index + 0.5), wickTop: y(c.high), wickBottom: y(c.low), bodyTop: y(Math.max(c.open, c.close)), bodyBottom: y(Math.min(c.open, c.close)),
    up: c.close >= c.open, highlighted: new Date(c.timestamp * 1000).toISOString().slice(0, 10) === date, date: new Date(c.timestamp * 1000).toISOString().slice(0, 10),
  }))
  return { bars, low, high, step }
}
