/** Number Series (Reasoning, spec 17.5 #17): what comes next? Pure engine and scoring; puzzles come from `generator.ts`. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { NUMBER_SERIES_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { choiceSkill, round3, speedEmphasisScore, speedFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import { FAMILIES, generateSeriesSet, type SeriesPuzzle } from './generator'

/** The term chosen or typed. */
export type NsrResponse = number
export interface NsrTrial { puzzle: SeriesPuzzle; /** Type the answer instead of choosing it (level 15+). */ typed: boolean; limitMs: number; gapMs: number }

export function createNumberSeriesEngine(params: Record<string, number>, rng: Rng, puzzles?: SeriesPuzzle[]): TrialEngine<NsrTrial, NsrResponse> {
  const total = ROUND_COUNTS.number_series
  const set = puzzles ?? generateSeriesSet({ params, seed: Math.floor(rng.next() * 4294967296), count: total })
  let judged = 0
  return {
    next() {
      if (judged >= total) return null
      return { puzzle: set[judged % set.length], typed: params.typed >= 1, limitMs: params.limitMs, gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.limitMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      judged += 1
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      return response === trial.puzzle.answer ? { correct: true, tag: 'ok' } : { correct: false, tag: 'wrong' }
    },
    progress: () => ({ trial: judged, of: total }),
  }
}

export function summariseNumberSeries(log: TrialLogEntry<NsrTrial, NsrResponse>[], level: number): SessionSummary {
  const p = paramsAt(NUMBER_SERIES_PARAMS, level)
  const total = ROUND_COUNTS.number_series
  const correct = log.filter(entry => entry.outcome.correct)
  const typed = p.typed >= 1
  // Choosing among 5 is chance-corrected; a typed answer has no real chance level, so accuracy is the skill.
  const skill = typed ? clamp01(correct.length / Math.max(log.length, total)) : choiceSkill(correct.length, Math.max(log.length, total), 5)
  const medianMs = median(correct.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const speed = speedFactor(medianMs, p.rtFast, p.rtSlow)
  const stats: Record<string, number> = {
    puzzles: log.length, solved: correct.length, accuracy: log.length ? round3(correct.length / log.length) : 0, median_time_ms: Math.round(medianMs ?? 0),
    typed: typed ? 1 : 0, timeouts: log.filter(entry => entry.outcome.tag === 'timeout').length,
  }
  for (const family of FAMILIES) {
    const rows = log.filter(entry => entry.trial.puzzle.family === family)
    stats[`acc_${family}`] = rows.length ? Math.round((rows.filter(entry => entry.outcome.correct).length / rows.length) * 100) : 0
  }
  const review: ReviewRow[] = log.map(entry => ({
    n: entry.n, shown: `${entry.trial.puzzle.terms.join(', ')}, ?`, answered: entry.response === 'timeout' ? 'no answer' : String(entry.response),
    correctAnswer: `${entry.trial.puzzle.answer} (${entry.trial.puzzle.rule})`, correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return { score: toSessionScore(speedEmphasisScore(skill, speed, 1, 0.15)), stats, review }
}

export const numberSeriesSim: SimPlayer<NsrTrial, NsrResponse> = {
  correct: trial => trial.puzzle.answer,
  random: (trial, rng) => (trial.typed ? trial.puzzle.answer + rng.pick([-3, -2, -1, 1, 2, 3, 10]) : rng.pick(trial.puzzle.options)),
}
