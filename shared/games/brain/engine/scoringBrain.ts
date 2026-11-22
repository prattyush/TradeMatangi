/**
 * Chance-corrected scoring for the brain games (spec 17.4). Guessing must score near 0:
 *  - choice tasks (k options):  skill = clamp((acc - 1/k) / (1 - 1/k), 0, 1)
 *  - detection tasks (go/no-go, n-back): skill = clamp(hitRate - falseAlarmRate, 0, 1)   (Youden's J)
 *  - speed factor: clamp((RT_slow - medianRT) / (RT_slow - RT_fast), 0, 1)
 *  - speed-emphasis score: round(100 * skill * (floor + (1 - floor) * speed))
 *  - volume check: a block with fewer than `minTrialsFrac` of the expected trials is scaled down, so "answer two perfectly
 *    and idle" cannot score high.
 */
import { clamp01, toSessionScore } from '../../core/scoring'

export const DEFAULT_MIN_TRIALS_FRAC = 0.6

export function choiceSkill(correct: number, valid: number, k: number): number {
  if (valid <= 0 || k < 2) return 0
  const chance = 1 / k
  return clamp01((correct / valid - chance) / (1 - chance))
}

export function detectionSkill(hits: number, goTrials: number, falseAlarms: number, noGoTrials: number): number {
  if (goTrials <= 0 || noGoTrials <= 0) return 0
  return clamp01(hits / goTrials - falseAlarms / noGoTrials)
}

/** 1 for a median RT at or under `fast`, 0 at or over `slow`, 0 when there is no RT at all (no correct answer to time). */
export function speedFactor(medianRtMs: number | undefined, fastMs: number, slowMs: number): number {
  if (medianRtMs === undefined || !Number.isFinite(medianRtMs)) return 0
  if (slowMs <= fastMs) return medianRtMs <= fastMs ? 1 : 0
  return clamp01((slowMs - medianRtMs) / (slowMs - fastMs))
}

/** Multiplier in 0..1 for a block with too few completed trials (counted trials only, never discarded ones). */
export function volumeFactor(completed: number, expected: number, minFrac = DEFAULT_MIN_TRIALS_FRAC): number {
  if (expected <= 0) return 1
  const required = minFrac * expected
  if (required <= 0) return 1
  return Math.min(1, Math.max(0, completed) / required)
}

/** `speedWeight` is the share of the score that depends on speed (0.4 for most games, 0.3 for Green Light). */
export function speedEmphasisScore(skill: number, speed: number, volume: number, speedWeight = 0.4): number {
  return toSessionScore(100 * clamp01(skill) * (1 - speedWeight + speedWeight * clamp01(speed)) * clamp01(volume))
}

/** Trials a typical player completes in a block: block time over (mid reaction time + gap). Used by the volume check. */
export function expectedTrials(seconds: number, midRtMs: number, gapMs: number): number {
  const per = midRtMs + gapMs
  return per > 0 ? Math.floor((seconds * 1000) / per) : 0
}

export const round3 = (value: number): number => Math.round(value * 1000) / 1000
