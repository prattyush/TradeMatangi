/** Word Ladder (Word, spec 17.5 #21): change one letter at a time from the start word to the goal word. Pure engine and scoring; puzzles from `generator.ts`. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { ROUND_COUNTS, WORD_LADDER_PARAMS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import type { LadderPuzzle } from './generator'

/** The words of the finished ladder (start first), the hints used and whether the goal was reached. */
export interface WlResponse { words: string[]; hints: number; solved: boolean }
export interface WlTrial { puzzle: LadderPuzzle; limitMs: number; hints: number; gapMs: number }

/** Each hint takes this much off a solved puzzle's score. */
export const HINT_COST = 0.2

export function createWordLadderEngine(params: Record<string, number>, rng: Rng, puzzles: LadderPuzzle[] = []): TrialEngine<WlTrial, WlResponse> {
  void rng
  const total = ROUND_COUNTS.word_ladder
  let judged = 0
  return {
    next() {
      if (!puzzles.length || judged >= total) return null
      return { puzzle: puzzles[judged % puzzles.length], limitMs: params.limitMs, hints: Math.round(params.hints), gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.limitMs, gapMs: trial.gapMs, tolerateStalls: true }),
    evaluate(_trial, response): TrialOutcome {
      judged += 1
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      return response.solved ? { correct: true, tag: 'solved' } : { correct: false, tag: 'gaveup' }
    },
    progress: () => ({ trial: judged, of: total }),
  }
}

/** Steps taken: the words after the start. */
export const stepsOf = (response: WlResponse): number => Math.max(1, response.words.length - 1)

/** Solved: clamp(par / steps) minus 0.2 per hint (never below 0); unsolved 0. */
export function puzzleScore(entry: TrialLogEntry<WlTrial, WlResponse>): number {
  if (entry.response === 'timeout' || !entry.response.solved) return 0
  return Math.max(0, clamp01(entry.trial.puzzle.par / stepsOf(entry.response)) - HINT_COST * entry.response.hints)
}

export function summariseWordLadder(log: TrialLogEntry<WlTrial, WlResponse>[], level: number): SessionSummary {
  void paramsAt(WORD_LADDER_PARAMS, level)
  const total = ROUND_COUNTS.word_ladder
  const solved = log.filter(entry => entry.outcome.correct)
  const steps = (rows: typeof log) => rows.map(entry => (entry.response === 'timeout' ? 0 : stepsOf(entry.response)))
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const medianMs = median(solved.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const review: ReviewRow[] = log.map(entry => ({
    n: entry.n, shown: `${entry.trial.puzzle.start.toUpperCase()} to ${entry.trial.puzzle.goal.toUpperCase()} (par ${entry.trial.puzzle.par})`,
    answered: entry.response === 'timeout' ? 'time ran out' : `${entry.response.words.join(' > ')}${entry.response.solved ? '' : ' (not finished)'}`,
    correctAnswer: entry.trial.puzzle.path.join(' > '), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score: toSessionScore(100 * (log.reduce((sum, entry) => sum + puzzleScore(entry), 0) / total)),
    stats: {
      puzzles: log.length, solved: solved.length, solve_rate_pct: log.length ? Math.round((solved.length / log.length) * 100) : 0,
      mean_steps: round3(mean(steps(solved))), mean_par: round3(mean(solved.map(entry => entry.trial.puzzle.par))),
      hints_used: log.reduce((sum, entry) => sum + (entry.response === 'timeout' ? 0 : entry.response.hints), 0), median_solve_ms: Math.round(medianMs ?? 0),
      accuracy: log.length ? round3(solved.length / log.length) : 0,
    },
    review,
  }
}

export const wordLadderSim: SimPlayer<WlTrial, WlResponse> = {
  correct: trial => ({ words: trial.puzzle.path, hints: 0, solved: true }),
  random: trial => ({ words: [trial.puzzle.start], hints: 0, solved: false }),
}
