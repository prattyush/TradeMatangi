import { finite, pick, totals, type StatMode, type Unit } from './habitStats'
import type { LedgerTrade } from './types'

/**
 * Deep-dive statistics for one habit: results broken down by how long the trades lasted, how much capital they used,
 * when they were taken, and the points/rows behind them. Pure functions over ledger rows.
 */

export interface BucketRow {
  key: string
  label: string
  count: number
  /** Net result of the bucket (% of capital or ₹, per the unit). */
  net: number | null
  win_pct: number | null
  /** Typical trade (mean or median per the mode). */
  average: number | null
  /** Trades in the bucket with a usable P&L (the denominator of net / average). */
  measured: number
}

function bucketRow(key: string, label: string, trades: LedgerTrade[], unit: Unit, mode: StatMode): BucketRow {
  const t = totals(trades)
  const pct = unit === 'pct'
  return {
    key, label, count: trades.length,
    net: pct ? (t.pct_trades ? t.net_pct : null) : t.net_pnl,
    win_pct: t.win_pct,
    average: pct ? pick(t.pct, mode) : pick(t.pnl, mode),
    measured: pct ? t.pct_trades : trades.length,
  }
}

/** Groups trades with `classify`, in the order of `order`; groups with no trade are left out (except `keepEmpty`). */
function group(trades: LedgerTrade[], order: Array<[string, string]>, classify: (trade: LedgerTrade) => string | null, unit: Unit, mode: StatMode, keepEmpty = false): BucketRow[] {
  const buckets = new Map<string, LedgerTrade[]>()
  for (const trade of trades) {
    const key = classify(trade)
    if (key != null) buckets.set(key, [...(buckets.get(key) ?? []), trade])
  }
  return order
    .filter(([key]) => keepEmpty || buckets.has(key))
    .map(([key, label]) => bucketRow(key, label, buckets.get(key) ?? [], unit, mode))
}

// ── Bars held ────────────────────────────────────────────────────────────────

const BAR_BUCKETS: Array<[string, string]> = [['1', '1 bar'], ['2', '2 bars'], ['3-5', '3–5 bars'], ['6-10', '6–10 bars'], ['11+', 'Over 10 bars'], ['unknown', 'Unknown']]

export function barsBucket(bars: number | null): string {
  if (!finite(bars)) return 'unknown'
  return bars <= 1 ? '1' : bars === 2 ? '2' : bars <= 5 ? '3-5' : bars <= 10 ? '6-10' : '11+'
}

/** Results by candles held; "1 bar" is entering and exiting inside the same candle. */
export const barBuckets = (trades: LedgerTrade[], unit: Unit, mode: StatMode): BucketRow[] => group(trades, BAR_BUCKETS, t => barsBucket(t.bars), unit, mode)

// ── Capital % ────────────────────────────────────────────────────────────────

/** Linear-interpolated quantile (0..1) of the finite values; null when there are none. */
export function quantile(values: Array<number | null | undefined>, q: number): number | null {
  const rows = values.filter(finite).sort((a, b) => a - b)
  if (!rows.length) return null
  const position = (rows.length - 1) * Math.min(1, Math.max(0, q))
  const low = Math.floor(position), high = Math.ceil(position)
  return rows[low] + (rows[high] - rows[low]) * (position - low)
}

export const MIN_TERCILE_TRADES = 6

export interface CapitalSplit { low: number; high: number }

/** Tercile edges of the capital % of ALL trades in scope (the user's own distribution), or null when there are too few to split. */
export function capitalEdges(scope: LedgerTrade[]): CapitalSplit | null {
  const known = scope.map(t => t.capital_pct).filter(finite)
  if (known.length < MIN_TERCILE_TRADES) return null
  const low = quantile(known, 1 / 3) as number, high = quantile(known, 2 / 3) as number
  return low < high ? { low, high } : null
}

export function capitalBucket(capital: number | null, edges: CapitalSplit): string {
  if (!finite(capital)) return 'unknown'
  return capital <= edges.low ? 'low' : capital <= edges.high ? 'medium' : 'high'
}

/** Results by how much capital the trade used, in thirds of your own trades (null when there are too few to split). */
export function capitalBuckets(habitTrades: LedgerTrade[], scope: LedgerTrade[], unit: Unit, mode: StatMode): { edges: CapitalSplit; rows: BucketRow[] } | null {
  const edges = capitalEdges(scope)
  if (!edges) return null
  const fmt = (n: number) => `${n.toFixed(1)}%`
  const order: Array<[string, string]> = [['low', `Smaller (up to ${fmt(edges.low)})`], ['medium', `Middle (${fmt(edges.low)} – ${fmt(edges.high)})`], ['high', `Larger (over ${fmt(edges.high)})`], ['unknown', 'Unknown']]
  return { edges, rows: group(habitTrades, order, t => capitalBucket(t.capital_pct, edges), unit, mode) }
}

// ── Time of day and weekday ──────────────────────────────────────────────────

/** Entry times are IST wall-clock encoded as UTC epoch seconds. */
export function halfHour(entryTime: number): { key: string; label: string } {
  const minutes = Math.floor(entryTime / 60) % (24 * 60)
  const start = minutes - (minutes % 30)
  const hhmm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return { key: hhmm(start), label: `${hhmm(start)}–${hhmm(start + 30)}` }
}

export function timeBuckets(trades: LedgerTrade[], unit: Unit, mode: StatMode): BucketRow[] {
  const order = new Map<string, string>()
  for (const trade of trades) { const { key, label } = halfHour(trade.entry_time); order.set(key, label) }
  const sorted = [...order.entries()].sort(([a], [b]) => a.localeCompare(b))
  return group(trades, sorted, t => halfHour(t.entry_time).key, unit, mode)
}

const WEEKDAYS: Array<[string, string]> = [['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday'], ['0', 'Sunday']]
export const weekdayOf = (date: string): string => String(new Date(`${date}T00:00:00Z`).getUTCDay())
export const weekdayBuckets = (trades: LedgerTrade[], unit: Unit, mode: StatMode): BucketRow[] => group(trades, WEEKDAYS, t => weekdayOf(t.date), unit, mode)

// ── Quick losses ─────────────────────────────────────────────────────────────

export interface QuickLosses {
  losers: number
  /** Losers with a known bar count (the denominator of `quick_pct`). */
  known: number
  quick: number
  /** Share of the losing trades closed within one candle. */
  quick_pct: number | null
  /** Part of the habit's total loss % that came from those quick losers. */
  quick_loss_share: number | null
  quick_loss: number
}

/** Losing trades closed within a single candle — the "exited at a loss, within the same bar" view. */
export function quickLosses(trades: LedgerTrade[], unit: Unit): QuickLosses {
  const value = (t: LedgerTrade) => (unit === 'pct' ? t.pnl_pct : t.net_pnl)
  const losers = trades.filter(t => t.net_pnl < -0.005)
  const known = losers.filter(t => finite(t.bars))
  const quick = known.filter(t => (t.bars as number) <= 1)
  const total = losers.map(value).filter(finite).reduce((a, b) => a + b, 0)
  const quickTotal = quick.map(value).filter(finite).reduce((a, b) => a + b, 0)
  return {
    losers: losers.length,
    known: known.length,
    quick: quick.length,
    quick_pct: known.length ? (100 * quick.length) / known.length : null,
    quick_loss_share: total < 0 ? (100 * quickTotal) / total : null,
    quick_loss: quickTotal,
  }
}

// ── Scatter and trade list ───────────────────────────────────────────────────

export interface ScatterPoint { x: number; y: number; trade: LedgerTrade; /** 0 = oldest trade, 1 = most recent. */ recency: number }

/** Capital % against the result of each trade; oldest-to-newest `recency` colours "smaller size lately". */
export function scatterPoints(trades: LedgerTrade[], unit: Unit): ScatterPoint[] {
  const ordered = [...trades].sort((a, b) => a.entry_time - b.entry_time || a.cycle_id.localeCompare(b.cycle_id))
  const last = Math.max(1, ordered.length - 1)
  const points: ScatterPoint[] = []
  ordered.forEach((trade, index) => {
    const y = unit === 'pct' ? trade.pnl_pct : trade.net_pnl
    if (finite(trade.capital_pct) && finite(y)) points.push({ x: trade.capital_pct, y, trade, recency: index / last })
  })
  return points
}

export type TradeSort = 'date' | 'pnl' | 'capital' | 'risk' | 'bars' | 'held' | 'entries' | 'exits'

const sortValue = (trade: LedgerTrade, key: TradeSort, unit: Unit): number | null => {
  switch (key) {
    case 'date': return trade.entry_time
    case 'pnl': return unit === 'pct' ? trade.pnl_pct : trade.net_pnl
    case 'capital': return trade.capital_pct
    case 'risk': return trade.risk_pct
    case 'bars': return trade.bars
    case 'held': return trade.holding_seconds
    case 'entries': return trade.entries
    case 'exits': return trade.exits
  }
}

/** Sorts trades by a column; trades without a value always go last. */
export function sortTrades(trades: LedgerTrade[], key: TradeSort, direction: 'asc' | 'desc', unit: Unit): LedgerTrade[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...trades].sort((a, b) => {
    const left = sortValue(a, key, unit), right = sortValue(b, key, unit)
    if (!finite(left) && !finite(right)) return a.entry_time - b.entry_time
    if (!finite(left)) return 1
    if (!finite(right)) return -1
    return factor * (left - right) || a.entry_time - b.entry_time
  })
}
