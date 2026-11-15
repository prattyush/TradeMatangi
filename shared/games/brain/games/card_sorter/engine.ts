/**
 * Card Sorter (Flexibility, spec 17.5 #11): a Wisconsin-style sort. Four fixed reference cards differ in colour, shape and
 * count; each new card is matched to one of them by a hidden rule (colour, shape or count). Feedback says only "match" or
 * "no match". After `runLength` correct cards in a row the rule changes silently. Pure engine and scoring.
 *
 * Reference card `i` has colour `i`, shape `i` and `i + 1` symbols, so a card's value in a dimension IS the index of the
 * reference card it matches on that dimension.
 */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { CARD_SORTER_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

export const DIMENSIONS = ['colour', 'shape', 'count'] as const
export type CsRule = 0 | 1 | 2
export type CsResponse = number // index of the reference card, 0 to 3

export interface CsCard { colour: number; shape: number; /** 1 to 4 symbols */ count: number }
export interface CsTrial {
  card: CsCard
  /** The reference card the hidden rule points at. */
  correctIndex: number
  rule: CsRule
  /** The rule before the latest change (`null` until the first change): answering by it is a perseverative error. */
  prevRule: CsRule | null
  /** The card matches two reference cards on two dimensions at once, so a right answer does not reveal the rule. */
  ambiguous: boolean
  feedbackDelayMs: number
  windowMs: number
  gapMs: number
}

export const CS_WINDOW_MS = 60000
export const cardIndex = (card: CsCard, dimension: CsRule): number => (dimension === 0 ? card.colour : dimension === 1 ? card.shape : card.count - 1)
export const REFERENCE_CARDS: readonly CsCard[] = [0, 1, 2, 3].map(i => ({ colour: i, shape: i, count: i + 1 }))

export function createCardSorterEngine(params: Record<string, number>, rng: Rng): TrialEngine<CsTrial, CsResponse> {
  const ruleCount = Math.max(2, Math.min(3, Math.round(params.rules)))
  const runLength = Math.max(2, Math.round(params.runLength))
  const ambiguousShare = params.ambiguousPct / 100
  const total = ROUND_COUNTS.card_sorter
  const allRules: CsRule[] = [0, 1, 2]
  const inUse = allRules.slice(0, ruleCount)
  // The rule and the run move when a card is JUDGED, so a card replaced after a bad frame changes nothing.
  let rule: CsRule = rng.pick(inUse)
  let prevRule: CsRule | null = null
  let run = 0
  let judged = 0

  return {
    next() {
      if (judged >= total) return null
      const ambiguous = ambiguousShare > 0 && rng.chance(ambiguousShare)
      // Distinct values on the three dimensions, so the card matches a different reference card on each one.
      const values = rng.shuffle([0, 1, 2, 3]).slice(0, 3)
      if (ambiguous) {
        // The current rule and one other dimension point at the same reference card.
        const other = rng.pick(inUse.filter(d => d !== rule))
        values[other] = values[rule]
      }
      const card: CsCard = { colour: values[0], shape: values[1], count: values[2] + 1 }
      return {
        card, correctIndex: values[rule], rule, prevRule, ambiguous,
        feedbackDelayMs: Math.round(params.feedbackDelayMs), windowMs: CS_WINDOW_MS, gapMs: params.gapMs + Math.round(params.feedbackDelayMs),
      }
    },
    timing: (trial): TrialTiming => ({ displayMs: null, windowMs: trial.windowMs, gapMs: trial.gapMs }),
    evaluate(trial, response): TrialOutcome {
      judged += 1
      const correct = response !== 'timeout' && response === trial.correctIndex
      let tag = 'ok'
      if (!correct) {
        tag = response !== 'timeout' && trial.prevRule !== null && response === cardIndex(trial.card, trial.prevRule) ? 'persev' : 'wrong'
        if (run >= 5) tag += '_lapse' // a slip after five or more in a row: "failure to maintain set"
        run = 0
      } else if (++run >= runLength) {
        run = 0
        prevRule = rule
        rule = rng.pick(inUse.filter(d => d !== rule))
      }
      return { correct, tag }
    },
    progress: () => ({ trial: judged, of: total }),
  }
}

/** Category completions replayed from the log (the same rule the engine applies). */
export function categoriesFrom(log: TrialLogEntry<CsTrial, CsResponse>[], runLength: number): { categories: number; firstCategoryAt: number } {
  let run = 0, categories = 0, firstCategoryAt = 0
  for (const entry of log) {
    if (!entry.outcome.correct) { run = 0; continue }
    if (++run >= runLength) { run = 0; categories += 1; if (categories === 1) firstCategoryAt = entry.n }
  }
  return { categories, firstCategoryAt }
}

const describeCard = (card: CsCard) => `${['orange', 'blue', 'green', 'red'][card.colour]} ${['circle', 'square', 'triangle', 'star'][card.shape]} x${card.count}`
export const correctCs = (trial: CsTrial): CsResponse => trial.correctIndex

export function summariseCardSorter(log: TrialLogEntry<CsTrial, CsResponse>[], level: number): SessionSummary {
  const p = paramsAt(CARD_SORTER_PARAMS, level)
  const { categories, firstCategoryAt } = categoriesFrom(log, Math.max(2, Math.round(p.runLength)))
  const errors = log.filter(entry => !entry.outcome.correct)
  const persev = errors.filter(entry => entry.outcome.tag?.startsWith('persev')).length
  const perseverationRate = errors.length ? persev / errors.length : 0
  const target = Math.max(1, p.categoryTarget)
  const score = toSessionScore(100 * clamp01(categories / target) * (1 - 0.5 * perseverationRate))
  const review: ReviewRow[] = log.map(entry => ({
    n: entry.n, shown: `${describeCard(entry.trial.card)}${entry.trial.ambiguous ? ' (matches two on one dimension)' : ''}`,
    answered: entry.response === 'timeout' ? 'no answer' : `reference ${(entry.response as number) + 1}`,
    correctAnswer: `reference ${entry.trial.correctIndex + 1} (${DIMENSIONS[entry.trial.rule]})`, correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      cards: log.length, categories, accuracy: log.length ? round3(log.filter(entry => entry.outcome.correct).length / log.length) : 0,
      persev_error_pct: Math.round(perseverationRate * 100), persev_errors: persev, errors: errors.length,
      trials_to_first_category: firstCategoryAt, failures_to_maintain_set: errors.filter(entry => entry.outcome.tag?.endsWith('_lapse')).length,
      ambiguous_cards: log.filter(entry => entry.trial.ambiguous).length,
    },
    review,
  }
}

export const cardSorterSim: SimPlayer<CsTrial, CsResponse> = {
  correct: correctCs,
  random: (_trial, rng) => rng.int(0, 3),
}
