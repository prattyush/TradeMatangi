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

/** Strike Picker (spec 5.8, 15). `dteSet` indexes `DTE_SETS` (the spec's mix: 5 and 2 days, then 5/2/1, 2/1/0, 1/0, and only expiry day). */
export const DTE_SETS: ReadonlyArray<readonly number[]> = [[5, 2], [5, 2, 1], [2, 1, 0], [1, 0], [0]]
export const STRIKE_PICKER_PARAMS: ParamTable = {
  scenarios: a(8, 10, 12, 14, 16),
  /** Seconds to choose a strike; a late pick scores nothing. */
  decisionSec: a(40, 30, 25, 20, 15),
  dteSet: steps([1, 0], [5, 1], [10, 2], [15, 3], [20, 4]),
  /** Market minutes the scenario covers. */
  minutes: a(30, 20, 12, 8, 5),
  /** Share of scenarios where the implied volatility changes. */
  ivShiftShare: a(0, 0.2, 0.4, 0.5, 0.6, false),
  /** Share of scenarios where the expected move does not come ("negative scenarios"). */
  failShare: a(0, 0.05, 0.12, 0.2, 0.25, false),
  /** How many of the four objectives are in play. */
  objectives: steps([1, 1], [6, 2], [11, 3], [16, 4]),
}

export const STRIKE_PICKER = {
  /** Capital of the "profit on capital" objective, in rupees. */
  capital: 10_000,
  /** The option's implied volatility by regime. */
  iv: { low: 0.11, normal: 0.14, high: 0.2 },
  /** Fraction of the trading day left when the scenario starts (so a 0 DTE option still has some life). */
  dayLeft: 0.4,
  /** Trading minutes in a session: elapsed time is `minutes / 375` of a day. */
  sessionMinutes: 375,
  /** Round-trip spread in points: `base + premiumShare x premium + otmStep x OTM steps`. */
  spread: { base: 0.3, premiumShare: 0.012, otmStep: 0.5 },
  /** The flat round-trip cost of the fourth objective, in rupees per lot. */
  costPerLotRs: 60,
  /** Strikes offered on each side of the money (ITM3 to OTM3). */
  strikesEachSide: 3,
} as const

/** Regime Switch (spec 5.7, 15). */
export const REGIME_SWITCH_PARAMS: ParamTable = {
  /** Seconds of price shown, and of replay after the choice. */
  segSec: a(120, 90, 70, 50, 40),
  holdSec: a(60, 45, 35, 25, 20),
  segments: a(8, 10, 12, 14, 16),
  /** The regime changes about this often, in segments (4 at level 1, 2 at level 20). */
  changeEvery: a(4, 3.5, 3, 2.5, 2, false),
  /** Seconds to choose a playbook; a late choice scores nothing. */
  decisionSec: a(12, 10, 8, 6, 5),
  /** 1 while the previous segment's regime is shown as a hint (levels 1 to 8). */
  hint: steps([1, 1], [9, 0]),
  slipMult: a(0, 0.4, 0.8, 1.2, 1.5, false),
  replaySpeed: a(6, 6, 6, 6, 6, false),
}

export const REGIME_SWITCH = {
  deltaProxy: 0.5,
  /** Seconds of the end of the segment that decide FOLLOW and FADE. */
  directionSec: 30,
  /** Taken off the score when the player repeats a playbook that stopped being the best after the regime changed. */
  perseverationPenalty: 0.25,
  /** Weights of the regime to change to (spikes are rare in real data). */
  nextWeights: { trend_up: 0.3, trend_down: 0.3, range: 0.3, spike: 0.1 },
  /** Playbook credit by rank: best, second, worst. */
  rankScores: [1, 0.5, 0],
} as const

/** Level Recall (spec 5.6, 15). */
export const LEVEL_RECALL_PARAMS: ParamTable = {
  rounds: a(6, 6, 7, 7, 8),
  /** How many levels the player must place. */
  levelCount: a(3, 4, 5, 6, 8),
  /** Seconds the levels are on screen, and the time to place them all. */
  studySec: a(20, 15, 10, 8, 5),
  recallSec: a(60, 50, 40, 30, 25),
  /** The error that scores nothing, in day volUnits (1 at level 1, 0.35 at level 20). */
  tolMult: a(1, 0.8, 0.6, 0.45, 0.35, false),
  /** Levels shown during the study that are never asked for. */
  distractors: a(0, 1, 2, 3, 4),
  /** 1 from level 10: every third round is the swing-sequence sub-mode. */
  sequence: steps([1, 0], [10, 1]),
}

export const LEVEL_RECALL = {
  /** Two levels shown together are at least this many day volUnits apart, so each has its own place on the ladder. */
  minSeparation: 0.15,
  /** ... and at least this share of the ladder's height apart, so two labels never sit on top of each other. */
  minAxisShare: 0.045,
  /** The swing threshold of the sequence sub-mode, in day volUnits, and the swings shown. */
  swingThreshold: 0.8,
  swings: 6,
  /** Round times: no earlier than 10:15 and no later than 14:25 (the opening range is over, and the session is not about to end). */
  openSec: 33_300,
  /** The prior session must be this close (calendar days) to count as "the day before". */
  maxPriorGapDays: 4,
  /** The ladder shows the day's range plus this share of it above and below. */
  axisPad: 0.12,
  floorUnits: 0.0001,
} as const

/** Spot the Trap (spec 5.9, 15). Mode A (breakout verdict) is always on; mode B (pattern hunt) alternates in from level 6. */
export const SPOT_THE_TRAP_PARAMS: ParamTable = {
  rounds: a(10, 10, 12, 12, 14),
  /** Seconds to call a breakout REAL or FAKE; a late call scores nothing. */
  decisionSec: a(12, 9, 6, 4, 3),
  /** 5 second bars on screen. */
  bars: a(40, 60, 80, 100, 120),
  /** Share of breakouts picked close to the REAL / FAKE boundary. */
  ambiguity: a(0, 0.1, 0.25, 0.4, 0.5, false),
  /** Seconds to find every occurrence in the hunt. */
  huntSec: a(30, 26, 20, 15, 12),
  /** How many of the four patterns the hunt asks for (2 from level 6, all four from level 16), and whether it is on at all. */
  patternPool: steps([1, 2], [11, 3], [16, 4]),
  modeB: steps([1, 0], [6, 1]),
  /** Near-miss candles a hunt stretch must contain at least (up to 3). */
  distractors: a(0, 1, 2, 3, 3),
}

export const SPOT_THE_TRAP = {
  /** A breakout is REAL if the price goes `extMult` volUnits beyond the level before it comes back `retMult` inside, within `horizonBars` bars. */
  extMult: 2,
  retMult: 0.5,
  horizonBars: 12,
  /** The breakout is of the highest high (lowest low) of the previous bars. */
  lookback: 24,
  /** Bars in a hunt, and how many true occurrences it may hold. */
  huntBars: 60,
  maxOccurrences: 6,
  /** A breakout whose furthest extension is within this share of the threshold counts as close to the boundary. */
  boundaryMargin: 0.35,
  /** The wait before a result can be dismissed is none: Space goes on. */
  minBarsBeforeBreakout: 20,
} as const

/** No-Trade Day (spec 5.10, 15): a session is three segments of a day replayed faster than real time. */
export const NO_TRADE_DAY_PARAMS: ParamTable = {
  /** Minutes of market data in a segment, and the minutes it takes to play (so the replay speed is `segMin / playMin`). */
  segMin: a(15, 18, 20, 22, 25),
  playMin: a(5, 4.6, 4.2, 3.6, 3, false),
  /** Rules the player must commit to before the segment starts (0 at level 1, 3 from level 15). */
  minRules: steps([1, 0], [5, 1], [10, 2], [15, 3]),
  /** The wanted efficiency ratio of the segment: lower means more chop and more bait. */
  targetEr: a(0.3, 0.24, 0.18, 0.12, 0.08, false),
  /** 1 while a rule break is flagged on screen as it happens (up to level 10). */
  warnings: steps([1, 1], [11, 0]),
  /** 1 from level 10: an early forced loss tests the cooldown. */
  tilt: steps([1, 0], [10, 1]),
  /** The risk of one trade (1 R) is this many volUnits scaled to a minute. */
  stopMult: a(1.2, 1.1, 1, 0.9, 0.8, false),
  slipMult: a(0, 0.4, 0.8, 1.2, 1.5, false),
}

export const NO_TRADE_DAY = {
  segments: 3,
  deltaProxy: 0.5,
  /** Rules and the limits the player may set (spec 5.10 step 1). */
  limits: {
    maxTrades: { min: 1, max: 10, default: 4 },
    maxLossR: { min: 1, max: 6, default: 3 },
    stopAfterLosses: { min: 1, max: 5, default: 2 },
    cooldownSec: { min: 10, max: 300, default: 60 },
    maxLots: { min: 1, max: 3, default: 1 },
  },
  /** Lots the player can trade (1 to this), and the cooldown that defines a revenge trade when no cooldown rule is chosen. */
  lotsMax: 3,
  revengeSec: 60,
  /** Trades the opportunity is computed for when no maximum-trades rule is chosen. */
  defaultOpportunityTrades: 5,
  /** The forced loss of a tilt event comes this far into the segment. */
  tiltAt: 0.25,
  violationPenalty: 0.25,
  revengePenalty: 0.25,
  /** Stand-aside credit: a quiet segment with at most one trade scores at least this performance. */
  standAsidePerf: 0.6,
  /** Opportunity below this is a quiet segment. */
  quietBelowR: 0.5,
  /** The swing threshold for the opportunity legs, in R. */
  legThresholdR: 1,
  minCoverage: 0.8,
} as const
