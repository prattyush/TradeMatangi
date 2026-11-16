/** Anagram Dash (Word, spec 17.5 #19): unscramble the letters into a word that uses all of them. Pure engine and scoring; puzzles from `generator.ts`. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { ANAGRAM_DASH_PARAMS, BLOCK_SECONDS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import type { AnagramPuzzle } from './generator'

/** A correct word (with whether a hint was used and how many wrong entries came first), or `'skip'`. */
export type AdResponse = { word: string; hinted: boolean; misses: number } | 'skip'
export interface AdTrial { puzzle: AnagramPuzzle; softMs: number; windowMs: number; gapMs: number }

export function createAnagramEngine(params: Record<string, number>, rng: Rng, puzzles: AnagramPuzzle[] = []): TrialEngine<AdTrial, AdResponse> {
  void rng
  let judged = 0
  return {
    next() {
      if (!puzzles.length) return null
      return { puzzle: puzzles[judged % puzzles.length], softMs: params.softMs, windowMs: params.softMs * 2, gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.windowMs, gapMs: trial.gapMs, tolerateStalls: true }),
    evaluate(trial, response): TrialOutcome {
      judged += 1
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      if (response === 'skip') return { correct: false, tag: 'skip' }
      return trial.puzzle.answers.includes(response.word) ? { correct: true, tag: response.hinted ? 'hinted' : 'ok' } : { correct: false, tag: 'wrong' }
    },
  }
}

/** The weighted total a player who solves a word in `expertMs` reaches in the block (spec: 0.8 x 90 / expert x (length - 2) x 0.85). */
export function targetValue(p: Record<string, number>): number {
  return Math.max(1, Math.round(0.8 * (BLOCK_SECONDS.anagram_dash * 1000 / p.expertMs) * (Math.round(p.length) - 2) * 0.85))
}

/** Value of a solved word: (length - 2) x (0.7 + 0.3 x speed), x 0.7 when a hint was used. */
export function wordScore(entry: TrialLogEntry<AdTrial, AdResponse>): number {
  if (!entry.outcome.correct || entry.response === 'timeout' || entry.response === 'skip') return 0
  const speed = clamp01(1 - (entry.rtMs ?? entry.trial.softMs) / entry.trial.softMs)
  return (entry.response.word.length - 2) * (0.7 + 0.3 * speed) * (entry.response.hinted ? 0.7 : 1)
}

export function summariseAnagramDash(log: TrialLogEntry<AdTrial, AdResponse>[], level: number): SessionSummary {
  const p = paramsAt(ANAGRAM_DASH_PARAMS, level)
  const total = log.reduce((sum, entry) => sum + wordScore(entry), 0)
  const solved = log.filter(entry => entry.outcome.correct)
  const medianMs = median(solved.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number))
  const longest = Math.max(0, ...solved.map(entry => (entry.response === 'timeout' || entry.response === 'skip' ? 0 : entry.response.word.length)))
  const hinted = solved.filter(entry => entry.outcome.tag === 'hinted').length
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: entry.trial.puzzle.letters.toUpperCase(),
    answered: entry.response === 'timeout' ? 'no answer' : entry.response === 'skip' ? 'skipped' : `${entry.response.word}${entry.response.hinted ? ' (hint)' : ''}`,
    correctAnswer: entry.trial.puzzle.answers.join(' / '), correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score: toSessionScore(100 * clamp01(total / targetValue(p))),
    stats: {
      words: log.length, solved: solved.length, median_time_ms: Math.round(medianMs ?? 0), longest_word: longest, value: Math.round(total * 10) / 10,
      hint_rate_pct: solved.length ? Math.round((hinted / solved.length) * 100) : 0, skipped: log.filter(entry => entry.outcome.tag === 'skip').length,
      timeouts: log.filter(entry => entry.outcome.tag === 'timeout').length,
      wrong_entries: log.reduce((sum, entry) => sum + (entry.response !== 'timeout' && entry.response !== 'skip' ? entry.response.misses : 0), 0),
      accuracy: log.length ? round3(solved.length / log.length) : 0,
    },
    review,
  }
}

export const anagramDashSim: SimPlayer<AdTrial, AdResponse> = {
  correct: trial => ({ word: trial.puzzle.target, hinted: false, misses: 0 }),
  // Nobody guesses an anagram by luck: a random player skips or runs out the clock.
  random: () => 'skip',
}
