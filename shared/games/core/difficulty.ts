/**
 * Levels 1-20 per game. A parameter is either
 *  - `anchors`: values at levels 1, 5, 10, 15, 20, linearly interpolated (integers rounded when `integer`), or
 *  - `steps`: a categorical value that changes at given levels (item kind, banner mode, reverse recall ...).
 * (Spec section 6.1 plus the step parameters found in Sprint B0, correction C5.)
 */
export const MIN_LEVEL = 1
export const MAX_LEVEL = 20
export const ANCHOR_LEVELS = [1, 5, 10, 15, 20] as const

export type AnchorParam = { anchors: [number, number, number, number, number]; integer?: boolean }
export type StepParam = { steps: Array<{ from: number; v: number }> }
export type ParamSpec = AnchorParam | StepParam
export type ParamTable = Record<string, ParamSpec>

export const clampLevel = (level: number): number => Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(Number.isFinite(level) ? level : MIN_LEVEL)))

export function valueAt(spec: ParamSpec, level: number): number {
  const at = clampLevel(level)
  if ('steps' in spec) {
    const ordered = [...spec.steps].sort((a, b) => a.from - b.from)
    if (!ordered.length) throw new Error('A step parameter needs at least one step')
    let value = ordered[0].v
    for (const step of ordered) if (at >= step.from) value = step.v
    return value
  }
  const { anchors, integer } = spec
  for (let i = 0; i < ANCHOR_LEVELS.length - 1; i++) {
    const lo = ANCHOR_LEVELS[i]
    const hi = ANCHOR_LEVELS[i + 1]
    if (at <= hi) {
      const ratio = (at - lo) / (hi - lo)
      const value = anchors[i] + (anchors[i + 1] - anchors[i]) * ratio
      return integer ? Math.round(value) : value
    }
  }
  return anchors[anchors.length - 1]
}

export function paramsAt(table: ParamTable, level: number): Record<string, number> {
  return Object.fromEntries(Object.entries(table).map(([name, spec]) => [name, valueAt(spec, level)]))
}

export function levelBand(level: number): 'Warm-up' | 'Trader' | 'Pro' | 'Elite' {
  const at = clampLevel(level)
  return at <= 5 ? 'Warm-up' : at <= 10 ? 'Trader' : at <= 15 ? 'Pro' : 'Elite'
}

export interface LevelRules { upThreshold: number; downThreshold: number }
export const DEFAULT_LEVEL_RULES: LevelRules = { upThreshold: 70, downThreshold: 40 }

export interface LevelState { level: number; consecutiveHigh: number; consecutiveLow: number }
export const INITIAL_LEVEL_STATE: LevelState = { level: 1, consecutiveHigh: 0, consecutiveLow: 0 }

/**
 * After a Progress session (spec 6.2): up one level after two scores in a row at or above `upThreshold` at the
 * current level, down one after two at or below `downThreshold`, never below 1 or above 20, at most one change
 * per session, counters reset on a change. Practice sessions never call this.
 */
export function applyLevelRule(state: LevelState, score: number, rules: LevelRules = DEFAULT_LEVEL_RULES): LevelState & { change: -1 | 0 | 1 } {
  const level = clampLevel(state.level)
  let high = score >= rules.upThreshold ? state.consecutiveHigh + 1 : 0
  let low = score <= rules.downThreshold ? state.consecutiveLow + 1 : 0
  if (high >= 2 && level < MAX_LEVEL) return { level: level + 1, consecutiveHigh: 0, consecutiveLow: 0, change: 1 }
  if (low >= 2 && level > MIN_LEVEL) return { level: level - 1, consecutiveHigh: 0, consecutiveLow: 0, change: -1 }
  // At a boundary the streak keeps counting but cannot move the level.
  if (high >= 2 && level >= MAX_LEVEL) high = 2
  if (low >= 2 && level <= MIN_LEVEL) low = 2
  return { level, consecutiveHigh: high, consecutiveLow: low, change: 0 }
}
