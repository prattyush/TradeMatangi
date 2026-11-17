/** Pure Strategy Practice logic shared by every host: wording of the review, grade filters and the chart marks of your trades. */
import type { PatternAnnotation } from '../analysis/api'
import { clock } from '../traded/model'
import { GRADES, type Grade, type PracticeDayRef, type PracticeMode, type PracticePick, type PracticeRun, type PracticeStrategy, type ReviewSetup, type ReviewTrade, type RunSummary, type TheoreticalPair } from './types'

export const gradeLabel = (grade: Grade) => ({ ideal: 'Ideal', average: 'Average', poor: 'Poor', ungraded: 'Success (not graded)', failed: 'Failed', open: 'No outcome' }[grade])

/** The filter to send: nothing when every grade is ticked (the server then offers every Entry-marked day). */
export function pickFilter(symbol: string, grades: ReadonlySet<Grade>, includeNegatives = false, exclude: readonly PracticeDayRef[] = []): PracticePick {
  return {
    ...(symbol ? { symbol } : {}), ...(grades.size > 0 && grades.size < GRADES.length ? { grades: GRADES.filter(g => grades.has(g)) } : {}),
    ...(includeNegatives ? { include_negatives: true } : {}),
    ...(exclude.length ? { exclude: [...exclude] } : {}),
  }
}

/**
 * Whether a failed start is about the day (its data could not be loaded, so another day should be tried) rather than about the session
 * (one is already running: any day would fail the same way). Only the first kind adds the day to the ones not offered again.
 */
export const isDayProblem = (message: string) => !/session is running|active session|already running|stop it|stop the/i.test(message)

/** Days the strategy was absent that a choice of symbol leaves on offer (0 from an older server). */
export const negativeDays = (strategy: PracticeStrategy, symbol: string) =>
  (strategy.negative_days ?? []).filter(n => !symbol || n.symbol === symbol).reduce((sum, n) => sum + n.days, 0)

/** Days a filter leaves on offer (a day counts once per grade it has, so this is an upper bound when a day has two grades). */
export function daysOnOffer(strategy: PracticeStrategy, symbol: string, grades: ReadonlySet<Grade>): number {
  if (!symbol && grades.size === GRADES.length) return strategy.days
  const bySymbol = symbol ? strategy.symbols.find(s => s.symbol === symbol)?.days ?? 0 : strategy.days
  const byGrade = [...grades].reduce((sum, g) => sum + (strategy.grades[g] ?? 0), 0)
  return Math.min(bySymbol, byGrade)
}

export const signed = (value: number, digits = 2) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
export const pointsText = (points: number | null | undefined) => (points === null || points === undefined ? '—' : `${signed(points)} pts`)
export const pctText = (pct: number | null | undefined) => (pct === null || pct === undefined ? '—' : `${signed(pct)}%`)
export const captureText = (capture: number | null | undefined) => (capture === null || capture === undefined ? '—' : `${capture.toFixed(0)}%`)

/** "6 min late", "3 min early", "on the recorded candle". */
export function deltaText(minutes: number | null | undefined, what: 'entry' | 'exit' = 'entry'): string {
  if (minutes === null || minutes === undefined) return '—'
  if (minutes === 0) return `${what === 'entry' ? 'Entered' : 'Exited'} on the recorded candle`
  return `${what === 'entry' ? 'Entered' : 'Exited'} ${Math.abs(minutes)} min ${minutes > 0 ? 'late' : 'early'}`
}

/** One sentence on what a trade kept of the theoretical move, or why that cannot be said. */
export function captureSentence(trade: Pick<ReviewTrade, 'capture_pct' | 'theoretical_points' | 'points'>): string {
  if (trade.theoretical_points === null) return 'The recorded marks could not be priced on this contract.'
  if (trade.theoretical_points <= 0) return 'The recorded marks made nothing on this contract.'
  if (trade.points === null) return 'Still open: no exit to compare.'
  return `You kept ${captureText(trade.capture_pct)} of the ${pointsText(trade.theoretical_points)} on offer.`
}

export const modeLabel = (mode: PracticeMode) => (mode === 'stepwise' ? 'Stepwise' : 'Replay')
/** A run's mode as History shows it (a record from an older server is a replay). */
export const runModeLabel = (run: Pick<PracticeRun, 'session_type'>) => modeLabel(run.session_type === 'stepwise' ? 'stepwise' : 'replay')

const OPENS_SECONDS = 9 * 3600 + 15 * 60

/**
 * A Stepwise practice start snapped down to a bar boundary (never before 09:15:00): the twin of the server's `snap_start`, same test table.
 * Stepwise plays from the start to the end of the bar that contains it, so a start inside a bar would give a short first bar. 09:15 is a
 * boundary for 180 and 300 second bars but not for 120, hence the floor at the open.
 */
export function snapStartTime(start: string, intervalSecs: number): string {
  const [h, m, s = 0] = start.split(':').map(Number)
  const seconds = h * 3600 + m * 60 + s
  const snapped = intervalSecs > 0 ? Math.max(OPENS_SECONDS, seconds - (seconds % intervalSecs)) : seconds
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(Math.floor(snapped / 3600))}:${two(Math.floor((snapped % 3600) / 60))}:${two(snapped % 60)}`
}

/** What a no-setup day (the strategy was absent) came to: staying out is right, any trade is one that should not have been taken. */
export function negativeVerdict(result: Pick<RunSummary, 'traded' | 'correct' | 'points'>): string {
  if (!result.traded) return 'No-setup day: you stayed out, the right call'
  return `No-setup day: you traded${result.points != null ? ` (${pointsText(result.points)})` : ''}, no trade was wanted`
}

export interface HistorySummary {
  /** Runs that ended and were reviewed (their result is known). */
  reviewed: number
  /** Reviewed runs on a day with a recorded setup in which you traded, and how many of them were entered early, late or on the candle. */
  traded: number
  early: number
  late: number
  onTime: number
  /** The average capture % over the runs where it could be worked out, or null. */
  averageCapture: number | null
  /** No-setup days: how many were practised and in how many you stayed out. */
  noSetupDays: number
  stayedOut: number
}

/** Simple totals over your reviewed practice runs, for the History screen. Runs not yet reviewed are left out. */
export function historySummary(runs: ReadonlyArray<Pick<PracticeRun, 'result'>>): HistorySummary {
  const summary: HistorySummary = { reviewed: 0, traded: 0, early: 0, late: 0, onTime: 0, averageCapture: null, noSetupDays: 0, stayedOut: 0 }
  const captures: number[] = []
  for (const { result } of runs) {
    if (!result) continue
    summary.reviewed += 1
    if (result.negative) {
      summary.noSetupDays += 1
      if (result.correct) summary.stayedOut += 1
      continue
    }
    if (!result.traded) continue
    summary.traded += 1
    if (result.entry_delta_min != null) {
      if (result.entry_delta_min < 0) summary.early += 1
      else if (result.entry_delta_min > 0) summary.late += 1
      else summary.onTime += 1
    }
    if (result.capture_pct != null) captures.push(result.capture_pct)
  }
  if (captures.length) summary.averageCapture = Math.round((captures.reduce((a, b) => a + b, 0) / captures.length) * 10) / 10
  return summary
}

/** The History line: "5 reviewed · entered early 1, late 3, on time 1 · kept 62% on average · no-setup days: stayed out 2 of 3". Empty when nothing is reviewed. */
export function historyLine(summary: HistorySummary): string {
  if (summary.reviewed === 0) return ''
  const parts = [`${summary.reviewed} reviewed`]
  if (summary.traded > 0) parts.push(`entered early ${summary.early}, late ${summary.late}, on time ${summary.onTime}`)
  if (summary.averageCapture !== null) parts.push(`kept ${captureText(summary.averageCapture)} on average`)
  if (summary.noSetupDays > 0) parts.push(`no-setup days: stayed out ${summary.stayedOut} of ${summary.noSetupDays}`)
  return parts.join(' · ')
}

/** The best priced pair of a setup for one instrument, or null. */
export const bestFor = (setup: Pick<ReviewSetup, 'theoretical'>, instrument: string): TheoreticalPair | null =>
  setup.theoretical.find(t => t.instrument === instrument && t.points !== undefined) ?? null

/** The short line the History list shows for a finished run. */
export function runLine(result: RunSummary | null): string {
  if (!result) return 'Not reviewed yet'
  if (result.negative) return negativeVerdict(result)
  if (!result.traded) return 'No trade'
  return [deltaText(result.entry_delta_min).replace('Entered ', ''), result.capture_pct != null ? `kept ${captureText(result.capture_pct)}` : null].filter(Boolean).join(' · ')
}

/** Your trade as gold ⚑ marks (`source: 'traded'`) on its 3-minute-or-setup-interval candle, like "From your trades". */
export function tripMarks(trade: ReviewTrade, ref: { category: string; strategy: string }, intervalMinutes: number, key: string): PatternAnnotation[] {
  const bar = intervalMinutes * 60
  const opposite = trade.action === 'BUY' ? 'SELL' : 'BUY'
  const legs: Array<['entry' | 'exit', { time: number; price: number } | null, 'BUY' | 'SELL']> = [['entry', trade.entry, trade.action], ['exit', trade.exit, opposite]]
  return legs.flatMap(([type, leg, action]) => leg ? [{
    id: `practice:${key}:${type}`, time: leg.time - (leg.time % bar), price: leg.price, type, instrument: trade.instrument,
    strategy_name: ref.strategy, category: ref.category, text: `${action} ${trade.quantity} @ ${leg.price}`, source: 'traded' as const, action,
  }] : [])
}

export const sessionClock = (epoch: number) => clock(epoch)
