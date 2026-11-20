/** Green Light (Speed, spec 17.5 #3): press Space for GO symbols and hold back for NO-GO (go/no-go). */
import { paramsAt } from '../../../core/difficulty'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { BLOCK_SECONDS, GREEN_LIGHT_PARAMS, GREEN_LIGHT_RULE_BANNER_MS } from '../../config/difficulty.brain'
import { coefficientOfVariation, median } from '../../engine/rt'
import { detectionSkill, expectedTrials, round3, speedEmphasisScore, speedFactor, volumeFactor } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'
import { PALETTE } from '../../ui/palette'

export type GlResponse = 'press'
export type GlShape = 'circle' | 'square' | 'triangle'
export const GL_SHAPES: readonly GlShape[] = ['circle', 'square', 'triangle']
/** Palette indices used by Green Light: green, red, blue, orange. */
export const GL_COLOURS = [2, 3, 1, 0] as const
const GREEN = 2
const RED = 3

export type GlRule = { by: 'colour'; colour: number } | { by: 'shape'; shape: GlShape }
export interface GlTrial {
  shape: GlShape
  colour: number
  go: boolean
  /** The rule banner to show before this trial (start of the block, and after every rule change). */
  banner: string | null
  displayMs: number
  windowMs: number
  gapMs: number
  preMs: number
}

const CHUNK = 20
const matches = (rule: GlRule, shape: GlShape, colour: number) => (rule.by === 'colour' ? colour === rule.colour : shape === rule.shape)
const ruleText = (rule: GlRule) => (rule.by === 'colour' ? `GO = ${PALETTE[rule.colour].name.toLowerCase()} only` : `GO = ${rule.shape}s only`)
const RESPONSE_GRACE_MS = 150

export function createGreenLightEngine(params: Record<string, number>, rng: Rng): TrialEngine<GlTrial, GlResponse> {
  const stage = Math.min(2, Math.max(0, Math.round(params.stage)))
  const nogo = Math.round((params.nogoPct * CHUNK) / 100)
  const expected = Math.max(1, Math.floor((BLOCK_SECONDS.green_light * 1000) / (params.displayMs + params.isiMeanMs)))
  // Stage 2: a shuffled list of rules; rule i takes over at trial floor(i * expected / rules).
  const ruleCandidates: GlRule[] = [
    { by: 'colour', colour: 1 }, { by: 'shape', shape: 'square' }, { by: 'colour', colour: 0 }, { by: 'shape', shape: 'circle' },
  ]
  const rules = stage === 2 ? rng.shuffle(ruleCandidates).slice(0, Math.min(ruleCandidates.length, Math.round(params.ruleChanges) + 1)) : []
  const changeAt = rules.map((_, i) => Math.floor((i * expected) / rules.length))
  let queue: boolean[] = [] // true = go
  let index = 0

  const stimulus = (go: boolean, rule: GlRule | null): { shape: GlShape; colour: number } => {
    if (stage === 0) return go ? { shape: 'circle', colour: GREEN } : { shape: 'square', colour: RED }
    if (stage === 1) return { shape: go ? 'circle' : 'square', colour: rng.pick(GL_COLOURS) }
    const pool: Array<{ shape: GlShape; colour: number }> = []
    for (const shape of GL_SHAPES) for (const colour of GL_COLOURS) if (matches(rule as GlRule, shape, colour) === go) pool.push({ shape, colour })
    return rng.pick(pool)
  }

  return {
    next() {
      if (!queue.length) queue = rng.shuffle<boolean>([...Array(Math.max(0, CHUNK - nogo)).fill(true), ...Array(nogo).fill(false)])
      const go = queue.pop() as boolean
      let ruleIndex = 0
      for (let i = 0; i < changeAt.length; i++) if (index >= changeAt[i]) ruleIndex = i
      const rule = stage === 2 ? rules[ruleIndex] : null
      const banner = index === 0 || (stage === 2 && changeAt.includes(index))
        ? stage === 0 ? 'GO = green circle · hold back for the red square' : stage === 1 ? 'GO = any circle · hold back for any square' : ruleText(rule as GlRule)
        : null
      const { shape, colour } = stimulus(go, rule)
      const trial: GlTrial = {
        shape, colour, go, banner, displayMs: params.displayMs, windowMs: params.displayMs + RESPONSE_GRACE_MS,
        gapMs: Math.max(300, params.isiMeanMs + rng.int(-params.jitterMs, params.jitterMs)), preMs: banner ? GREEN_LIGHT_RULE_BANNER_MS : 0,
      }
      index += 1
      return trial
    },
    timing: (trial): TrialTiming => ({ displayMs: trial.displayMs, windowMs: trial.windowMs, gapMs: trial.gapMs, preMs: trial.preMs }),
    evaluate(trial, response): TrialOutcome {
      if (response === 'press') return trial.go ? { correct: true, tag: 'hit' } : { correct: false, tag: 'fa' }
      return trial.go ? { correct: false, tag: 'miss' } : { correct: true, tag: 'cr' }
    },
  }
}

export const describeGl = (trial: GlTrial): string => `${PALETTE[trial.colour].name.toLowerCase()} ${trial.shape} (${trial.go ? 'GO' : 'NO-GO'})`

export function summariseGreenLight(log: TrialLogEntry<GlTrial, GlResponse>[], level: number): SessionSummary {
  const p = paramsAt(GREEN_LIGHT_PARAMS, level)
  const goTrials = log.filter(entry => entry.trial.go)
  const noGoTrials = log.filter(entry => !entry.trial.go)
  const hits = goTrials.filter(entry => entry.outcome.tag === 'hit')
  const falseAlarms = noGoTrials.filter(entry => entry.outcome.tag === 'fa')
  const hitRts = hits.filter(entry => entry.rtMs !== null).map(entry => entry.rtMs as number)
  const medianRt = median(hitRts)
  const skill = detectionSkill(hits.length, goTrials.length, falseAlarms.length, noGoTrials.length)
  const speed = speedFactor(medianRt, p.rtFast, p.rtSlow)
  const expected = expectedTrials(BLOCK_SECONDS.green_light, p.displayMs, p.isiMeanMs)
  const score = speedEmphasisScore(skill, speed, volumeFactor(log.length, expected), 0.3)
  const cv = coefficientOfVariation(hitRts)
  const review: ReviewRow[] = log.slice(0, 250).map(entry => ({
    n: entry.n, shown: describeGl(entry.trial), answered: entry.response === 'press' ? 'pressed' : 'held back',
    correctAnswer: entry.trial.go ? 'press' : 'hold back', correct: entry.outcome.correct, rtMs: entry.rtMs,
  }))
  return {
    score,
    stats: {
      trials: log.length, hit_rate: goTrials.length ? round3(hits.length / goTrials.length) : 0,
      false_alarm_rate: noGoTrials.length ? round3(falseAlarms.length / noGoTrials.length) : 0,
      median_rt: Math.round(medianRt ?? 0), rt_cv: cv === undefined ? 0 : round3(cv),
      anticipations: log.filter(entry => entry.outcome.anticipated).length,
    },
    review,
  }
}

/** Detection game: the "response" is pressing Space or not pressing at all. */
export const greenLightSim: SimPlayer<GlTrial, GlResponse> = {
  correct: trial => (trial.go ? 'press' : 'timeout'),
  random: (_trial, rng) => (rng.chance(0.5) ? 'press' : 'timeout'),
  alwaysPress: () => 'press',
  neverPress: () => 'timeout',
}
