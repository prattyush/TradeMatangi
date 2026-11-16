/** Letter Grid (Word, spec 17.5 #20): find words by chaining adjacent letters. One grid per session. Pure engine and scoring; grids from `generator.ts`. */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { LETTER_GRID_PARAMS } from '../../config/difficulty.brain'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import type { GridPuzzle } from './generator'

/** The words the player found, in order, and how many entries were wrong or repeated. */
export interface LgResponse { words: string[]; invalid: number; repeats: number }
export interface LgTrial { puzzle: GridPuzzle; limitMs: number; gapMs: number }

/** The block length: the View ends the game itself at this time and reports the words. */
export const GRID_SECONDS = 120

export function createLetterGridEngine(params: Record<string, number>, rng: Rng, puzzles: GridPuzzle[] = []): TrialEngine<LgTrial, LgResponse> {
  void rng
  let judged = 0
  return {
    next() {
      if (!puzzles.length || judged >= 1) return null
      // The View hands the words in; the block's own timeout is far later than the game's end.
      return { puzzle: puzzles[0], limitMs: GRID_SECONDS * 1000, gapMs: params.gapMs }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.limitMs * 10, gapMs: trial.gapMs, tolerateStalls: true }),
    evaluate(trial, response): TrialOutcome {
      judged += 1
      if (response === 'timeout') return { correct: false, tag: 'timeout' }
      const valid = new Set(trial.puzzle.words.map(w => w.word))
      return response.words.some(w => valid.has(w)) ? { correct: true, tag: 'done' } : { correct: false, tag: 'none' }
    },
  }
}

/** The words of the response that are in the grid, once each, with their values. */
export function acceptedWords(puzzle: GridPuzzle, response: LgResponse | 'timeout') {
  if (response === 'timeout') return []
  const byWord = new Map(puzzle.words.map(w => [w.word, w]))
  const seen = new Set<string>()
  const out = []
  for (const word of response.words) { const entry = byWord.get(word); if (entry && !seen.has(word)) { seen.add(word); out.push(entry) } }
  return out
}

export const gridValue = (puzzle: GridPuzzle, response: LgResponse | 'timeout'): number => acceptedWords(puzzle, response).reduce((sum, w) => sum + w.value, 0)

export function summariseLetterGrid(log: TrialLogEntry<LgTrial, LgResponse>[], level: number): SessionSummary {
  const p = paramsAt(LETTER_GRID_PARAMS, level)
  const entry = log[0]
  const puzzle = entry?.trial.puzzle
  const found = puzzle ? acceptedWords(puzzle, entry.response) : []
  const value = found.reduce((sum, w) => sum + w.value, 0)
  const target = puzzle ? Math.max(1, p.targetShare * puzzle.commonValue) : 1
  const commonFound = found.filter(w => w.common)
  const longest = found.reduce((best, w) => (w.word.length > best.length ? w.word : best), '')
  const missed = puzzle ? puzzle.words.filter(w => w.common && !found.some(f => f.word === w.word)).slice(0, 8).map(w => w.word) : []
  const review: ReviewRow[] = puzzle
    ? [{
      n: 1, shown: `${puzzle.n}x${puzzle.n}: ${puzzle.letters.join('').toUpperCase()}`, answered: `${found.length} words, value ${value}: ${found.slice(0, 12).map(w => w.word).join(', ')}`,
      correctAnswer: `${puzzle.commonCount} common words worth ${puzzle.commonValue}; some you missed: ${missed.join(', ')}`, correct: value >= target, rtMs: entry.rtMs,
    }]
    : []
  return {
    score: toSessionScore(100 * clamp01(value / target)),
    stats: {
      words_found: found.length, longest_word: longest.length, value, share_of_common_value_pct: puzzle && puzzle.commonValue ? Math.round((commonFound.reduce((s, w) => s + w.value, 0) / puzzle.commonValue) * 100) : 0,
      common_found: commonFound.length, rare_found: found.length - commonFound.length, common_possible: puzzle?.commonCount ?? 0,
      invalid_entries: entry && entry.response !== 'timeout' ? entry.response.invalid : 0, repeats: entry && entry.response !== 'timeout' ? entry.response.repeats : 0,
      accuracy: entry && entry.response !== 'timeout' && entry.response.words.length + entry.response.invalid > 0 ? round3(found.length / (entry.response.words.length + entry.response.invalid)) : 0,
    },
    review,
  }
}

export const letterGridSim: SimPlayer<LgTrial, LgResponse> = {
  // A player who finds every word of the grid.
  correct: trial => ({ words: trial.puzzle.words.map(w => w.word), invalid: 0, repeats: 0 }),
  random: () => ({ words: [], invalid: 5, repeats: 0 }),
}
