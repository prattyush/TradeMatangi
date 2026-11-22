import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { TRACK_DOTS_PARAMS } from '../../config/difficulty.brain'
import { ARENA_H, ARENA_W, createTrackDotsEngine, DOT_RADIUS, DOT_STEP_MS, dotAt, stepAtMs, summariseTrackDots, tdHits, tdSkill, type TdResponse, type TdTrial } from './engine'

const trials = (level: number, count = 8, seed = 1): TdTrial[] => {
  const e = createTrackDotsEngine(paramsAt(TRACK_DOTS_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => e.next() as TdTrial)
}
const hash = (t: TdTrial) => { let h = 0; for (let i = 0; i < t.frames.length; i += 97) h = (h * 31 + Math.round(t.frames[i] * 100)) | 0; return h }
const entry = (n: number, trial: TdTrial, response: TdResponse): TrialLogEntry<TdTrial, TdResponse> => ({ n, trial, response, rtMs: null, outcome: { correct: tdHits(trial, response) === trial.targets.length }, atMs: n })

describe('Track the Dots engine', () => {
  it('is deterministic: the same seed gives identical trajectories (so Review can replay a session)', () => {
    const a = trials(10, 2, 7), b = trials(10, 2, 7)
    expect(a.map(hash)).toEqual(b.map(hash))
    expect(Array.from(a[0].frames)).toEqual(Array.from(b[0].frames))
    expect(a[0].targets).toEqual(b[0].targets)
    expect(trials(10, 1, 8).map(hash)).not.toEqual(a.slice(0, 1).map(hash))
  })
  it('eight judged trials, then the session ends', () => {
    const e = createTrackDotsEngine(paramsAt(TRACK_DOTS_PARAMS, 1), createRng(1))
    for (let i = 0; i < 8; i++) { const t = e.next() as TdTrial; expect(t).not.toBeNull(); e.evaluate(t, []) }
    expect(e.next()).toBeNull()
  })
  it('a round replaced after a bad frame does not use up one of the eight', () => {
    const e = createTrackDotsEngine(paramsAt(TRACK_DOTS_PARAMS, 1), createRng(1))
    e.next(); e.next(); e.next() // three rounds thrown away without an answer
    expect(e.progress!()).toMatchObject({ trial: 0, of: 8 })
    let judged = 0
    for (let t = e.next() as TdTrial | null; t; t = e.next() as TdTrial | null) { e.evaluate(t, []); judged += 1 }
    expect(judged).toBe(8)
  })
  it('dots, targets, speed and motion time follow the level', () => {
    expect(trials(1, 1)[0]).toMatchObject({ dots: 8, speed: 80, motionMs: 5000, markMs: 2000, occluder: false })
    expect(trials(1, 1)[0].targets).toHaveLength(2)
    expect(trials(20, 1)[0]).toMatchObject({ dots: 16, speed: 220, motionMs: 10000, occluder: true })
    expect(trials(20, 1)[0].targets).toHaveLength(6)
    for (const t of trials(10, 8)) { expect(new Set(t.targets).size).toBe(t.targets.length); expect(t.targets.every(d => d >= 0 && d < t.dots)).toBe(true) }
  })
  it('records a frame per fixed step (120 a second) for every dot, and keeps every dot inside the arena', () => {
    const t = trials(20, 1)[0]
    expect(t.steps).toBe(Math.ceil(10000 / DOT_STEP_MS)); expect(t.frames).toHaveLength((t.steps + 1) * t.dots * 2)
    for (let s = 0; s <= t.steps; s += 7) for (let d = 0; d < t.dots; d++) {
      const { x, y } = dotAt(t, s, d)
      expect(x).toBeGreaterThanOrEqual(DOT_RADIUS - 0.01); expect(x).toBeLessThanOrEqual(ARENA_W - DOT_RADIUS + 0.01)
      expect(y).toBeGreaterThanOrEqual(DOT_RADIUS - 0.01); expect(y).toBeLessThanOrEqual(ARENA_H - DOT_RADIUS + 0.01)
    }
  })
  it('dots move at the stated speed (away from walls), and start apart from each other', () => {
    const t = trials(10, 1)[0]
    const moved = Array.from({ length: t.dots }, (_, d) => { const a = dotAt(t, 1, d), b = dotAt(t, 2, d); return Math.hypot(b.x - a.x, b.y - a.y) })
    const perStep = (t.speed * DOT_STEP_MS) / 1000
    expect(moved.filter(m => Math.abs(m - perStep) < 0.001).length).toBeGreaterThan(t.dots / 2)
    for (let i = 0; i < t.dots; i++) for (let j = i + 1; j < t.dots; j++) { const a = dotAt(t, 0, i), b = dotAt(t, 0, j); expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(DOT_RADIUS) }
  })
  it('stepAtMs and dotAt clamp: before the start and after the end', () => {
    const t = trials(1, 1)[0]
    expect(stepAtMs(0)).toBe(0); expect(stepAtMs(DOT_STEP_MS * 5.5)).toBe(5)
    expect(dotAt(t, -3, 0)).toEqual(dotAt(t, 0, 0)); expect(dotAt(t, 99999, 0)).toEqual(dotAt(t, t.steps, 0))
  })
  it('the screen (occluder) comes in at level 12 and the distractor blips at 16, only on dots that are not targets', () => {
    expect(trials(11, 3).every(t => !t.occluder)).toBe(true); expect(trials(12, 3).every(t => t.occluder)).toBe(true)
    expect(trials(15, 3).every(t => t.flicker.length === 0)).toBe(true)
    for (const t of trials(16, 4)) { expect(t.flicker.length).toBeGreaterThan(2); for (const f of t.flicker) { expect(f.durMs).toBe(120); expect(f.dots.every(d => !t.targets.includes(d))).toBe(true); expect(f.atMs).toBeLessThan(t.motionMs) } }
  })
  it('stages: mark and move are critical presentation stages, the answer has no time limit', () => {
    const e = createTrackDotsEngine(paramsAt(TRACK_DOTS_PARAMS, 5), createRng(1)), stages = e.stages!(e.next() as TdTrial)
    expect(stages.map(s => s.name)).toEqual(['mark', 'move', 'respond'])
    expect(stages.slice(0, 2).every(s => s.critical)).toBe(true); expect(stages[2].ms).toBeNull()
  })
})

describe('Track the Dots scoring', () => {
  const t = trials(10, 1)[0] // 12 dots, follow 4
  it('hits count each target once; the skill is chance-corrected and not clamped per trial', () => {
    expect(tdHits(t, t.targets)).toBe(4); expect(tdHits(t, [...t.targets, ...t.targets])).toBe(4)
    expect(tdHits(t, [])).toBe(0)
    expect(tdSkill(t, t.targets)).toBe(1)
    expect(tdSkill(t, t.targets.slice(0, 2))).toBeCloseTo((0.5 - 4 / 12) / (1 - 4 / 12))
    expect(tdSkill(t, [])).toBeLessThan(0) // below chance stays negative until the session is totalled
  })
  it('hand-computed: skill averaged over eight trials, then clamped once', () => {
    const half = t.targets.slice(0, 2)
    const log = [...Array.from({ length: 6 }, (_, i) => entry(i + 1, t, t.targets)), entry(7, t, half), entry(8, t, half)]
    const expected = (6 * 1 + 2 * ((0.5 - 4 / 12) / (1 - 4 / 12))) / 8
    expect(summariseTrackDots(log, 10).score).toBe(Math.round(100 * expected))
    expect(summariseTrackDots(log, 10).stats).toMatchObject({ trials: 8, perfect_trials: 6, dots: 12, targets: 4, speed: 150 })
  })
  it('picking at random scores about nothing, a missing trial counts as zero, and a perfect run scores 100', () => {
    const wrong = Array.from({ length: t.dots }, (_, i) => i).filter(d => !t.targets.includes(d)).slice(0, 4)
    expect(summariseTrackDots(Array.from({ length: 8 }, (_, i) => entry(i + 1, t, wrong)), 10).score).toBe(0)
    expect(summariseTrackDots(Array.from({ length: 8 }, (_, i) => entry(i + 1, t, t.targets)), 10).score).toBe(100)
    expect(summariseTrackDots([entry(1, t, t.targets)], 10).score).toBe(13) // one perfect trial out of eight
    expect(summariseTrackDots([], 10).score).toBe(0)
  })
})
