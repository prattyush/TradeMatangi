/** Pattern Matrix (Reasoning, spec 17.5 #16): complete a 3x3 matrix of figures. Pure engine and scoring; puzzles come from `generator.ts`. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { PATTERN_MATRIX_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { choiceSkill, round3, speedEmphasisScore, speedFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import { generateMatrices, type Figure, type MatrixPuzzle } from './generator'

/** The index of the chosen option. */
export type PmResponse = number
export interface PmTrial { puzzle: MatrixPuzzle; limitMs: number; gapMs: number }

export function createPatternMatrixEngine(params: Record<string, number>, rng: Rng, puzzles?: MatrixPuzzle[]): TrialEngine<PmTrial, PmResponse> {
  const total = ROUND_COUNTS.pattern_matrix
  const set = puzzles ?? generateMatrices({ params, seed: Math.floor(rng.next() * 4294967296), count: total })
  let judged = 0
  return {
    next() {
      if (judged >= total) return null
      return { puzzle: set[judged % set.length], limitMs: params.limitMs, gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.limitMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      judged += 1
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      if (response === trial.puzzle.correct) return { correct: true, tag: 'ok' }
      // The kind of mistake: a near miss (one attribute off) or a clearly different figure.
      return { correct: false, tag: trial.puzzle.changed[response]?.length === 1 ? 'near' : 'far' }
    },
    progress: () => ({ trial: judged, of: total }),
  }
}

const SHAPES = ['circle', 'square', 'triangle', 'pentagon', 'hexagon']
const COLOURS = ['orange', 'blue', 'green', 'red']
const SHADING = ['solid', 'light', 'outline']
const SIZES = ['small', 'medium', 'large']
export const describeFigure = (f: Figure): string =>
  `${f.count + 1} ${SIZES[f.size]} ${COLOURS[f.colour]} ${SHADING[f.shading]} ${SHAPES[f.shape]}${f.count > 0 ? 's' : ''}, turned ${f.rotation * 45}°${f.mask ? `, dots ${f.mask.toString(2).padStart(4, '0')}` : ''}`

export const ruleLabel = (puzzle: MatrixPuzzle): string[] => puzzle.rules.map(rule => `${rule.attr === 'mask' ? 'dots' : rule.attr} ${rule.kind === 'logic' ? (rule.detail === 0 ? 'XOR' : 'AND') : rule.kind}`)

export function summarisePatternMatrix(log: TrialLogEntry<PmTrial, PmResponse>[], level: number): SessionSummary {
  const p = paramsAt(PATTERN_MATRIX_PARAMS, level)
  const total = ROUND_COUNTS.pattern_matrix
  const correct = log.filter(entry => entry.outcome.correct)
  // Chance-corrected over the ten puzzles (an unplayed puzzle counts as wrong), so guessing scores about nothing.
  const skill = choiceSkill(correct.length, Math.max(log.length, total), Math.round(p.options))
  const medianMs = median(correct.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const speed = speedFactor(medianMs, p.rtFast, p.rtSlow)
  const byRule = (kind: string) => {
    const rows = log.filter(entry => entry.trial.puzzle.rules.some(rule => rule.kind === kind))
    return rows.length ? Math.round((rows.filter(entry => entry.outcome.correct).length / rows.length) * 100) : 0
  }
  const review: ReviewRow[] = log.map(entry => ({
    n: entry.n, shown: `rules: ${ruleLabel(entry.trial.puzzle).join(', ')}`,
    answered: entry.response === 'timeout' ? 'no answer' : describeFigure(entry.trial.puzzle.options[entry.response as number]),
    correctAnswer: describeFigure(entry.trial.puzzle.options[entry.trial.puzzle.correct]), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score: speedEmphasisScore(skill, speed, 1, 0.15),
    stats: {
      puzzles: log.length, solved: correct.length, accuracy: log.length ? round3(correct.length / log.length) : 0, median_time_ms: Math.round(medianMs ?? 0),
      acc_constant: byRule('constant'), acc_progression: byRule('progression'), acc_distribute: byRule('distribute'), acc_overlay: byRule('logic'),
      err_near: log.filter(entry => entry.outcome.tag === 'near').length, err_far: log.filter(entry => entry.outcome.tag === 'far').length,
      timeouts: log.filter(entry => entry.outcome.tag === 'timeout').length,
    },
    review,
  }
}

export const patternMatrixSim: SimPlayer<PmTrial, PmResponse> = {
  correct: trial => trial.puzzle.correct,
  random: (trial, rng) => rng.int(0, trial.puzzle.options.length - 1),
}
