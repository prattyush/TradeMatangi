/**
 * Round logs for the market games (spec 7.3, G7): one `ReviewRow` per round, kept on the device with the last 20 sessions and listed in Review.
 * There is no replay for market sessions: windows are drawn fresh and the no-repeat memory would pick others. The market, day and clock time
 * are in `shown`, since the games hide them until the round is over. Pure functions: a round and its result in, a row out.
 */
import type { ReviewRow } from '../core/trial'
import { PATTERN_LABEL } from './engine/patterns'
import type { BreakoutResult, BreakoutRound, HuntResult, HuntRound } from './games/spot_the_trap/engine'
import type { SniperResult, SniperRound } from './games/entry_sniper/engine'
import type { ExitResult, ExitRound } from './games/exit_discipline/engine'
import type { RoundResult as LevelResult, LevelRound } from './games/level_recall/engine'
import type { SegmentResult as NoTradeResult } from './games/no_trade_day/engine'
import type { PickResult, Scenario } from './games/strike_picker/engine'
import type { SegmentResult as RegimeResult, Segment as RegimeSegment } from './games/regime_switch/engine'
import { PLAYBOOK_LABEL } from './games/regime_switch/engine'
import type { QuestionResult, Question } from './games/risk_calculator/engine'
import type { PromptResult } from './games/hotkey_drill/engine'
import type { RoundResult as TickResult, TickRound } from './games/tick_reader/engine'

const clock = (second: number): string => {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')
  return `${pad(second / 3600)}:${pad((second % 3600) / 60)}:${pad(second % 60)}`
}
export const where = (symbol: string, date: string, sec: number): string => `${symbol} ${date} ${clock(sec)}`
const signed = (value: number, unit: string): string => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)} ${unit}`
const row = (n: number, shown: string, answered: string, correctAnswer: string, correct: boolean, rtMs: number | null = null): ReviewRow => ({ n, shown, answered, correctAnswer, correct, rtMs })

export function tickRow(n: number, round: TickRound, r: TickResult): ReviewRow {
  const answered = r.answer === 'long' ? `Long, ${signed(r.net, 'pts')}` : r.answer === 'short' ? `Short, ${signed(r.net, 'pts')}` : r.answer === 'skip' ? 'Skip' : 'Timed out'
  const correct = r.kind === 'correct_skip' || (r.kind === 'trade' && r.net > 0)
  return row(n, where(round.symbol, round.date, round.decisionSec), answered, round.edge ? `a tradable move (${signed(round.move, 'pts')})` : `skip (move ${signed(round.move, 'pts')})`, correct, r.decisionMs)
}

export function sniperRow(n: number, round: SniperRound, r: SniperResult): ReviewRow {
  const answered = r.kind === 'enter' ? `entered at +${r.offset} s, ${signed(r.userR, 'R')}` : r.kind === 'pass' ? 'passed' : 'timed out'
  const best = r.bestOffset === null ? 'no good entry (pass)' : `entry at +${r.bestOffset} s, ${signed(r.bestR, 'R')}`
  return row(n, where(round.symbol, round.date, round.startSec), answered, best, r.roundScore >= 0.5)
}

export function exitRow(n: number, round: ExitRound, r: ExitResult): ReviewRow {
  return row(n, where(round.symbol, round.date, round.startSec), `${r.outcome}, ${signed(r.userR, 'R')}${r.overrides ? `, ${r.overrides} override${r.overrides === 1 ? '' : 's'}` : ''}`, `plan ${signed(r.planR, 'R')}, best available ${signed(r.mfeR, 'R')}`, r.capture >= 0.5)
}

export function levelRow(n: number, round: LevelRound, r: LevelResult): ReviewRow {
  const shown = where(round.symbol, round.date, round.roundSec)
  if (r.sequence) return row(n, `${shown}, swing sequence`, `${r.sequence.correct} of ${r.sequence.total} right`, 'all right', r.sequence.correct === r.sequence.total)
  const placed = r.errors.filter(e => e.errorUnits !== null)
  const mean = placed.length ? placed.reduce((s, e) => s + (e.errorUnits ?? 0), 0) / placed.length : null
  return row(n, `${shown}, ${r.errors.length} levels`, `${placed.length} placed${mean === null ? '' : `, mean error ${mean.toFixed(2)} units`}`, 'each at its true price', r.roundScore >= 0.5)
}

export function pickRow(n: number, scenario: Scenario, r: PickResult): ReviewRow {
  const shown = `${scenario.symbol} ${scenario.right === 'CE' ? 'call' : 'put'}, ${scenario.dte} day${scenario.dte === 1 ? '' : 's'} to expiry, ${scenario.minutes} min, ${scenario.objective.replace(/_/g, ' ')}`
  return row(n, shown, r.offset === null ? 'timed out' : `strike ${r.offset >= 0 ? '+' : ''}${r.offset}`, `score ${Math.round(r.roundScore * 100)}%, led by ${r.driver}`, r.roundScore >= 0.5)
}

export function regimeRow(n: number, segment: RegimeSegment, r: RegimeResult): ReviewRow {
  const round = segment.round
  return row(n, `${where(round.symbol, round.date, round.decisionSec)}, ${r.regime.replace(/_/g, ' ')}`, r.playbook === 'timeout' ? 'timed out' : PLAYBOOK_LABEL[r.playbook], `${PLAYBOOK_LABEL[r.best]}${r.perseveration ? ' (old playbook kept)' : ''}`, r.correct)
}

export function questionRow(n: number, q: Question, r: QuestionResult): ReviewRow {
  return row(n, q.prompt, r.entered === null ? 'no answer' : `${r.entered}`, `${q.answer} ${q.unit}`.trim(), r.verdict === 'correct', r.timeMs)
}

export function promptRow(n: number, r: PromptResult): ReviewRow {
  return row(n, `${r.steps}-step prompt`, r.kind === 'done' ? (r.errors.length ? `done, ${r.errors.length} error${r.errors.length === 1 ? '' : 's'}` : 'done') : r.kind, 'no errors', r.kind === 'done' && r.errors.length === 0, r.kind === 'done' ? r.rtMs : null)
}

export function breakoutRow(n: number, round: BreakoutRound, r: BreakoutResult): ReviewRow {
  return row(n, `${where(round.symbol, round.date, round.breakoutSec)}, breakout ${round.direction === 1 ? 'up' : 'down'}`, r.verdict === 'timeout' ? 'timed out' : r.verdict.toUpperCase(), round.real ? 'REAL' : 'FAKE', r.correct)
}

export function huntRow(n: number, round: HuntRound, r: HuntResult): ReviewRow {
  return row(n, `${where(round.symbol, round.date, round.startSec)}, ${PATTERN_LABEL[round.pattern]}`, `${r.clicks} click${r.clicks === 1 ? '' : 's'}, ${Math.round(r.recall * 100)}% found, ${Math.round(r.precision * 100)}% right`, `${r.truth} occurrence${r.truth === 1 ? '' : 's'}`, r.roundScore >= 0.5)
}

export function segmentRow(n: number, segment: { symbol: string; date: string; startSec: number }, r: NoTradeResult): ReviewRow {
  return row(n, where(segment.symbol, segment.date, segment.startSec), `${signed(r.netR, 'R')} in ${r.tradeCount} trade${r.tradeCount === 1 ? '' : 's'}, ${r.violations} rule break${r.violations === 1 ? '' : 's'}, ${r.revenge} revenge`, `best in hindsight ${signed(r.opportunity, 'R')}`, r.roundScore >= 0.5)
}
