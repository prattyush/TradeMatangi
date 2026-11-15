/** Make Target (Math, spec 17.5 #15): reach the target from the given numbers, each used at most once. Pure engine and scoring. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { MAKE_TARGET_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { round3, speedFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import { generatePuzzles, OPERATOR_SIGN, type Puzzle } from './solver'

/** The value the player submitted (a number on the board) and how many operations it took. */
export interface MtResponse { value: number; steps: number }
export interface MtTrial { puzzle: Puzzle; limitMs: number; /** Half credit when within this of the target (levels 1 to 6), else 0. */ tolerance: number; gapMs: number }

export function createMakeTargetEngine(params: Record<string, number>, rng: Rng, puzzles?: Puzzle[]): TrialEngine<MtTrial, MtResponse> {
  const total = ROUND_COUNTS.make_target
  // Without a ready-made set (tests, simulated players) build one here from the seeded stream.
  const set = puzzles ?? generatePuzzles({ params, seed: Math.floor(rng.next() * 4294967296), count: total })
  let judged = 0
  return {
    next() {
      if (judged >= total) return null
      return { puzzle: set[judged % set.length], limitMs: params.limitMs, tolerance: Math.round(params.tolerance), gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.limitMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      judged += 1
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      if (response.value === trial.puzzle.target) return { correct: true, tag: 'exact' }
      return { correct: false, tag: trial.tolerance > 0 && Math.abs(response.value - trial.puzzle.target) <= trial.tolerance ? 'near' : 'wrong' }
    },
    progress: () => ({ trial: judged, of: total }),
  }
}

/** Per puzzle: exact = 0.8 + 0.2 x speed (speed 1 at or under RT_fast, 0 at the time limit), within tolerance = 0.5, else 0. */
export function puzzleScore(entry: TrialLogEntry<MtTrial, MtResponse>, rtFast: number): number {
  if (entry.outcome.tag === 'exact') return 0.8 + 0.2 * speedFactor(entry.rtMs ?? entry.trial.limitMs, rtFast, entry.trial.limitMs)
  return entry.outcome.tag === 'near' ? 0.5 : 0
}

const solutionText = (puzzle: Puzzle) => puzzle.solution.map(step => `${step.a} ${OPERATOR_SIGN[step.op]} ${step.b} = ${step.result}`).join(', ')

export function summariseMakeTarget(log: TrialLogEntry<MtTrial, MtResponse>[], level: number): SessionSummary {
  const p = paramsAt(MAKE_TARGET_PARAMS, level)
  const total = ROUND_COUNTS.make_target
  const sum = log.reduce((acc, entry) => acc + puzzleScore(entry, p.rtFast), 0)
  const exact = log.filter(entry => entry.outcome.tag === 'exact')
  const solveMs = median(exact.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const review: ReviewRow[] = log.map(entry => ({
    n: entry.n, shown: `${entry.trial.puzzle.numbers.join(', ')} → ${entry.trial.puzzle.target} (needs ${entry.trial.puzzle.depth} steps)`,
    answered: entry.response === 'timeout' ? 'time ran out' : `${entry.response.value} in ${entry.response.steps} steps`,
    correctAnswer: solutionText(entry.trial.puzzle), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score: toSessionScore(100 * clamp01(sum / total)),
    stats: {
      puzzles: log.length, solved: exact.length, solved_pct: log.length ? Math.round((exact.length / log.length) * 100) : 0, near: log.filter(entry => entry.outcome.tag === 'near').length,
      timeouts: log.filter(entry => entry.outcome.tag === 'timeout').length, median_solve_ms: Math.round(solveMs ?? 0),
      avg_depth_solved: exact.length ? round3(exact.reduce((s, entry) => s + entry.trial.puzzle.depth, 0) / exact.length) : 0,
      avg_depth_all: log.length ? round3(log.reduce((s, entry) => s + entry.trial.puzzle.depth, 0) / log.length) : 0,
    },
    review,
  }
}

export const makeTargetSim: SimPlayer<MtTrial, MtResponse> = {
  correct: trial => ({ value: trial.puzzle.target, steps: trial.puzzle.depth }),
  // A random player combines at random and submits whatever it ends on.
  random: (trial, rng) => ({ value: rng.int(1, Math.max(20, trial.puzzle.target * 2)), steps: rng.int(1, 3) }),
}

