/**
 * Span progression shared by Grid Recall and Sequence Echo (spec 17.5, correction C1): the span rises after a success, a failure
 * is a strike, three strikes end the game; a ceiling and a trial cap make sure a perfect player's session ends too.
 *
 * Score: progress = clamp(spanGain / gainTarget) where spanGain = peakSpan - startSpan + 1 (0 when the first trial failed);
 * accuracy = mean chance-corrected fraction recalled; score = round(100 * (0.7 * progress + 0.3 * accuracy)).
 */
import { clamp01, toSessionScore } from '../../core/scoring'
import { MAX_STRIKES } from '../config/difficulty.brain'

export interface SpanRules { startSpan: number; step: number; maxSpan: number; gainTarget: number; maxTrials: number }

/** Most the player can gain: from the start span up to the ceiling, never more than the spec's six. */
export const gainTargetFor = (startSpan: number, maxSpan: number, cap = 6): number => Math.max(1, Math.min(cap, maxSpan - startSpan + 1))

export interface SpanTracker {
  readonly span: number
  readonly strikes: number
  readonly played: number
  readonly peak: number
  finished(): boolean
  /** Record a judged round: a success raises the span (up to the ceiling), a failure is a strike. */
  record(success: boolean): void
}

export function createSpanTracker(rules: SpanRules, maxStrikes = MAX_STRIKES): SpanTracker {
  let span = rules.startSpan
  let strikes = 0
  let played = 0
  let peak = 0
  let atCeiling = false
  return {
    get span() { return span },
    get strikes() { return strikes },
    get played() { return played },
    get peak() { return peak },
    finished: () => strikes >= maxStrikes || played >= rules.maxTrials || atCeiling,
    record(success) {
      played += 1
      if (!success) { strikes += 1; return }
      peak = Math.max(peak, span)
      if (span >= rules.maxSpan) atCeiling = true
      else span = Math.min(rules.maxSpan, span + rules.step)
    },
  }
}

/** Fraction recalled, corrected for guessing: 0 at chance, 1 when everything is right. */
export const adjustedFraction = (fraction: number, chance: number): number => (chance >= 1 ? 0 : clamp01((fraction - chance) / (1 - chance)))

export function spanScore(startSpan: number, peakSpan: number, gainTarget: number, meanAdjusted: number): number {
  const gain = peakSpan > 0 ? peakSpan - startSpan + 1 : 0
  const progress = clamp01(gain / gainTarget)
  return toSessionScore(100 * (0.7 * progress + 0.3 * clamp01(meanAdjusted)))
}
