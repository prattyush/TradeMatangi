/**
 * First-pass parameter anchors for the brain games (L1 / L5 / L10 / L15 / L20), from the Sprint B0 plan
 * (docs/spec-phase25-implementation-plan.md, "First parameter anchors"). Typed TypeScript instead of JSON so the tables are
 * checked by the compiler. All numbers are provisional: each sprint tunes them from the owner's play.
 * Times in ms. `steps` are categorical: the value changes at the given level.
 */
import type { ParamTable } from '../../core/difficulty'

const a = (l1: number, l5: number, l10: number, l15: number, l20: number, integer = true) => ({ anchors: [l1, l5, l10, l15, l20] as [number, number, number, number, number], integer })
const steps = (...list: Array<[number, number]>) => ({ steps: list.map(([from, v]) => ({ from, v })) })

/** Display times at or above this mean "until answered" (Quick Match level 1). */
export const UNTIL_ANSWERED_MS = 6000

export const QUICK_MATCH_PARAMS: ParamTable = {
  displayMs: a(6000, 3000, 1500, 900, 600),
  windowMs: a(3000, 2500, 2000, 1600, 1200),
  // 0 circles, 1 polygons, 2 rotated and mirrored polygons
  kind: steps([1, 0], [6, 1], [13, 2]),
  // How alike a "different" pair is: low = clearly different, 1 = one small feature
  similarity: a(0.2, 0.4, 0.6, 0.8, 1.0, false),
  gapMs: a(400, 400, 400, 400, 400),
  rtFast: a(450, 420, 390, 370, 350),
  rtSlow: a(1800, 1500, 1300, 1200, 1100),
}

export const COLOUR_CLASH_PARAMS: ParamTable = {
  colours: a(4, 4, 5, 6, 6),
  incongruentPct: a(25, 35, 45, 55, 65),
  neutralPct: a(0, 0, 0, 10, 15),
  windowMs: a(3000, 2500, 1900, 1400, 1100),
  // swatch order is shuffled every trial from level 16
  shuffle: steps([1, 0], [16, 1]),
  gapMs: a(400, 400, 400, 400, 400),
  rtFast: a(550, 520, 500, 480, 450),
  rtSlow: a(2200, 1900, 1700, 1500, 1400),
}

export const GREEN_LIGHT_PARAMS: ParamTable = {
  displayMs: a(1000, 850, 700, 550, 450),
  isiMeanMs: a(1000, 1000, 1000, 1000, 1000),
  jitterMs: a(200, 300, 400, 500, 600),
  nogoPct: a(15, 20, 25, 30, 35),
  // 0 green circle / red square, 1 any circle / any square, 2 the GO rule changes during the block
  stage: steps([1, 0], [6, 1], [13, 2]),
  ruleChanges: a(0, 0, 0, 2, 3),
  rtFast: a(280, 270, 260, 250, 240),
  rtSlow: a(700, 650, 600, 550, 500),
}

// ---- Memory ------------------------------------------------------------------------------------------------------------
export const GRID_RECALL_PARAMS: ParamTable = {
  gridN: a(3, 4, 5, 5, 6),
  startSpan: a(3, 3, 4, 4, 5),
  // tiles added after a success: 2 at levels 1-3, then 1
  spanStep: steps([1, 2], [4, 1]),
  flashMs: a(700, 600, 500, 400, 300),
  gapMs: a(200, 200, 200, 200, 200),
  // 0 tiles flash one by one, recall in order | 1 all at once, recall in any order (L8-11) | 2 one by one, recall in REVERSE (L12+)
  mode: steps([1, 0], [8, 1], [12, 2]),
  // from level 18 the grid is turned or flipped before recall
  transform: steps([1, 0], [18, 1]),
}

export const SEQUENCE_ECHO_PARAMS: ParamTable = {
  items: a(4, 5, 6, 8, 9),
  startSpan: a(3, 3, 4, 5, 6),
  itemMs: a(800, 650, 500, 400, 300),
  gapMs: a(250, 250, 250, 250, 250),
  // 0 coloured pads | 1 digits (L10-17) | 2 letters (L18+)
  kind: steps([1, 0], [10, 1], [18, 2]),
  backward: steps([1, 0], [8, 1]),
  // a different-coloured flash between items that must be ignored (from level 15)
  distractor: steps([1, 0], [15, 1]),
}

export const N_BACK_PARAMS: ParamTable = {
  itemMs: a(2000, 1800, 1500, 1300, 1200),
  // the item is on screen for itemMs minus this blank gap
  blankMs: a(500, 500, 500, 500, 500),
  n: steps([1, 1], [6, 2], [13, 3], [19, 4]),
  matchPct: a(30, 28, 27, 25, 25),
  lurePct: a(0, 0, 10, 12, 15),
  dual: steps([1, 0], [16, 1]),
  rtFast: a(450, 450, 450, 450, 450),
  rtSlow: a(1100, 1100, 1100, 1100, 1100),
}

// ---- Attention ---------------------------------------------------------------------------------------------------------
export const FLANKER_PARAMS: ParamTable = {
  flankers: a(2, 3, 4, 5, 6),
  incongruentPct: a(33, 40, 50, 58, 66),
  neutralPct: a(20, 15, 10, 5, 0),
  displayMs: a(1500, 1200, 900, 700, 500),
  windowMs: a(2000, 1700, 1400, 1100, 900),
  // the row sits at a random vertical offset (from level 10)
  jitter: steps([1, 0], [10, 1]),
  // two rows, a cue says which one counts, the other is a decoy (from level 14)
  decoyRow: steps([1, 0], [14, 1]),
  gapMs: a(400, 400, 400, 400, 400),
  rtFast: a(330, 320, 310, 300, 290),
  rtSlow: a(1400, 1250, 1100, 950, 800),
}

export const NEEDLE_FINDER_PARAMS: ParamTable = {
  setSize: a(8, 14, 24, 40, 60),
  limitMs: a(15000, 12000, 10000, 7000, 5000),
  absentPct: a(20, 22, 25, 28, 30),
  // 0 feature search (one colour differs) | 1 conjunction search (colour and orientation) | 2 conjunction plus a second distractor kind
  mode: steps([1, 0], [7, 1], [15, 2]),
  jitter: a(0, 0.1, 0.2, 0.3, 0.4, false),
  gapMs: a(600, 600, 600, 600, 600),
  // Search-time scale for the speed bonus: an ideal player finds it in a twentieth of the limit; the limit scores 0 speed.
  rtFast: a(750, 600, 500, 350, 250),
  rtSlow: a(15000, 12000, 10000, 7000, 5000),
}

export const TRACK_DOTS_PARAMS: ParamTable = {
  dots: a(8, 10, 12, 14, 16),
  targets: a(2, 3, 4, 5, 6),
  speed: a(80, 110, 150, 190, 220),
  motionMs: a(5000, 6000, 7000, 9000, 10000),
  markMs: a(2000, 2000, 2000, 2000, 2000),
  occluder: steps([1, 0], [12, 1]),
  flicker: steps([1, 0], [16, 1]),
}

// ---- Flexibility -------------------------------------------------------------------------------------------------------
export const RULE_SWITCH_PARAMS: ParamTable = {
  // number rule and letter rule; the size rule (digit above or below 5) joins at level 16
  rules: steps([1, 2], [16, 3]),
  // 0 predictable alternation AABB | 1 random switches (about half of the trials)
  schedule: steps([1, 0], [6, 1]),
  // time between the cue and the card; 0 = the cue appears WITH the card (no preparation, level 13+)
  cueMs: steps([1, 1000], [6, 500], [13, 0]),
  windowMs: a(3500, 3000, 2500, 2200, 2000),
  gapMs: a(400, 350, 300, 300, 300),
  rtFast: a(600, 560, 520, 490, 460),
  rtSlow: a(2200, 1900, 1700, 1450, 1200),
}

export const CARD_SORTER_PARAMS: ParamTable = {
  // colour and shape only, then count too from level 8
  rules: steps([1, 2], [8, 3]),
  // consecutive correct cards that complete a category; the rule then changes silently
  runLength: a(10, 8, 7, 6, 5),
  // share of cards that match two reference cards on two dimensions at once (the answer then does not reveal the rule)
  ambiguousPct: a(0, 5, 10, 18, 25),
  // feedback ("match" / "no match") appears this long after the click (level 15+)
  feedbackDelayMs: steps([1, 0], [15, 600]),
  // categories that earn the full score (spec default 6; scaled down at low levels where ten correct cards per category make six unreachable)
  categoryTarget: a(4, 4, 5, 6, 6),
  gapMs: a(900, 900, 900, 900, 900),
}

export const FLIP_MAP_PARAMS: ParamTable = {
  // SAME and OPPOSITE; TURN (the key 90 degrees clockwise) joins at level 16
  rules: steps([1, 2], [16, 3]),
  // 0 the rule stays on screen | 1 the rule shows for 1.5 s after a change | 2 no banner: infer the change from the error flash
  banner: steps([1, 0], [7, 1], [13, 2]),
  displayMs: a(2000, 1800, 1500, 1200, 900),
  windowMs: a(2600, 2300, 1900, 1600, 1300),
  gapMs: a(400, 380, 350, 320, 300),
  rtFast: a(450, 430, 410, 390, 370),
  rtSlow: a(1800, 1600, 1350, 1150, 1000),
}

// ---- Math --------------------------------------------------------------------------------------------------------------
export const NUMBER_SPRINT_PARAMS: ParamTable = {
  // 0 plus and minus | 1 plus, minus, times, divide | 2 half of the problems are two-step
  ops: steps([1, 0], [5, 1], [10, 2]),
  addMax: a(9, 30, 99, 300, 999),
  mulMax: a(5, 9, 12, 20, 30),
  // carries and borrows are allowed from level 3 (before, additions never carry and subtractions never borrow)
  carry: steps([1, 0], [3, 1]),
  negatives: steps([1, 0], [12, 1]),
  decimals: steps([1, 0], [16, 1]),
  // soft time: the speed bonus runs out here; the problem is dropped (scores 0) at windowMs
  tqMs: a(12000, 10000, 8000, 6000, 4000),
  windowMs: a(24000, 20000, 16000, 12000, 8000),
  gapMs: a(120, 120, 120, 120, 120),
  // weighted total a full-skill player reaches in the 90 s block (provisional, tuned from the owner's play)
  itemsTarget: a(40, 36, 30, 25, 20, false),
  rtFast: a(1800, 2000, 2400, 2800, 3000),
  rtSlow: a(12000, 10000, 8000, 6000, 4000),
}

export const EQUATION_DROP_PARAMS: ParamTable = {
  maxDrops: a(2, 3, 4, 5, 6),
  // seconds a drop takes to fall: it starts at fallStartMs and shortens linearly to fallEndMs by the end of the block
  fallStartMs: a(10000, 9000, 8000, 7000, 6000),
  fallEndMs: a(7000, 6000, 5000, 4000, 3000),
  ops: steps([1, 0], [5, 1], [10, 2]),
  addMax: a(9, 20, 50, 99, 200),
  mulMax: a(5, 9, 12, 15, 20),
  // from level 12 some drops are "reverse": an answer falls and the player types the missing number
  reverse: steps([1, 0], [12, 1]),
  // weighted clears that earn the full score (provisional)
  target: a(33, 52, 55, 50, 46, false),
  // Fastest sustained clearing time per equation (typing included). Equations never spawn faster than 1.1 x this, so a perfect player can always keep up.
  rtFast: a(1500, 1600, 1800, 2000, 2200),
  // Slowest clear a player would manage (about the time a drop takes to fall); only the registry check and the random player use it.
  rtSlow: a(9000, 8000, 7000, 6000, 5000),
}

export const MAKE_TARGET_PARAMS: ParamTable = {
  numbers: a(4, 4, 5, 5, 6),
  targetMax: a(60, 99, 300, 700, 999),
  // fewest operations any solution needs (the solver proves it)
  minDepth: a(2, 2, 3, 4, 5),
  // big numbers (25, 50, 75, 100) mixed in among the small ones
  bigNumbers: a(0, 0, 1, 1, 2),
  limitMs: a(60000, 55000, 45000, 38000, 30000),
  // up to level 6 a submitted value this close to the target earns half credit
  tolerance: steps([1, 2], [7, 0]),
  gapMs: a(600, 600, 600, 600, 600),
  rtFast: a(12000, 11000, 9000, 7600, 6000),
  // The time limit: a puzzle solved at the limit earns no speed bonus.
  rtSlow: a(60000, 55000, 45000, 38000, 30000),
}

// ---- Reasoning ---------------------------------------------------------------------------------------------------------
export const PATTERN_MATRIX_PARAMS: ParamTable = {
  // attributes that follow a rule (the rest stay fixed): shape, count, size, colour, rotation, shading
  rules: a(1, 2, 3, 4, 4),
  options: a(6, 6, 7, 8, 8),
  limitMs: a(90000, 80000, 65000, 50000, 40000),
  // share of wrong options that differ from the right one in exactly one attribute (low = several differences, easy to dismiss)
  similarity: a(0.2, 0.4, 0.6, 0.8, 1.0, false),
  // a dot-mask attribute where the third cell is the XOR or AND of the first two (from level 14)
  overlay: steps([1, 0], [14, 1]),
  gapMs: a(600, 600, 600, 600, 600),
  // a fast but careful solve (the speed bonus is 15 % of the score); RT_slow is the time limit
  rtFast: a(14000, 13000, 12000, 10000, 8000),
  rtSlow: a(90000, 80000, 65000, 50000, 40000),
}

export const NUMBER_SERIES_PARAMS: ParamTable = {
  // 0 arithmetic and geometric | 1 adds alternating and second-order | 2 adds powers, linear and Fibonacci-like | 3 adds interleaved series | 4 adds digit-sum and composite rules
  tier: steps([1, 0], [5, 1], [9, 2], [13, 3], [17, 4]),
  shown: a(8, 7, 6, 5, 5),
  limitMs: a(60000, 50000, 40000, 32000, 25000),
  // 0 pick the answer from 5 options | 1 type the answer (level 15+)
  typed: steps([1, 0], [15, 1]),
  gapMs: a(600, 600, 600, 600, 600),
  rtFast: a(7000, 7000, 7000, 7000, 6000),
  rtSlow: a(60000, 50000, 40000, 32000, 25000),
}

export const CODE_BREAKER_PARAMS: ParamTable = {
  // Spec: L 3 to 5, S 4 to 8. Level 1 starts at 5 symbols (60 codes, not 24): with 24 a random guesser solved about one code in eight by luck (C19).
  length: a(3, 4, 4, 5, 5),
  symbols: a(5, 6, 6, 7, 8),
  // from level 10 a symbol can appear more than once in the code
  repeats: steps([1, 0], [10, 1]),
  guesses: a(10, 10, 9, 8, 8),
  // from level 16 one feedback value of each code is hidden ("?")
  hidden: steps([1, 0], [16, 1]),
  gapMs: a(800, 800, 800, 800, 800),
  rtFast: a(25000, 30000, 40000, 50000, 60000),
  rtSlow: a(300000, 300000, 300000, 300000, 300000),
}

export const BLOCK_SECONDS = { quick_match: 60, colour_clash: 60, green_light: 75, n_back_stream: 90, flanker_flock: 60, rule_switch: 75, flip_map: 75, number_sprint: 90, equation_drop: 90 } as const
export const ROUND_COUNTS = { needle_finder: 20, track_the_dots: 8, card_sorter: 64, make_target: 8, pattern_matrix: 10, number_series: 12, code_breaker: 6 } as const
/** Three strikes end a span game. */
export const MAX_STRIKES = 3
/** Hard ceiling on the span in the two span games (spec 17.5, correction C1). */
export const SPAN_CAP = 12
export const GREEN_LIGHT_RULE_BANNER_MS = 1500
