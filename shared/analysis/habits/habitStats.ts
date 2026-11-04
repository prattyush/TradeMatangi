import type { BehaviorKind, BehaviorQuestion } from '../api'
import type { LedgerTrade } from './types'

/**
 * Habit statistics computed from the trade ledger (`GET /api/behavior/habit-ledger`).
 *
 * A habit is a behavior question; a trade "has" the habit when it carries its mark. "Without the habit" (the
 * baseline) is every other trade in the same scope. P&L % is each trade's net P&L as a % of the session capital,
 * so profit % / loss % / net % are sums of percent-of-capital points. All functions are pure.
 */

/** A trade is a win/loss when its net P&L is beyond half a paisa, as in the Stats overview. */
export const EPSILON = 0.005
export const LOW_SAMPLE_TRADES = 10

export type StatMode = 'mean' | 'median'
export type Unit = 'pct' | 'money'

/** Mean and median of the values that exist (`n` of them). */
export interface Stat { mean: number | null; median: number | null; n: number }

export const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

export function mean(values: Array<number | null | undefined>): number | null {
  const rows = values.filter(finite)
  return rows.length ? sum(rows) / rows.length : null
}

export function median(values: Array<number | null | undefined>): number | null {
  const rows = values.filter(finite).sort((a, b) => a - b)
  if (!rows.length) return null
  const middle = rows.length >> 1
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2
}

export function stat(values: Array<number | null | undefined>): Stat {
  const rows = values.filter(finite)
  return { mean: mean(rows), median: median(rows), n: rows.length }
}

/** The mean or the median, whichever the user selected. */
export const pick = (value: Stat, mode: StatMode): number | null => value[mode]

const isWin = (trade: LedgerTrade) => trade.net_pnl > EPSILON
const isLoss = (trade: LedgerTrade) => trade.net_pnl < -EPSILON
const share = (part: number, whole: number): number | null => (whole > 0 ? (100 * part) / whole : null)

/** Totals for a set of trades; used for a habit, for the trades without it, and for the whole scope. */
export interface TradeTotals {
  trades: number
  /** Trades with a usable P&L % (the denominator of the % statistics). */
  pct_trades: number
  days: number
  wins: number
  losses: number
  breakeven: number
  win_pct: number | null
  net_pnl: number
  profit_pnl: number
  loss_pnl: number
  net_pct: number
  profit_pct: number
  loss_pct: number
  pnl: Stat
  pct: Stat
  avg_win_pct: number | null
  avg_loss_pct: number | null
  /** Average win ÷ average loss, both as percentages of capital. */
  payoff_ratio: number | null
  /** Sum of winning P&L % ÷ sum of losing P&L %. */
  profit_factor: number | null
  largest_loss_pct: number | null
  largest_loss_pnl: number | null
}

export function totals(trades: LedgerTrade[]): TradeTotals {
  const wins = trades.filter(isWin)
  const losses = trades.filter(isLoss)
  const withPct = (rows: LedgerTrade[]) => rows.map(t => t.pnl_pct).filter(finite)
  const winPcts = withPct(wins)
  const lossPcts = withPct(losses)
  const profitPct = sum(winPcts)
  const lossPct = sum(lossPcts)
  const avgWin = mean(winPcts)
  const avgLoss = mean(lossPcts)
  return {
    trades: trades.length,
    pct_trades: trades.filter(t => finite(t.pnl_pct)).length,
    days: new Set(trades.map(t => t.date)).size,
    wins: wins.length,
    losses: losses.length,
    breakeven: trades.length - wins.length - losses.length,
    win_pct: trades.length ? (100 * wins.length) / trades.length : null,
    net_pnl: sum(trades.map(t => t.net_pnl)),
    profit_pnl: sum(wins.map(t => t.net_pnl)),
    loss_pnl: sum(losses.map(t => t.net_pnl)),
    net_pct: profitPct + lossPct,
    profit_pct: profitPct,
    loss_pct: lossPct,
    pnl: stat(trades.map(t => t.net_pnl)),
    pct: stat(trades.map(t => t.pnl_pct)),
    avg_win_pct: avgWin,
    avg_loss_pct: avgLoss,
    payoff_ratio: avgWin != null && avgLoss != null && avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
    profit_factor: lossPct < 0 ? profitPct / Math.abs(lossPct) : null,
    largest_loss_pct: lossPcts.length ? Math.min(...lossPcts) : null,
    largest_loss_pnl: losses.length ? Math.min(...losses.map(t => t.net_pnl)) : null,
  }
}

/** How the habit's trades were sized and how long they lasted. */
export interface Profile {
  entries: Stat
  exits: Stat
  /** Total capital deployed, % of the session capital. */
  capital: Stat & { max: number | null }
  risk: Stat
  bars: Stat
  holding_seconds: Stat
  /** Share of trades (with bars known) closed within 1 / 2 candles. */
  within_1_bar_pct: number | null
  within_2_bars_pct: number | null
  /** Share of losing trades (with bars known) closed within 1 candle. */
  loser_within_1_bar_pct: number | null
}

const shareWithin = (trades: LedgerTrade[], limit: number): number | null => {
  const known = trades.filter(t => finite(t.bars))
  return known.length ? (100 * known.filter(t => (t.bars as number) <= limit).length) / known.length : null
}

export function profile(trades: LedgerTrade[]): Profile {
  const capital = stat(trades.map(t => t.capital_pct))
  const capitals = trades.map(t => t.capital_pct).filter(finite)
  return {
    entries: stat(trades.map(t => t.entries)),
    exits: stat(trades.map(t => t.exits)),
    capital: { ...capital, max: capitals.length ? Math.max(...capitals) : null },
    risk: stat(trades.map(t => t.risk_pct)),
    bars: stat(trades.map(t => t.bars)),
    holding_seconds: stat(trades.map(t => t.holding_seconds)),
    within_1_bar_pct: shareWithin(trades, 1),
    within_2_bars_pct: shareWithin(trades, 2),
    loser_within_1_bar_pct: shareWithin(trades.filter(isLoss), 1),
  }
}

export type Verdict = 'costly' | 'rewarding' | 'mixed' | 'low_sample'

export interface HabitSummary {
  question_id: string
  text: string
  kind: BehaviorKind
  status: 'active' | 'archived'
  /** Results of the trades with the habit. */
  habit: TradeTotals
  /** Results of every other trade in the scope. */
  baseline: TradeTotals
  profile: Profile
  /** Net % you would have saved (positive) or given up (negative) by not taking the habit's trades. */
  if_skipped_pct: number | null
  if_skipped_pnl: number
  /** Share of all losing / winning % in the scope that came from this habit's trades (habits overlap: not additive). */
  share_of_loss_pct: number | null
  share_of_profit_pct: number | null
  /** Trades with the habit per trading day in scope (days with a trade of any kind). */
  per_scope_day: number | null
  verdict: Verdict
  verdict_reason: string
}

const signed = (value: number, digits = 2) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`

/** Costly / Rewarding / Mixed / Low sample, with the numbers that decided it. Uses means and % of capital (₹ when unavailable). */
export function verdictFor(habit: TradeTotals, baseline: TradeTotals): { verdict: Verdict; reason: string } {
  if (habit.trades < LOW_SAMPLE_TRADES) {
    return { verdict: 'low_sample', reason: `Only ${habit.trades} trade${habit.trades === 1 ? '' : 's'} (fewer than ${LOW_SAMPLE_TRADES}): too few to judge.` }
  }
  const usePct = habit.pct_trades > 0
  const net = usePct ? habit.net_pct : habit.net_pnl
  const own = usePct ? habit.pct.mean : habit.pnl.mean
  const other = usePct ? baseline.pct.mean : baseline.pnl.mean
  const unit = usePct ? '%' : ' ₹'
  const detail = `Net ${signed(net)}${unit} over ${habit.trades} trades; ${own == null ? 'no average' : `${signed(own)}${unit} per trade`}${other == null ? '' : ` vs ${signed(other)}${unit} without it`}.`
  if (own == null) return { verdict: 'mixed', reason: detail }
  if (net < 0 && (other == null || own < other)) return { verdict: 'costly', reason: detail }
  if (net > 0 && (other == null || own > other)) return { verdict: 'rewarding', reason: detail }
  return { verdict: 'mixed', reason: detail }
}

export interface SummaryOptions {
  kind?: BehaviorKind | 'all'
  includeArchived?: boolean
}

export interface HabitsOverview {
  scope: TradeTotals
  habits: HabitSummary[]
  /** Habits (after the filters) with no trade in scope. */
  idle: BehaviorQuestion[]
}

/** Summaries for every habit with at least one trade in scope, plus the scope totals. Sort order is the caller's. */
export function summarize(questions: BehaviorQuestion[], trades: LedgerTrade[], options: SummaryOptions = {}): HabitsOverview {
  const kind = options.kind ?? 'all'
  const includeArchived = options.includeArchived ?? true
  const scope = totals(trades)
  const byHabit = new Map<string, LedgerTrade[]>()
  for (const trade of trades) for (const id of trade.habits) byHabit.set(id, [...(byHabit.get(id) ?? []), trade])
  const habits: HabitSummary[] = []
  const idle: BehaviorQuestion[] = []
  for (const question of questions) {
    if ((kind !== 'all' && question.kind !== kind) || (!includeArchived && question.status === 'archived')) continue
    const own = byHabit.get(question.question_id) ?? []
    if (!own.length) { if (question.status === 'active') idle.push(question); continue }
    const without = trades.filter(t => !t.habits.includes(question.question_id))
    const habit = totals(own)
    const baseline = totals(without)
    const { verdict, reason } = verdictFor(habit, baseline)
    habits.push({
      question_id: question.question_id, text: question.text, kind: question.kind, status: question.status,
      habit, baseline, profile: profile(own),
      if_skipped_pct: habit.pct_trades ? -habit.net_pct : null,
      if_skipped_pnl: -habit.net_pnl,
      share_of_loss_pct: share(Math.abs(habit.loss_pct), Math.abs(scope.loss_pct)),
      share_of_profit_pct: share(habit.profit_pct, scope.profit_pct),
      per_scope_day: scope.days ? habit.trades / scope.days : null,
      verdict, verdict_reason: reason,
    })
  }
  return { scope, habits, idle }
}

// ── Table helpers ─────────────────────────────────────────────────────────────

export type SortKey =
  | 'text' | 'trades' | 'days' | 'net' | 'profit' | 'loss' | 'win_pct' | 'average' | 'vs_without' | 'if_skipped'
  | 'share_loss' | 'share_profit' | 'profit_factor' | 'payoff' | 'largest_loss'
  | 'entries' | 'exits' | 'capital' | 'capital_max' | 'risk' | 'bars' | 'held' | 'within_1' | 'within_2' | 'loser_within_1'

/** The value a column shows for a habit (null when unavailable), for display and sorting. */
export function metric(summary: HabitSummary, key: SortKey, unit: Unit, mode: StatMode): number | string | null {
  const pct = unit === 'pct'
  const habit = summary.habit
  switch (key) {
    case 'text': return summary.text.toLowerCase()
    case 'trades': return habit.trades
    case 'days': return habit.days
    // A % total over trades that have no P&L % is unavailable, not 0.
    case 'net': return pct ? (habit.pct_trades ? habit.net_pct : null) : habit.net_pnl
    case 'profit': return pct ? (habit.pct_trades ? habit.profit_pct : null) : habit.profit_pnl
    case 'loss': return pct ? (habit.pct_trades ? habit.loss_pct : null) : habit.loss_pnl
    case 'win_pct': return habit.win_pct
    case 'average': return pct ? pick(habit.pct, mode) : pick(habit.pnl, mode)
    case 'vs_without': {
      const own = pct ? pick(habit.pct, mode) : pick(habit.pnl, mode)
      const other = pct ? pick(summary.baseline.pct, mode) : pick(summary.baseline.pnl, mode)
      return own != null && other != null ? own - other : null
    }
    case 'if_skipped': return pct ? summary.if_skipped_pct : summary.if_skipped_pnl
    case 'share_loss': return summary.share_of_loss_pct
    case 'share_profit': return summary.share_of_profit_pct
    case 'profit_factor': return habit.profit_factor
    case 'payoff': return habit.payoff_ratio
    case 'largest_loss': return pct ? habit.largest_loss_pct : habit.largest_loss_pnl
    case 'entries': return pick(summary.profile.entries, mode)
    case 'exits': return pick(summary.profile.exits, mode)
    case 'capital': return pick(summary.profile.capital, mode)
    case 'capital_max': return summary.profile.capital.max
    case 'risk': return pick(summary.profile.risk, mode)
    case 'bars': return pick(summary.profile.bars, mode)
    case 'held': return pick(summary.profile.holding_seconds, mode)
    case 'within_1': return summary.profile.within_1_bar_pct
    case 'within_2': return summary.profile.within_2_bars_pct
    case 'loser_within_1': return summary.profile.loser_within_1_bar_pct
  }
}

/** Sorts habits by a column; habits without a value always go last, whichever the direction. */
export function sortHabits(habits: HabitSummary[], key: SortKey, direction: 'asc' | 'desc', unit: Unit, mode: StatMode): HabitSummary[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...habits].sort((a, b) => {
    const left = metric(a, key, unit, mode), right = metric(b, key, unit, mode)
    if (left == null && right == null) return a.text.localeCompare(b.text)
    if (left == null) return 1
    if (right == null) return -1
    if (typeof left === 'string' || typeof right === 'string') return factor * String(left).localeCompare(String(right))
    return factor * (left - right) || a.text.localeCompare(b.text)
  })
}

/** Default order: the most destructive habit first (lowest net). */
export const worstFirst = (habits: HabitSummary[], unit: Unit, mode: StatMode) => sortHabits(habits, 'net', 'asc', unit, mode)
