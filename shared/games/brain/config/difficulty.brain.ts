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

export const BLOCK_SECONDS = { quick_match: 60, colour_clash: 60, green_light: 75, n_back_stream: 90, flanker_flock: 60 } as const
export const ROUND_COUNTS = { needle_finder: 20, track_the_dots: 8 } as const
/** Three strikes end a span game. */
export const MAX_STRIKES = 3
/** Hard ceiling on the span in the two span games (spec 17.5, correction C1). */
export const SPAN_CAP = 12
export const GREEN_LIGHT_RULE_BANNER_MS = 1500
