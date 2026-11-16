/**
 * Parameter tables of the market games (spec 15, "first pass, to be tuned"). Anchors at levels 1, 5, 10, 15 and 20, interpolated by
 * `core/difficulty.ts`. Scoring constants sit next to them so a game can be tuned without touching its code.
 */
import type { ParamTable } from '../../core/difficulty'

const a = (l1: number, l5: number, l10: number, l15: number, l20: number, integer = true) =>
  ({ anchors: [l1, l5, l10, l15, l20] as [number, number, number, number, number], integer })

export const TICK_READER_PARAMS: ParamTable = {
  lookbackSec: a(180, 120, 90, 60, 45),
  decisionSec: a(10, 7, 5, 3, 2),
  holdSec: a(60, 45, 35, 25, 15),
  rounds: a(15, 18, 20, 22, 25),
  /** Share of rounds drawn from windows where no move was worth trading (rewards skipping). */
  noEdgeShare: a(0.2, 0.3, 0.4, 0.45, 0.5, false),
  /** Multiplier on the player's slippage setting: 0 at level 1, 1.5 at level 20. */
  slipMult: a(0, 0.4, 0.8, 1.2, 1.5, false),
  /** Wanted efficiency ratio of the lookback: a clean trend early, noisier later. */
  targetEr: a(0.5, 0.42, 0.33, 0.25, 0.15, false),
  /** The hold is replayed this many times faster than real time. */
  replaySpeed: a(6, 6, 6, 6, 6, false),
}

/** Constants of spec 5.1 and 2. */
export const TICK_READER = {
  /** ATM-like delta that turns underlying points into option points when no premium series is used. */
  deltaProxy: 0.5,
  /** `roundScore = clamp(net / (k * volUnitH))`. */
  k: 0.4,
  /** Credit for a correct skip. */
  skipCredit: 0.3,
  /** Edge threshold = max(edgeCostMult * costPts, edgeVolMult * volUnit * sqrt(hold / 5)). */
  edgeCostMult: 1.5,
  edgeVolMult: 0.25,
  /** Fraction of the lookback seconds that must have an observed row, or the window is not used. */
  minCoverage: 0.8,
  /** Candidate windows fetched for one round at most (server protection, spec 4.3). */
  maxCandidates: 3,
  /** A round whose data fails to load is replaced; this many failures in a row end the session. */
  maxFailures: 3,
  /** The result of a round stays on screen this long unless the player moves on. */
  flashMs: 2800,
} as const

const steps = (...entries: Array<[from: number, v: number]>) => ({ steps: entries.map(([from, v]) => ({ from, v })) })

/** Risk Calculator (spec 5.4, 15). `typePool` is how many of the eight question types are unlocked at a level. */
export const RISK_CALCULATOR_PARAMS: ParamTable = {
  questions: a(12, 14, 16, 18, 20),
  /** Seconds per question (T_q). */
  timeSec: a(25, 20, 15, 11, 8),
  /** Most steps a question may need: 1 at level 1, 3 from level 15. */
  maxSteps: a(1, 2, 2, 3, 3),
  /** How awkward the numbers are, 0 (round) to 1 (tick-sized decimals). */
  ugliness: a(0, 0.25, 0.5, 0.75, 1, false),
  lotsMax: a(2, 3, 4, 5, 6),
  typePool: steps([1, 2], [3, 3], [5, 4], [7, 5], [9, 6], [12, 7], [15, 8]),
}

/** Hotkey Drill (spec 5.5, 15): a session is three 60 second blocks. */
export const HOTKEY_DRILL_PARAMS: ParamTable = {
  /** Longest chain of steps in one prompt. */
  maxChain: a(1, 1, 2, 3, 3),
  /** Share of prompts that are "ignore this" cues. */
  ignoreShare: a(0, 0, 0.1, 0.15, 0.2, false),
  /** RT_slow in ms; RT_fast is fixed. */
  rtSlow: a(2500, 2200, 1900, 1700, 1500),
  lotsMax: a(2, 3, 4, 5, 5),
  /** Seconds a prompt stays before it counts as missed. */
  promptSec: a(8, 7, 6, 5, 4),
  /** Pause between a correct prompt and the next one: lower and upper bound in ms. */
  gapMinMs: a(500, 400, 300, 250, 200),
  gapMaxMs: a(900, 800, 700, 600, 500),
}

export const HOTKEY_DRILL = {
  blocks: 3,
  blockSec: 60,
  restSec: 3,
  rtFastMs: 600,
  /** How long an "ignore" cue stays; no key during it is the right answer. */
  ignoreCueMs: 2000,
  /** An error rate above this caps the score. */
  errorCapRate: 0.15,
  errorCapScore: 60,
} as const

export const RISK_CALCULATOR = {
  /** How long the working line stays up after each answer unless the player presses Enter. */
  feedbackMs: 2200,
  /** A "close" answer earns this share of a correct one. */
  closeCredit: 0.5,
  /** A correct answer scores 0.7 + 0.3 x speed. */
  baseCredit: 0.7,
} as const
