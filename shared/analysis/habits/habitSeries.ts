import { finite, mean, median, type StatMode, type Unit, type Verdict } from './habitStats'
import type { LedgerTrade } from './types'

/**
 * Across-days statistics for the Habits view: per-day series, rolling means, period comparison and
 * days-with-vs-without. Pure functions over the ledger rows.
 */

// ── Days and periods ─────────────────────────────────────────────────────────

/** Every trading day that has a closed trade in the ledger (the chart axis), oldest first. */
export const tradingDays = (trades: LedgerTrade[]): string[] => [...new Set(trades.map(t => t.date))].sort()

export interface Period { start: string; end: string; days: string[] }

const periodOf = (days: string[], start: string, end: string): Period => ({ start, end, days: days.filter(d => d >= start && d <= end) })

/** The last `n` trading days (recent) and the `n` before them (before); null when there is nothing before. */
export function lastPeriods(days: string[], n: number): { before: Period; recent: Period } | null {
  if (n < 1 || days.length <= n) return null
  const recentDays = days.slice(-n)
  const beforeDays = days.slice(Math.max(0, days.length - 2 * n), days.length - n)
  return {
    recent: { start: recentDays[0], end: recentDays[recentDays.length - 1], days: recentDays },
    before: { start: beforeDays[0], end: beforeDays[beforeDays.length - 1], days: beforeDays },
  }
}

/** Two custom inclusive date ranges; null when either contains no trading day. */
export function customPeriods(days: string[], before: [string, string], recent: [string, string]): { before: Period; recent: Period } | null {
  const a = periodOf(days, ...before), b = periodOf(days, ...recent)
  return a.days.length && b.days.length ? { before: a, recent: b } : null
}

export const tradesIn = (trades: LedgerTrade[], period: Period): LedgerTrade[] => trades.filter(t => t.date >= period.start && t.date <= period.end)

// ── Per-day series ───────────────────────────────────────────────────────────

export type SeriesMetric = 'occurrences' | 'net' | 'loss' | 'profit' | 'capital' | 'bars' | 'within_1' | 'entries' | 'exits'

/**
 * How a metric behaves on a day the habit did not occur:
 * `zero` — counts and sums plot 0; `gap` — averages and shares have no value (a gap, never 0).
 */
export const SERIES_METRICS: Record<SeriesMetric, { label: string; empty: 'zero' | 'gap'; help: string }> = {
  occurrences: { label: 'Occurrences', empty: 'zero', help: 'Trades per day that carry the habit' },
  net: { label: 'Net', empty: 'zero', help: 'Profit and loss of the habit’s trades that day, added together' },
  loss: { label: 'Loss', empty: 'zero', help: 'Total of the habit’s losing trades that day (0 = none)' },
  profit: { label: 'Profit', empty: 'zero', help: 'Total of the habit’s winning trades that day' },
  capital: { label: 'Capital %', empty: 'gap', help: 'Capital deployed on the habit’s trades that day (average or median)' },
  bars: { label: 'Bars held', empty: 'gap', help: 'Candles the habit’s trades lasted (average or median)' },
  within_1: { label: 'Closed within 1 bar', empty: 'gap', help: 'Share of the habit’s trades closed inside the candle they were entered in' },
  entries: { label: 'Entries per trade', empty: 'gap', help: 'Entry orders per habit trade (average or median)' },
  exits: { label: 'Exits per trade', empty: 'gap', help: 'Exit orders per habit trade (average or median)' },
}

export const hasQuestion = (trade: LedgerTrade, questionId: string) => trade.habits.includes(questionId)

const sumOf = (values: Array<number | null>) => values.filter(finite).reduce((total, value) => total + value, 0)
const central = (values: Array<number | null>, mode: StatMode) => (mode === 'mean' ? mean(values) : median(values))

/** The metric's value over a set of trades (one habit, one day or one period); null when it does not exist. */
export function metricOver(trades: LedgerTrade[], metric: SeriesMetric, unit: Unit, mode: StatMode): number | null {
  const losses = trades.filter(t => t.net_pnl < -0.005), wins = trades.filter(t => t.net_pnl > 0.005)
  const pct = (rows: LedgerTrade[]) => rows.map(t => t.pnl_pct)
  const hasPct = trades.some(t => finite(t.pnl_pct))
  switch (metric) {
    case 'occurrences': return trades.length
    case 'net': return unit === 'pct' ? (hasPct ? sumOf(pct(trades)) : null) : sumOf(trades.map(t => t.net_pnl))
    case 'loss': return unit === 'pct' ? (hasPct ? sumOf(pct(losses)) : null) : sumOf(losses.map(t => t.net_pnl))
    case 'profit': return unit === 'pct' ? (hasPct ? sumOf(pct(wins)) : null) : sumOf(wins.map(t => t.net_pnl))
    case 'capital': return central(trades.map(t => t.capital_pct), mode)
    case 'bars': return central(trades.map(t => t.bars), mode)
    case 'entries': return central(trades.map(t => t.entries), mode)
    case 'exits': return central(trades.map(t => t.exits), mode)
    case 'within_1': {
      const known = trades.filter(t => finite(t.bars))
      return known.length ? (100 * known.filter(t => (t.bars as number) <= 1).length) / known.length : null
    }
  }
}

export interface DayPoint { date: string; value: number | null; trades: number }

/** One habit's metric for every trading day; counts/sums are 0 and averages are gaps on days without the habit. */
export function daySeries(trades: LedgerTrade[], days: string[], questionId: string, metric: SeriesMetric, unit: Unit, mode: StatMode): DayPoint[] {
  const own = trades.filter(t => hasQuestion(t, questionId))
  return days.map(date => {
    const rows = own.filter(t => t.date === date)
    if (!rows.length) return { date, trades: 0, value: SERIES_METRICS[metric].empty === 'zero' ? 0 : null }
    return { date, trades: rows.length, value: metricOver(rows, metric, unit, mode) }
  })
}

/** Rolling mean over the last `window` days, ignoring days without a value; null while the window has none. */
export function rollingMean(values: Array<number | null>, window: number): Array<number | null> {
  return values.map((_, index) => mean(values.slice(Math.max(0, index - window + 1), index + 1)))
}

// ── Period comparison ────────────────────────────────────────────────────────

export type CompareMetric = 'per_day' | 'net' | 'loss' | 'capital' | 'bars' | 'within_1' | 'entries' | 'exits'
export type Tone = 'good' | 'bad' | 'neutral'

export const COMPARE_METRICS: CompareMetric[] = ['per_day', 'net', 'loss', 'capital', 'bars', 'within_1', 'entries', 'exits']
/** Fewer trades than this in either period and the flag says there is not enough data. */
export const MIN_COMPARE_TRADES = 3
/** A change smaller than this (relative) counts as "same". */
export const CHANGE_THRESHOLD = 0.1

export interface CompareCell { before: number | null; recent: number | null; delta: number | null; tone: Tone }
export type Flag = 'improving' | 'worse' | 'mixed' | 'same' | 'too_few'

export interface HabitComparison {
  trades: { before: number; recent: number }
  cells: Record<CompareMetric, CompareCell>
  flag: Flag
  /** The components behind the flag, in words. */
  reasons: string[]
}

function value(metric: CompareMetric, rows: LedgerTrade[], period: Period, unit: Unit, mode: StatMode): number | null {
  if (metric === 'per_day') return period.days.length ? rows.length / period.days.length : null
  return metricOver(rows, metric as SeriesMetric, unit, mode)
}

/** Whether a change is good for the user. Only results (net, loss) and, for a habit with a verdict, how often it happens are judged. */
export function toneFor(metric: CompareMetric, delta: number | null, verdict: Verdict): Tone {
  if (delta == null || Math.abs(delta) < 1e-9) return 'neutral'
  if (metric === 'net' || metric === 'loss') return delta > 0 ? 'good' : 'bad'   // loss is negative: closer to 0 is better
  if (metric === 'per_day') {
    if (verdict === 'costly') return delta < 0 ? 'good' : 'bad'
    if (verdict === 'rewarding') return delta > 0 ? 'good' : 'bad'
  }
  return 'neutral'
}

/** +1 / 0 / −1 for a relative change: a rise of at least the threshold is +1 when `higherIsBetter`. */
function direction(before: number | null, recent: number | null, higherIsBetter: boolean): -1 | 0 | 1 {
  if (before == null || recent == null) return 0
  if (before === 0 && recent === 0) return 0
  const base = Math.abs(before)
  const change = base > 0 ? (recent - before) / base : (recent > 0 ? 1 : -1)
  if (Math.abs(change) < CHANGE_THRESHOLD) return 0
  return (change > 0) === higherIsBetter ? 1 : -1
}

/**
 * Compare one habit between two periods.
 *
 * Flag (improving / worse / mixed / same): three components, each +1 better / −1 worse / 0 unchanged (a change of at
 * least 10%) — (1) loss per trading day, (2) how often the habit happens, (3) the capital % deployed on it. The
 * direction of (2) and (3) follows the habit's verdict: for a costly habit less is better, for a rewarding habit
 * more is better, for a mixed habit they do not count. Improving: total ≥ +1 and loss not worse; worse: total ≤ −1 and
 * loss not better; mixed: signals disagree; same: nothing moved.
 */
export function compareHabit(trades: LedgerTrade[], questionId: string, before: Period, recent: Period, unit: Unit, mode: StatMode, verdict: Verdict): HabitComparison {
  const own = trades.filter(t => hasQuestion(t, questionId))
  const rowsBefore = tradesIn(own, before), rowsRecent = tradesIn(own, recent)
  const cells = {} as Record<CompareMetric, CompareCell>
  for (const metric of COMPARE_METRICS) {
    const a = value(metric, rowsBefore, before, unit, mode), b = value(metric, rowsRecent, recent, unit, mode)
    const delta = a != null && b != null ? b - a : null
    cells[metric] = { before: a, recent: b, delta, tone: toneFor(metric, delta, verdict) }
  }
  const counts = { before: rowsBefore.length, recent: rowsRecent.length }
  if (counts.before < MIN_COMPARE_TRADES || counts.recent < MIN_COMPARE_TRADES) {
    return { trades: counts, cells, flag: 'too_few', reasons: [`Needs at least ${MIN_COMPARE_TRADES} trades in each period (${counts.before} before, ${counts.recent} recent).`] }
  }
  const lossPerDay = (rows: LedgerTrade[], period: Period) => {
    const total = metricOver(rows, 'loss', unit, mode)
    return total == null || !period.days.length ? null : total / period.days.length
  }
  const lossStep = direction(lossPerDay(rowsBefore, before), lossPerDay(rowsRecent, recent), true)      // loss values are negative: closer to 0 is better
  const lessIsBetter = verdict === 'costly', moreIsBetter = verdict === 'rewarding'
  const judged = lessIsBetter || moreIsBetter
  const frequencyStep = judged ? direction(cells.per_day.before, cells.per_day.recent, moreIsBetter) : 0
  const sizeStep = judged ? direction(cells.capital.before, cells.capital.recent, moreIsBetter) : 0
  const total = lossStep + frequencyStep + sizeStep
  const reasons = [
    `Loss per day ${lossStep > 0 ? 'improved' : lossStep < 0 ? 'got worse' : 'is about the same'}`,
    judged ? `Frequency ${frequencyStep > 0 ? 'moved the right way' : frequencyStep < 0 ? 'moved the wrong way' : 'is about the same'}` : 'Frequency not judged (mixed habit)',
    judged ? `Capital % ${sizeStep > 0 ? 'moved the right way' : sizeStep < 0 ? 'moved the wrong way' : 'is about the same'}` : 'Capital % not judged (mixed habit)',
  ]
  let flag: Flag = 'same'
  if (total >= 1 && lossStep >= 0) flag = 'improving'
  else if (total <= -1 && lossStep <= 0) flag = 'worse'
  else if (lossStep !== 0 || frequencyStep !== 0 || sizeStep !== 0) flag = 'mixed'
  return { trades: counts, cells, flag, reasons }
}

// ── Days with vs without ─────────────────────────────────────────────────────

export interface DaysWithWithout {
  daysWith: number
  daysWithout: number
  /** Mean of the day's net % (all trades that day) on days the habit occurred / did not. */
  netWith: number | null
  netWithout: number | null
  difference: number | null
}

/** Whether days on which a habit occurred ended better or worse than the other days (net % of all that day's trades, or ₹). */
export function daysWithWithout(trades: LedgerTrade[], questionId: string, unit: Unit): DaysWithWithout {
  const byDay = new Map<string, LedgerTrade[]>()
  for (const trade of trades) byDay.set(trade.date, [...(byDay.get(trade.date) ?? []), trade])
  const withHabit: number[] = [], without: number[] = []
  for (const rows of byDay.values()) {
    const net = metricOver(rows, 'net', unit, 'mean')
    if (net == null) continue
    ;(rows.some(t => hasQuestion(t, questionId)) ? withHabit : without).push(net)
  }
  const a = mean(withHabit), b = mean(without)
  return { daysWith: withHabit.length, daysWithout: without.length, netWith: a, netWithout: b, difference: a != null && b != null ? a - b : null }
}
