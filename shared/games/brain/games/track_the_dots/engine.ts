/**
 * Track the Dots (Attention, spec 17.5 #9): follow the marked dots as they move among identical ones, then click them.
 *
 * Motion is computed ahead on a fixed timestep (`DOT_STEP_MS`, 120 steps a second) from the seeded stream, so the same seed
 * always gives the same trajectories and a session can be replayed exactly in Review. The view only reads positions out of
 * `frames`, indexed by elapsed time.
 */
import { paramsAt } from '../../../core/difficulty'
import { clamp01, toSessionScore } from '../../../core/scoring'
import type { Rng } from '../../../core/rng'
import type { ReviewRow, StageSpec, TrialEngine, TrialLogEntry, TrialOutcome, TrialTiming } from '../../../core/trial'
import type { SessionSummary } from '../../../core/types'
import { ROUND_COUNTS, TRACK_DOTS_PARAMS } from '../../config/difficulty.brain'
import { round3 } from '../../engine/scoringBrain'
import type { SimPlayer } from '../../engine/simPlayers'

export const DOT_STEP_MS = 1000 / 120
export const ARENA_W = 600
export const ARENA_H = 400
export const DOT_RADIUS = 14
const MIN_GAP = 4 * DOT_RADIUS
/** The occluder: dots pass behind this translucent rectangle from level 12. */
export const OCCLUDER = { x: 220, y: 130, w: 160, h: 140 }

export interface DotFlicker { atMs: number; durMs: number; dots: number[] }
export interface TdTrial {
  dots: number
  /** Indices of the dots to follow. */
  targets: number[]
  speed: number
  markMs: number
  motionMs: number
  occluder: boolean
  /** Short brightness blips on non-target dots that are meant to pull your eyes away (from level 16). */
  flicker: DotFlicker[]
  /** Positions, `steps + 1` frames of `dots` (x, y) pairs: frames[(step * dots + dot) * 2]. */
  frames: Float32Array
  steps: number
}
/** Dots the player picked. */
export type TdResponse = number[]

/** Position of a dot at a frame (clamped to the last one). */
export function dotAt(trial: TdTrial, step: number, dot: number): { x: number; y: number } {
  const s = Math.min(trial.steps, Math.max(0, step))
  const i = (s * trial.dots + dot) * 2
  return { x: trial.frames[i], y: trial.frames[i + 1] }
}
export const stepAtMs = (ms: number): number => Math.floor(ms / DOT_STEP_MS)

function simulate(rng: Rng, dots: number, speed: number, motionMs: number): { frames: Float32Array; steps: number } {
  const steps = Math.ceil(motionMs / DOT_STEP_MS)
  const frames = new Float32Array((steps + 1) * dots * 2)
  const x: number[] = [], y: number[] = [], angle: number[] = []
  for (let d = 0; d < dots; d++) {
    let px = 0, py = 0
    for (let attempt = 0; attempt < 200; attempt++) {
      px = DOT_RADIUS + rng.next() * (ARENA_W - 2 * DOT_RADIUS)
      py = DOT_RADIUS + rng.next() * (ARENA_H - 2 * DOT_RADIUS)
      if (x.every((ox, i) => Math.hypot(ox - px, y[i] - py) >= MIN_GAP)) break
    }
    x.push(px); y.push(py); angle.push(rng.next() * Math.PI * 2)
  }
  const stepPx = (speed * DOT_STEP_MS) / 1000
  const turnEvery = Math.round(500 / DOT_STEP_MS)
  for (let s = 0; s <= steps; s++) {
    for (let d = 0; d < dots; d++) {
      frames[(s * dots + d) * 2] = x[d]
      frames[(s * dots + d) * 2 + 1] = y[d]
    }
    if (s === steps) break
    for (let d = 0; d < dots; d++) {
      // A small random turn every half second keeps the paths from being predictable, then walls reflect.
      if (s > 0 && s % turnEvery === 0) angle[d] += (rng.next() - 0.5) * (Math.PI / 3) * 2
      let nx = x[d] + Math.cos(angle[d]) * stepPx, ny = y[d] + Math.sin(angle[d]) * stepPx
      if (nx < DOT_RADIUS || nx > ARENA_W - DOT_RADIUS) { angle[d] = Math.PI - angle[d]; nx = Math.min(ARENA_W - DOT_RADIUS, Math.max(DOT_RADIUS, nx)) }
      if (ny < DOT_RADIUS || ny > ARENA_H - DOT_RADIUS) { angle[d] = -angle[d]; ny = Math.min(ARENA_H - DOT_RADIUS, Math.max(DOT_RADIUS, ny)) }
      x[d] = nx; y[d] = ny
    }
  }
  return { frames, steps }
}

export function createTrackDotsEngine(params: Record<string, number>, rng: Rng): TrialEngine<TdTrial, TdResponse> {
  const dots = Math.round(params.dots)
  const targetCount = Math.min(dots - 1, Math.round(params.targets))
  // Counted when judged, so a round replaced after a bad frame does not use up one of the eight.
  let judged = 0
  const total = ROUND_COUNTS.track_the_dots
  return {
    next() {
      if (judged >= total) return null
      const order = rng.shuffle(Array.from({ length: dots }, (_, i) => i))
      const targets = order.slice(0, targetCount).sort((a, b) => a - b)
      const others = order.slice(targetCount)
      const { frames, steps } = simulate(rng, dots, params.speed, params.motionMs)
      const flicker: DotFlicker[] = []
      if (params.flicker >= 1) {
        for (let i = 0; i < 5; i++) flicker.push({ atMs: Math.round(800 + rng.next() * (params.motionMs - 1600)), durMs: 120, dots: rng.shuffle(others).slice(0, 2) })
        flicker.sort((a, b) => a.atMs - b.atMs)
      }
      return { dots, targets, speed: params.speed, markMs: params.markMs, motionMs: params.motionMs, occluder: params.occluder >= 1, flicker, frames, steps }
    },
    timing: (): TrialTiming => ({ displayMs: null, windowMs: 600_000, gapMs: 0 }),
    stages: (trial): StageSpec[] => [
      { name: 'mark', ms: trial.markMs, critical: true },
      { name: 'move', ms: trial.motionMs, critical: true },
      { name: 'respond', ms: null },
    ],
    evaluate(trial, response): TrialOutcome {
      judged += 1
      const hits = tdHits(trial, response === 'timeout' ? [] : response)
      return { correct: hits === trial.targets.length, tag: `${hits}/${trial.targets.length}` }
    },
    progress: () => ({ trial: judged, of: total }),
  }
}

export function tdHits(trial: TdTrial, response: TdResponse): number {
  const wanted = new Set(trial.targets)
  return new Set(response.filter(dot => wanted.has(dot))).size
}

/**
 * Skill of one trial: hit fraction corrected for picking at random (`targets / dots`), so 0 is chance and 1 is perfect.
 * It is deliberately NOT clamped here: the score applies the spec's formula to the accuracy over the whole session
 * (clamp once at the end). Clamping every trial would turn chance-level luck into a positive average.
 */
export function tdSkill(trial: TdTrial, response: TdResponse): number {
  const fraction = tdHits(trial, response) / trial.targets.length
  const chance = trial.targets.length / trial.dots
  return (fraction - chance) / (1 - chance)
}

export function summariseTrackDots(log: TrialLogEntry<TdTrial, TdResponse>[], level: number): SessionSummary {
  const p = paramsAt(TRACK_DOTS_PARAMS, level)
  const responses = log.map(entry => (entry.response === 'timeout' ? [] : entry.response))
  const skills = log.map((entry, i) => tdSkill(entry.trial, responses[i]))
  const fractions = log.map((entry, i) => tdHits(entry.trial, responses[i]) / entry.trial.targets.length)
  const review: ReviewRow[] = log.map((entry, i) => ({
    n: entry.n, shown: `${entry.trial.dots} dots, follow ${entry.trial.targets.length}, speed ${entry.trial.speed} px/s for ${Math.round(entry.trial.motionMs / 1000)} s`,
    answered: `${tdHits(entry.trial, responses[i])} of ${entry.trial.targets.length} right`, correctAnswer: `dots ${entry.trial.targets.map(d => d + 1).join(', ')}`,
    correct: entry.outcome.correct, rtMs: null,
  }))
  return {
    // Eight trials; the mean chance-corrected skill, clamped once. A missing trial counts as 0, which keeps a partial block honest.
    score: toSessionScore(100 * clamp01(skills.reduce((a, b) => a + b, 0) / ROUND_COUNTS.track_the_dots)),
    stats: {
      trials: log.length, accuracy: fractions.length ? round3(fractions.reduce((a, b) => a + b, 0) / fractions.length) : 0,
      perfect_trials: log.filter(entry => entry.outcome.correct).length, dots: Math.round(p.dots), targets: Math.round(p.targets), speed: Math.round(p.speed),
    },
    review,
  }
}

export const trackDotsSim: SimPlayer<TdTrial, TdResponse> = {
  correct: trial => trial.targets,
  random: (trial, rng) => rng.shuffle(Array.from({ length: trial.dots }, (_, i) => i)).slice(0, trial.targets.length),
}
