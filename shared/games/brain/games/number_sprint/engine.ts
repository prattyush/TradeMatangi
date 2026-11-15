/** Number Sprint (Math, spec 17.5 #13): one mental-arithmetic problem at a time, typed answer. Pure engine and scoring. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { NUMBER_SPRINT_PARAMS } from '../../config/difficulty.brain'
import { answersEqual, formatNumber, makeProblem, OP_CODES, specFromParams, type Problem, type ProblemOp } from '../../engine/arithmetic'
import { median } from '../../engine/rt'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

/** A typed answer, or `'skip'` (give this one up). */
export type NsResponse = number | 'skip'
export interface NsTrial { problem: Problem; tqMs: number; windowMs: number; gapMs: number }

/** A wrong answer, a skip or a timeout shows the right answer for this long. */
export const SHOW_ANSWER_MS = 1000

export function createNumberSprintEngine(params: Record<string, number>, rng: Rng): TrialEngine<NsTrial, NsResponse> {
  const spec = specFromParams(params)
  return {
    next: () => ({ problem: makeProblem(rng, spec), tqMs: params.tqMs, windowMs: params.windowMs, gapMs: params.gapMs }),
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.windowMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      if (response === 'skip') return { correct: false, tag: 'skip' }
      return answersEqual(response, trial.problem.answer) ? { correct: true, tag: 'ok' } : { correct: false, tag: 'wrong' }
    },
    gapAfter: (trial, outcome) => (outcome.correct ? trial.gapMs : SHOW_ANSWER_MS),
  }
}

/** Weight of one judged problem: right = 0.7 + 0.3 x speed, wrong = -0.5, skipped or timed out = 0 (spec 17.5 #13). */
export function problemWeight(entry: TrialLogEntry<NsTrial, NsResponse>): number {
  if (entry.outcome.correct) return 0.7 + 0.3 * clamp01(1 - (entry.rtMs ?? entry.trial.tqMs) / entry.trial.tqMs)
  return typeof entry.response === 'number' ? -0.5 : 0
}

export function summariseNumberSprint(log: TrialLogEntry<NsTrial, NsResponse>[], level: number): SessionSummary {
  const p = paramsAt(NUMBER_SPRINT_PARAMS, level)
  const total = log.reduce((sum, entry) => sum + problemWeight(entry), 0)
  const solved = log.filter(entry => entry.outcome.correct)
  const medianMs = median(solved.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const ops: ProblemOp[] = ['add', 'sub', 'mul', 'div', 'two']
  const accOf = (op: ProblemOp) => {
    const rows = log.filter(entry => entry.trial.problem.op === op)
    return rows.length ? Math.round((rows.filter(entry => entry.outcome.correct).length / rows.length) * 100) : 0
  }
  // The operation missed most often (a code, 0 = none) feeds the Warm-up.
  const missed = ops.map(op => log.filter(entry => entry.trial.problem.op === op && !entry.outcome.correct).length)
  const worst = Math.max(...missed)
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: entry.trial.problem.text, answered: entry.response === 'timeout' ? 'no answer' : entry.response === 'skip' ? 'skipped' : formatNumber(entry.response),
    correctAnswer: formatNumber(entry.trial.problem.answer), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score: toSessionScore(100 * clamp01(total / Math.max(1, p.itemsTarget))),
    stats: {
      problems: log.length, solved: solved.length, accuracy: log.length ? round3(solved.length / log.length) : 0, median_time_ms: Math.round(medianMs ?? 0),
      weighted_total: Math.round(total * 10) / 10,
      acc_add: accOf('add'), acc_sub: accOf('sub'), acc_mul: accOf('mul'), acc_div: accOf('div'), acc_two: accOf('two'),
      most_missed_op: worst > 0 ? OP_CODES[ops[missed.indexOf(worst)]] : 0,
      wrong: log.filter(entry => entry.outcome.tag === 'wrong').length, skipped: log.filter(entry => entry.outcome.tag === 'skip').length,
      timeouts: log.filter(entry => entry.outcome.tag === 'timeout').length,
    },
    review,
  }
}

export const numberSprintSim: SimPlayer<NsTrial, NsResponse> = {
  correct: trial => trial.problem.answer,
  // A wrong guess near the real answer (never equal to it).
  random: (trial, rng) => trial.problem.answer + rng.pick([-2, -1, 1, 2, 7, 10]),
}
