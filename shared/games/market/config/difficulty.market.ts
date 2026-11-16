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

/** Entry Sniper (spec 5.2, 15). The first parameters are the spec's anchors; the others are filled in where it was silent (C34). */
export const ENTRY_SNIPER_PARAMS: ParamTable = {
  rounds: a(8, 10, 12, 14, 16),
  /** Seconds of market time the player may choose an entry in. */
  windowSec: a(45, 35, 25, 15, 10),
  /** How fast the window plays: market seconds per real second (so a 45 second window is 15 real seconds at level 1). */
  windowSpeed: a(3, 2.5, 2, 1.5, 1, false),
  stopMult: a(1.5, 1.3, 1.1, 0.9, 0.8, false),
  rr: a(1, 1.3, 1.6, 1.8, 2, false),
  /** Share of rounds where the stated direction never offers a profitable entry (passing is right). */
  trapShare: a(0, 0.1, 0.2, 0.25, 0.3, false),
  /** Seconds a trade may run after the entry. */
  horizonSec: a(180, 150, 120, 90, 60),
  slipMult: a(0, 0.4, 0.8, 1.2, 1.5, false),
  /** After the entry the replay runs this many times faster than real time. */
  replaySpeed: a(8, 8, 8, 8, 8, false),
}

export const ENTRY_SNIPER = {
  deltaProxy: 0.5,
  /** Credit for passing a trap round. */
  passCredit: 0.5,
  /** A round is a trap when the best entry in the window is worth less than this many R. */
  trapBelowR: 0.25,
  /** `roundScore = clamp(R_user / max(R_opt, floor))`. */
  optFloorR: 0.5,
  /** An entry in the first seconds of the window is "chasing". */
  earlySec: 2,
  contextSec: 60,
  minCoverage: 0.8,
} as const

/** Exit Discipline (spec 5.3, 15). Speeds are 3 times the spec's 1x to 4x (C35): a 3 to 10 minute trade in real time is too slow to practise. */
export const EXIT_DISCIPLINE_PARAMS: ParamTable = {
  rounds: a(5, 6, 6, 7, 8),
  horizonSec: a(180, 240, 300, 420, 600),
  speed: a(3, 4.5, 6, 9, 12, false),
  stopMult: a(1.5, 1.3, 1.1, 0.9, 0.8, false),
  slipMult: a(0, 0.4, 0.8, 1.2, 1.5, false),
  /** 1 while the plan fields are filled in for the player (levels 1 to 5), 0 from level 6. */
  prefilled: steps([1, 1], [6, 0]),
}

export const EXIT_DISCIPLINE = {
  deltaProxy: 0.5,
  /** The suggested target is this many R. */
  rr: 2,
  /** LOCK moves the stop to keep this share of the open profit. */
  lockFraction: 0.5,
  /** Ending worse than the plan after overriding it costs this much of the round score. */
  overridePenalty: 0.2,
  /** The stop the player may enter, as a multiple of the suggested one (so a very wide stop cannot make every round look captured), and the target as a multiple of their stop. */
  stopMin: 0.5, stopMax: 1.5, targetMin: 0.5, targetMax: 6,
  /** Round mix (spec): give-back, straight to target, straight to stop. */
  mix: { giveback: 0.4, target: 0.3, stop: 0.3 },
  contextSec: 60,
  minCoverage: 0.8,
} as const
