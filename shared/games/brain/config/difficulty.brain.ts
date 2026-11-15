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

export const BLOCK_SECONDS = { quick_match: 60, colour_clash: 60, green_light: 75 } as const
export const GREEN_LIGHT_RULE_BANNER_MS = 1500
