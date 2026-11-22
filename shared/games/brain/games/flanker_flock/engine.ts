/** Flanker Flock (Attention, spec 17.5 #7): which way does the middle arrow point? Pure engine, scoring and sim profile. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { BLOCK_SECONDS, FLANKER_PARAMS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { choiceSkill, expectedTrials, round3, speedEmphasisScore, speedFactor, volumeFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

export type FlDir = 'left' | 'right'
export type FlResponse = FlDir
export type FlKind = 'congruent' | 'incongruent' | 'neutral'
/** One symbol of an arrow row: an arrow, or a neutral mark (no direction). */
export type FlSymbol = FlDir | 'neutral'

export interface FlTrial {
  kind: FlKind
  /** Direction of the middle (target) arrow: the right answer. */
  dir: FlDir
  /** The row to judge. */
  row: FlSymbol[]
  /** With two rows (from level 14): the other row, a decoy with random arrows. `null` for a single row. */
  decoy: FlSymbol[] | null
  /** Which row is the target when there are two: 0 top, 1 bottom. */
  targetRow: 0 | 1
  /** Vertical offset of the rows in px (from level 10); 0 before. */
  offsetY: number
  displayMs: number
  windowMs: number
  gapMs: number
  preMs: number
}

const CHUNK = 20
const CUE_MS = 500
const opposite = (dir: FlDir): FlDir => (dir === 'left' ? 'right' : 'left')

export function createFlankerEngine(params: Record<string, number>, rng: Rng): TrialEngine<FlTrial, FlResponse> {
  const flankers = Math.max(1, Math.round(params.flankers))
  const incongruent = Math.round((params.incongruentPct * CHUNK) / 100)
  const neutral = Math.round((params.neutralPct * CHUNK) / 100)
  const congruent = Math.max(0, CHUNK - incongruent - neutral)
  const jitter = params.jitter >= 1
  const decoyRow = params.decoyRow >= 1
  let queue: FlKind[] = []
  return {
    next() {
      if (!queue.length) queue = rng.shuffle<FlKind>([...Array(incongruent).fill('incongruent'), ...Array(neutral).fill('neutral'), ...Array(congruent).fill('congruent')])
      const kind = queue.pop() as FlKind
      const dir: FlDir = rng.chance(0.5) ? 'left' : 'right'
      const flank: FlSymbol = kind === 'congruent' ? dir : kind === 'incongruent' ? opposite(dir) : 'neutral'
      const row: FlSymbol[] = [...Array(flankers).fill(flank), dir, ...Array(flankers).fill(flank)]
      const decoy: FlSymbol[] | null = decoyRow ? Array.from({ length: row.length }, () => (rng.chance(0.5) ? 'left' : 'right')) : null
      return {
        kind, dir, row, decoy, targetRow: decoyRow ? (rng.chance(0.5) ? 0 : 1) : 0, offsetY: jitter ? rng.int(-40, 40) : 0,
        displayMs: params.displayMs, windowMs: params.windowMs, gapMs: params.gapMs, preMs: decoyRow ? CUE_MS : 0,
      }
    },
    timing: (trial): TrialTiming => ({ displayMs: trial.displayMs, windowMs: trial.windowMs, gapMs: trial.gapMs, preMs: trial.preMs }),
    evaluate(trial, response): TrialOutcome {
      return { correct: response !== 'timeout' && response === trial.dir, tag: trial.kind }
    },
  }
}

export const cueText = (trial: FlTrial): string | null => (trial.decoy ? (trial.targetRow === 0 ? '▲ judge the TOP row' : '▼ judge the BOTTOM row') : null)
const glyph = (symbol: FlSymbol) => (symbol === 'left' ? '←' : symbol === 'right' ? '→' : '–')
export const describeFl = (trial: FlTrial): string => `${trial.row.map(glyph).join(' ')}${trial.decoy ? ` (${trial.targetRow === 0 ? 'top' : 'bottom'} row; decoy ${trial.decoy.map(glyph).join(' ')})` : ''}`

export function summariseFlanker(log: TrialLogEntry<FlTrial, FlResponse>[], level: number): SessionSummary {
  const p = paramsAt(FLANKER_PARAMS, level)
  const valid = log.length
  const correct = log.filter(entry => entry.outcome.correct).length
  const rtOf = (entries: typeof log) => entries.filter(entry => entry.outcome.correct && entry.rtMs !== null).map(entry => entry.rtMs as number)
  const medianRt = median(rtOf(log))
  const skill = choiceSkill(correct, valid, 2)
  const speed = speedFactor(medianRt, p.rtFast, p.rtSlow)
  const expected = expectedTrials(BLOCK_SECONDS.flanker_flock, (p.rtFast + p.rtSlow) / 2, p.gapMs)
  const score = speedEmphasisScore(skill, speed, volumeFactor(valid, expected))
  const kindRt = (kind: FlKind) => median(rtOf(log.filter(entry => entry.trial.kind === kind)))
  const errors = (kind: FlKind) => log.filter(entry => entry.trial.kind === kind && !entry.outcome.correct).length
  const congruentRt = kindRt('congruent'), incongruentRt = kindRt('incongruent')
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: describeFl(entry.trial), answered: entry.response === 'timeout' ? 'no answer' : entry.response, correctAnswer: entry.trial.dir,
    correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      trials: valid, accuracy: valid ? round3(correct / valid) : 0, median_rt: Math.round(medianRt ?? 0),
      median_rt_congruent: Math.round(congruentRt ?? 0), median_rt_incongruent: Math.round(incongruentRt ?? 0),
      flanker_effect: congruentRt !== undefined && incongruentRt !== undefined ? Math.round(incongruentRt - congruentRt) : 0,
      err_congruent: errors('congruent'), err_incongruent: errors('incongruent'), err_neutral: errors('neutral'),
      anticipations: log.filter(entry => entry.outcome.anticipated).length, lapses: log.filter(entry => entry.response === 'timeout').length,
    },
    review,
  }
}

export const flankerSim: SimPlayer<FlTrial, FlResponse> = {
  correct: trial => trial.dir,
  random: (_trial, rng) => (rng.chance(0.5) ? 'left' : 'right'),
}
