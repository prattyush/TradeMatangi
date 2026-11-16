/** Code Breaker (Reasoning, spec 17.5 #18): find the hidden code from exact / misplaced feedback. Pure engine and scoring. */
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { ROUND_COUNTS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import { generateCodes, isConsistent, solverGuesses, type CodePuzzle } from './solver'

/** All the guesses of one code, and whether the last one was right. */
export interface CbResponse { guesses: number[][]; solved: boolean }
export interface CbTrial { code: CodePuzzle; length: number; symbols: number; repeats: boolean; guessLimit: number; gapMs: number; windowMs: number }

/** No clock on a code: the limit is the number of guesses. */
export const CODE_WINDOW_MS = 3600000

export function createCodeBreakerEngine(params: Record<string, number>, rng: Rng, codes?: CodePuzzle[]): TrialEngine<CbTrial, CbResponse> {
  const total = ROUND_COUNTS.code_breaker
  const set = codes ?? generateCodes({ params, seed: Math.floor(rng.next() * 4294967296), count: total })
  let judged = 0
  return {
    next() {
      if (judged >= total) return null
      return {
        code: set[judged % set.length], length: Math.round(params.length), symbols: Math.round(params.symbols), repeats: params.repeats >= 1,
        guessLimit: Math.round(params.guesses), gapMs: params.gapMs, windowMs: CODE_WINDOW_MS,
      }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.windowMs, gapMs: trial.gapMs, tolerateStalls: true }),
    evaluate(_trial, response): TrialOutcome {
      judged += 1
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      return response.solved ? { correct: true, tag: 'solved' } : { correct: false, tag: 'failed' }
    },
    progress: () => ({ trial: judged, of: total }),
  }
}

/**
 * Per code: solved in `par` guesses = 1, at twice par = 0, unsolved = 0. As built (spec correction C19): the base score is scaled by
 * the share of guesses that were consistent with the earlier feedback, and a solve whose every guess was consistent
 * earns +0.1 (capped at 1). The spec only adds the bonus; with a code space as small as 24 codes (level 1) a player guessing at
 * random solves some codes by luck, and without the scaling that was worth about 15 points.
 */
export function codeScore(entry: TrialLogEntry<CbTrial, CbResponse>): { score: number; consistent: number; guesses: number } {
  if (entry.response === 'timeout') return { score: 0, consistent: 0, guesses: 0 }
  const { guesses, solved } = entry.response
  const { code } = entry.trial
  const consistent = guesses.filter((guess, i) => isConsistent(guess, guesses.slice(0, i), code.secret, code.hidden)).length
  if (!solved) return { score: 0, consistent, guesses: guesses.length }
  const base = clamp01(1 - (guesses.length - code.par) / code.par)
  const rate = consistent / Math.max(1, guesses.length)
  return { score: Math.min(1, base * rate + (consistent === guesses.length ? 0.1 : 0)), consistent, guesses: guesses.length }
}

export function summariseCodeBreaker(log: TrialLogEntry<CbTrial, CbResponse>[], level: number): SessionSummary {
  void level
  const total = ROUND_COUNTS.code_breaker
  const scored = log.map(codeScore)
  const solved = log.filter(entry => entry.outcome.correct)
  const allGuesses = scored.reduce((s, x) => s + x.guesses, 0)
  const consistent = scored.reduce((s, x) => s + x.consistent, 0)
  const meanGuesses = (rows: typeof log) => (rows.length ? rows.reduce((s, entry) => s + (entry.response === 'timeout' ? 0 : entry.response.guesses.length), 0) / rows.length : 0)
  const medianMs = median(solved.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const review: ReviewRow[] = log.map(entry => ({
    n: entry.n, shown: `code of ${entry.trial.length} from ${entry.trial.symbols} symbols (par ${entry.trial.code.par})`,
    answered: entry.response === 'timeout' ? 'no answer' : `${entry.response.guesses.length} guesses, ${entry.response.solved ? 'solved' : 'not solved'}`,
    correctAnswer: entry.trial.code.secret.map(s => s + 1).join(' '), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score: toSessionScore(100 * (scored.reduce((s, x) => s + x.score, 0) / total)),
    stats: {
      codes: log.length, solved: solved.length, solve_rate_pct: log.length ? Math.round((solved.length / log.length) * 100) : 0,
      mean_guesses: round3(meanGuesses(solved)), mean_par: round3(solved.length ? solved.reduce((s, entry) => s + entry.trial.code.par, 0) / solved.length : 0),
      consistency_pct: allGuesses ? Math.round((consistent / allGuesses) * 100) : 0, median_solve_ms: Math.round(medianMs ?? 0),
      accuracy: log.length ? round3(solved.length / log.length) : 0,
    },
    review,
  }
}

export const codeBreakerSim: SimPlayer<CbTrial, CbResponse> = {
  // The simple solver's own game: it reaches par every time.
  correct: trial => ({ guesses: solverGuesses(trial.code.secret, trial.symbols, trial.repeats, trial.guessLimit, trial.code.hidden), solved: true }),
  random(trial, rng) {
    const guesses: number[][] = []
    for (let i = 0; i < trial.guessLimit; i++) {
      const guess: number[] = []
      while (guess.length < trial.length) { const s = rng.int(0, trial.symbols - 1); if (trial.repeats || !guess.includes(s)) guess.push(s) }
      guesses.push(guess)
      if (guess.every((s, k) => s === trial.code.secret[k])) return { guesses, solved: true }
    }
    return { guesses, solved: false }
  },
}

