/** Grid Recall (Memory, spec 17.5 #4): remember which tiles lit up. Pure engine, scoring and sim profile. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, StageSpec, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { GRID_RECALL_PARAMS, SPAN_CAP } from '../../config/difficulty.brain'
import { adjustedFraction, createSpanTracker, gainTargetFor, spanScore } from '../../engine/span'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

/** Tiles clicked, in the order clicked. */
export type GrResponse = number[]
export type GrTransform = 'none' | 'rot90' | 'rot180' | 'rot270' | 'flipH' | 'flipV'
const TRANSFORMS: GrTransform[] = ['rot90', 'rot180', 'rot270', 'flipH', 'flipV']

export interface GrTrial {
  span: number
  /** Tiles that light up, in order (0 .. N*N-1, row by row). */
  sequence: number[]
  gridN: number
  /** 0 one by one, recall in order | 1 all at once, recall in any order | 2 one by one, recall in reverse */
  mode: 0 | 1 | 2
  flashMs: number
  gapMs: number
  /** How long all tiles stay lit in simultaneous mode. */
  simultaneousMs: number
  /** How the grid is turned or flipped before recall (the player clicks where the tiles went). Tile identities do not change. */
  transform: GrTransform
}

export interface GrRules { gridN: number; startSpan: number; step: number; maxSpan: number; gainTarget: number; maxTrials: number }
export function grRules(params: Record<string, number>): GrRules {
  const gridN = Math.round(params.gridN)
  const maxSpan = Math.min(gridN * gridN - 2, SPAN_CAP)
  const startSpan = Math.round(params.startSpan)
  const gainTarget = gainTargetFor(startSpan, maxSpan)
  return { gridN, startSpan, step: Math.round(params.spanStep), maxSpan, gainTarget, maxTrials: gainTarget + 3 }
}

/** What the player has to click, in the order that counts. */
export const grExpected = (trial: GrTrial): number[] => (trial.mode === 2 ? [...trial.sequence].reverse() : trial.sequence)

export function grGrade(trial: GrTrial, response: GrResponse): { fraction: number; chance: number; success: boolean } {
  const expected = grExpected(trial)
  const tiles = trial.gridN * trial.gridN
  let right = 0
  if (trial.mode === 1) {
    const wanted = new Set(expected)
    right = new Set(response.filter(tile => wanted.has(tile))).size
  } else {
    right = expected.reduce((count, tile, i) => count + (response[i] === tile ? 1 : 0), 0)
  }
  const fraction = right / trial.span
  return { fraction, chance: trial.mode === 1 ? trial.span / tiles : 1 / tiles, success: right === trial.span && response.length === trial.span }
}

export function createGridRecallEngine(params: Record<string, number>, rng: Rng): TrialEngine<GrTrial, GrResponse> {
  const rules = grRules(params)
  const tracker = createSpanTracker(rules)
  const tiles = rules.gridN * rules.gridN
  const mode = Math.min(2, Math.max(0, Math.round(params.mode))) as 0 | 1 | 2
  return {
    next() {
      if (tracker.finished()) return null
      const span = tracker.span
      return {
        span, sequence: rng.shuffle(Array.from({ length: tiles }, (_, i) => i)).slice(0, span), gridN: rules.gridN, mode,
        flashMs: params.flashMs, gapMs: params.gapMs, simultaneousMs: Math.round(span * params.flashMs * 0.6 + 400),
        transform: params.transform >= 1 ? rng.pick(TRANSFORMS) : 'none',
      }
    },
    timing: (): TrialTiming => ({ displayMs: null, windowMs: 600_000, gapMs: 0 }),
    stages(trial): StageSpec[] {
      const show = trial.mode === 1 ? trial.simultaneousMs : trial.span * (trial.flashMs + trial.gapMs) + 300
      return [
        { name: 'ready', ms: 500 },
        { name: 'show', ms: show, critical: true },
        ...(trial.transform !== 'none' ? [{ name: 'turn', ms: 1300 }] : []),
        { name: 'respond', ms: null },
      ]
    },
    evaluate(trial, response): TrialOutcome {
      const grade = grGrade(trial, response === 'timeout' ? [] : response)
      tracker.record(grade.success)
      return { correct: grade.success }
    },
    progress: () => ({ span: tracker.span, strikes: tracker.strikes, trial: tracker.played, of: rules.maxTrials }),
  }
}

const TRANSFORM_TEXT: Record<GrTransform, string> = { none: '', rot90: ' (turned 90° clockwise)', rot180: ' (turned upside down)', rot270: ' (turned 90° anticlockwise)', flipH: ' (flipped left-right)', flipV: ' (flipped top-bottom)' }
export const describeGr = (trial: GrTrial): string => `span ${trial.span} on a ${trial.gridN}x${trial.gridN} grid: ${trial.sequence.map(t => t + 1).join(' ')}${TRANSFORM_TEXT[trial.transform]}`

export function summariseGridRecall(log: TrialLogEntry<GrTrial, GrResponse>[], level: number): SessionSummary {
  const rules = grRules(paramsAt(GRID_RECALL_PARAMS, level))
  const graded = log.map(entry => ({ entry, grade: grGrade(entry.trial, entry.response === 'timeout' ? [] : entry.response) }))
  const peak = Math.max(0, ...graded.filter(g => g.grade.success).map(g => g.entry.trial.span))
  const meanAdjusted = graded.length ? graded.reduce((sum, g) => sum + adjustedFraction(g.grade.fraction, g.grade.chance), 0) / graded.length : 0
  const review: ReviewRow[] = graded.slice(0, 250).map(({ entry, grade }) => ({
    n: entry.n, shown: describeGr(entry.trial), answered: entry.response === 'timeout' ? 'no answer' : entry.response.map(t => t + 1).join(' '),
    correctAnswer: grExpected(entry.trial).map(t => t + 1).join(' ') + (entry.trial.mode === 1 ? ' (any order)' : ''), correct: grade.success, rtMs: null,
  }))
  return {
    score: spanScore(rules.startSpan, peak, rules.gainTarget, meanAdjusted),
    stats: {
      peak_span: peak, mean_accuracy: graded.length ? round3(graded.reduce((s, g) => s + g.grade.fraction, 0) / graded.length) : 0,
      strikes: graded.filter(g => !g.grade.success).length, trials: graded.length,
    },
    review,
  }
}

export const gridRecallSim: SimPlayer<GrTrial, GrResponse> = {
  correct: grExpected,
  random: (trial, rng) => rng.shuffle(Array.from({ length: trial.gridN * trial.gridN }, (_, i) => i)).slice(0, trial.span),
}
