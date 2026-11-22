/** Flip Map (Flexibility, spec 17.5 #12): an arrow appears; press the key the CURRENT mapping rule asks for. Pure engine and scoring. */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { BLOCK_SECONDS, FLIP_MAP_PARAMS } from '../../config/difficulty.brain'
import { median } from '../../engine/rt'
import { choiceSkill, expectedTrials, round3, speedEmphasisScore, speedFactor, volumeFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

export type FmDir = 'up' | 'right' | 'down' | 'left'
export type FmRule = 'same' | 'opposite' | 'turn'
export type FmResponse = FmDir
const DIRS: FmDir[] = ['up', 'right', 'down', 'left']
const RULES: FmRule[] = ['same', 'opposite', 'turn']
export const MIN_RUN = 4
export const MAX_RUN = 12
export const BANNER_MS = 1500
export const GLYPH: Record<FmDir, string> = { up: '↑', right: '→', down: '↓', left: '←' }
export const RULE_TEXT: Record<FmRule, string> = {
  same: 'SAME: press the arrow’s own direction', opposite: 'OPPOSITE: press the other way', turn: 'TURN: press 90° clockwise from it',
}

export const mapDir = (dir: FmDir, rule: FmRule): FmDir => {
  const at = DIRS.indexOf(dir)
  return rule === 'same' ? dir : rule === 'opposite' ? DIRS[(at + 2) % 4] : DIRS[(at + 1) % 4]
}

export interface FmTrial {
  dir: FmDir
  rule: FmRule
  expected: FmDir
  /** The rule before the latest change; `null` until the first change. */
  prevRule: FmRule | null
  /** What the previous rule would have wanted: pressing it is a perseverative error. */
  oldAnswer: FmDir | null
  /** Judged trials since the last change (0 = the first trial under the new rule). */
  sinceChange: number
  /** The rule has changed at least once, so `sinceChange` measures adaptation. */
  changed: boolean
  /** 0 the rule stays on screen, 1 shown for 1.5 s after a change, 2 never shown. */
  bannerMode: 0 | 1 | 2
  displayMs: number
  windowMs: number
  gapMs: number
  preMs: number
}

export function createFlipMapEngine(params: Record<string, number>, rng: Rng): TrialEngine<FmTrial, FmResponse> {
  const rules = RULES.slice(0, Math.max(2, Math.min(3, Math.round(params.rules))))
  const bannerMode = Math.max(0, Math.min(2, Math.round(params.banner))) as 0 | 1 | 2
  // Rule state moves when a trial is judged, so a replaced trial changes nothing.
  let rule: FmRule = rng.pick(rules)
  let prevRule: FmRule | null = null
  let left = rng.int(MIN_RUN, MAX_RUN)
  let since = 0
  let judged = 0
  let changes = 0
  return {
    next() {
      const dir = rng.pick(DIRS)
      return {
        dir, rule, expected: mapDir(dir, rule), prevRule, oldAnswer: prevRule ? mapDir(dir, prevRule) : null, sinceChange: since, changed: changes > 0,
        bannerMode, displayMs: params.displayMs, windowMs: params.windowMs, gapMs: params.gapMs,
        // "Banner for 1.5 s after a change" also covers the very first rule of the block.
        preMs: bannerMode === 1 && since === 0 ? BANNER_MS : 0,
      }
    },
    timing: (trial): TrialTiming => ({ displayMs: trial.displayMs, windowMs: trial.windowMs, gapMs: trial.gapMs, preMs: trial.preMs }),
    evaluate(trial, response): TrialOutcome {
      judged += 1; since += 1; left -= 1
      if (left <= 0) {
        prevRule = rule
        rule = rng.pick(rules.filter(r => r !== rule))
        left = rng.int(MIN_RUN, MAX_RUN)
        since = 0
        changes += 1
      }
      const correct = response !== 'timeout' && response === trial.expected
      const tag = correct ? 'ok' : response !== 'timeout' && trial.oldAnswer !== null && response === trial.oldAnswer && trial.sinceChange < 4 ? 'persev' : 'wrong'
      return { correct, tag }
    },
    progress: () => ({ trial: judged }),
  }
}

export const bannerText = (trial: FmTrial): string | null => (trial.bannerMode === 1 && trial.preMs > 0 ? `${RULE_TEXT[trial.rule]}` : null)
export const describeFm = (trial: FmTrial): string => `${GLYPH[trial.dir]} under ${trial.rule.toUpperCase()}${trial.sinceChange === 0 && trial.changed ? ' (just changed)' : ''}`

export function summariseFlipMap(log: TrialLogEntry<FmTrial, FmResponse>[], level: number): SessionSummary {
  const p = paramsAt(FLIP_MAP_PARAMS, level)
  const valid = log.length
  const correct = log.filter(entry => entry.outcome.correct).length
  const rtOf = (entries: typeof log) => entries.filter(entry => entry.outcome.correct && entry.rtMs !== null).map(entry => entry.rtMs as number)
  const medianRt = median(rtOf(log))
  const skill = choiceSkill(correct, valid, 4)
  const speed = speedFactor(medianRt, p.rtFast, p.rtSlow)
  const expected = expectedTrials(BLOCK_SECONDS.flip_map, (p.rtFast + p.rtSlow) / 2, p.gapMs)
  const score = speedEmphasisScore(skill, speed, volumeFactor(valid, expected))
  const after = log.filter(entry => entry.trial.changed && entry.trial.sinceChange < 2)
  const steady = log.filter(entry => !entry.trial.changed || entry.trial.sinceChange >= 2)
  const accuracy = (entries: typeof log) => (entries.length ? entries.filter(entry => entry.outcome.correct).length / entries.length : 0)
  const ruleRt = (rule: FmRule) => median(rtOf(log.filter(entry => entry.trial.rule === rule)))
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: describeFm(entry.trial), answered: entry.response === 'timeout' ? 'no answer' : GLYPH[entry.response as FmDir], correctAnswer: GLYPH[entry.trial.expected],
    correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      trials: valid, accuracy: valid ? round3(correct / valid) : 0, median_rt: Math.round(medianRt ?? 0),
      acc_after_change_pct: Math.round(accuracy(after) * 100), acc_steady_pct: Math.round(accuracy(steady) * 100),
      // Adaptation cost: how much accuracy drops on the first two trials after the rule changes.
      adaptation_cost_pct: after.length ? Math.round((accuracy(steady) - accuracy(after)) * 100) : 0,
      median_rt_same: Math.round(ruleRt('same') ?? 0), median_rt_opposite: Math.round(ruleRt('opposite') ?? 0), median_rt_turn: Math.round(ruleRt('turn') ?? 0),
      persev_errors: log.filter(entry => entry.outcome.tag === 'persev').length, changes: log.filter(entry => entry.trial.changed && entry.trial.sinceChange === 0).length,
      anticipations: log.filter(entry => entry.outcome.anticipated).length, lapses: log.filter(entry => entry.response === 'timeout').length,
    },
    review,
  }
}

export const flipMapSim: SimPlayer<FmTrial, FmResponse> = {
  correct: trial => trial.expected,
  random: (_trial, rng) => rng.pick(DIRS),
}
