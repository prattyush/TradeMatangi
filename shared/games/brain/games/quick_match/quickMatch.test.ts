import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { QUICK_MATCH_PARAMS } from '../../config/difficulty.brain'
import { correctQm, createQuickMatchEngine, describeQm, summariseQuickMatch, type QmResponse, type QmTrial } from './engine'

const trials = (level: number, count: number, seed = 1): QmTrial[] => {
  const engine = createQuickMatchEngine(paramsAt(QUICK_MATCH_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => engine.next() as QmTrial)
}
const entry = (n: number, trial: QmTrial, response: QmResponse | 'timeout', rtMs: number | null, correct: boolean): TrialLogEntry<QmTrial, QmResponse> =>
  ({ n, trial, response, rtMs, outcome: { correct }, atMs: n * 1000 })
const differences = (t: QmTrial) => ['colour', 'shape', 'scale', 'mirrored'].filter(k => {
  const key = k as 'colour' | 'shape' | 'scale' | 'mirrored'
  return t.left[key] !== t.right[key]
}).length

describe('Quick Match engine', () => {
  it('is deterministic for a seed and differs for another', () => {
    expect(trials(10, 30, 7)).toEqual(trials(10, 30, 7))
    expect(trials(10, 30, 7)).not.toEqual(trials(10, 30, 8))
  })
  it('is exactly half same and half different in every run of ten trials', () => {
    for (const level of [1, 10, 20]) {
      const list = trials(level, 100)
      for (let i = 0; i < 100; i += 10) expect(list.slice(i, i + 10).filter(t => t.same)).toHaveLength(5)
    }
  })
  it('item kind follows the level: circles to 5, polygons 6-12, rotated and mirrored from 13', () => {
    expect(trials(5, 40).every(t => t.kind === 0 && t.left.shape === 0 && t.left.rotation === 0)).toBe(true)
    expect(trials(6, 40).every(t => t.kind === 1 && t.left.shape >= 1 && t.left.shape <= 5 && t.left.rotation === 0)).toBe(true)
    expect(trials(12, 40).every(t => t.kind === 1)).toBe(true)
    const hard = trials(13, 80)
    expect(hard.every(t => t.kind === 2)).toBe(true)
    expect(hard.some(t => t.left.rotation !== 0)).toBe(true)
  })
  it('a "same" pair is identical except for rotation; a "different" pair differs', () => {
    for (const level of [1, 6, 13, 20]) {
      for (const t of trials(level, 100)) {
        if (t.same) { expect(differences(t)).toBe(0); expect(t.feature).toBe('none') }
        else { expect(differences(t)).toBeGreaterThanOrEqual(1); expect(t.feature).not.toBe('none') }
      }
    }
  })
  it('a mirror image is "different" and only appears from the mirror stage', () => {
    expect(trials(12, 200).some(t => t.feature === 'mirror')).toBe(false)
    const mirrors = trials(13, 200).filter(t => !t.same && t.feature === 'mirror')
    expect(mirrors.length).toBeGreaterThan(20)
    for (const t of mirrors) expect(t.left.mirrored).not.toBe(t.right.mirrored)
  })
  it('clearly different pairs at low similarity, one small feature at high similarity', () => {
    const lowSimilarity = trials(1, 200).filter(t => !t.same) // circles: colour and size
    expect(lowSimilarity.every(t => differences(t) === 2)).toBe(true)
    const highSimilarity = trials(20, 200).filter(t => !t.same)
    expect(highSimilarity.every(t => differences(t) === 1)).toBe(true)
    for (const t of highSimilarity.filter(t => t.feature === 'size')) expect(Math.abs(t.right.scale - 1)).toBeLessThan(0.2)
  })
  it('timing: shown until answered at level 1, then for the stated time; the window and gap follow the level', () => {
    const [first] = trials(1, 1)
    expect(first.displayMs).toBeNull(); expect(first.windowMs).toBe(3000); expect(first.gapMs).toBe(400)
    const [hard] = trials(20, 1)
    expect(hard).toMatchObject({ displayMs: 600, windowMs: 1200 })
    const engine = createQuickMatchEngine(paramsAt(QUICK_MATCH_PARAMS, 10), createRng(1))
    expect(engine.timing(engine.next() as QmTrial)).toEqual({ displayMs: 1500, windowMs: 2000, gapMs: 400 })
  })
  it('judges answers; a missed answer is wrong', () => {
    const engine = createQuickMatchEngine(paramsAt(QUICK_MATCH_PARAMS, 1), createRng(3))
    const t = engine.next() as QmTrial
    expect(engine.evaluate(t, correctQm(t), 500).correct).toBe(true)
    expect(engine.evaluate(t, t.same ? 'different' : 'same', 500).correct).toBe(false)
    expect(engine.evaluate(t, 'timeout', 3000).correct).toBe(false)
  })
})

describe('Quick Match scoring', () => {
  const [same, different] = [trials(1, 20).find(t => t.same)!, trials(1, 20).find(t => !t.same)!]
  it('hand-computed: 30 of 40 right at a median of 800 ms at level 1', () => {
    // skill = (0.75 - 0.5) / 0.5 = 0.5; speed = (1800 - 800) / 1350 = 0.7407; 100 * 0.5 * (0.6 + 0.4 * 0.7407) = 44.8; volume 1
    const log = Array.from({ length: 40 }, (_, i) => i < 30 ? entry(i + 1, same, 'same', 800, true) : entry(i + 1, different, 'same', 700, false))
    const summary = summariseQuickMatch(log, 1)
    expect(summary.score).toBe(45)
    expect(summary.stats).toMatchObject({ trials: 40, accuracy: 0.75, median_rt: 800 })
    expect(summary.review).toHaveLength(40)
    expect(summary.review![30]).toMatchObject({ n: 31, answered: 'same', correctAnswer: 'different', correct: false, rtMs: 700 })
  })
  it('guessing scores nothing; the volume check scales down an idle block', () => {
    const half = Array.from({ length: 40 }, (_, i) => entry(i + 1, same, i % 2 ? 'same' : 'different', 450, i % 2 === 1))
    expect(summariseQuickMatch(half, 1).score).toBe(0)
    // 5 perfect answers at the fastest speed: expected 39 trials, 0.6 * 39 = 23.4 -> 100 * 5 / 23.4 = 21
    const few = Array.from({ length: 5 }, (_, i) => entry(i + 1, same, 'same', 450, true))
    expect(summariseQuickMatch(few, 1).score).toBe(21)
    expect(summariseQuickMatch([], 1).score).toBe(0)
  })
  it('stats: same-versus-different RT gap, errors by feature, anticipations and lapses', () => {
    const colourDiff = { ...different, feature: 'colour' as const }
    const log = [
      entry(1, same, 'same', 500, true), entry(2, same, 'same', 600, true),
      entry(3, colourDiff, 'different', 800, true), entry(4, colourDiff, 'same', 700, false),
      { ...entry(5, same, 'same', null, false), outcome: { correct: false, anticipated: true } },
      entry(6, colourDiff, 'timeout', null, false),
    ]
    const stats = summariseQuickMatch(log, 1).stats!
    expect(stats).toMatchObject({ trials: 6, rt_gap_diff_minus_same: 250, err_colour: 2, anticipations: 1, lapses: 1 })
  })
  it('describes a trial in words for the review', () => {
    expect(describeQm(trials(13, 5)[0])).toMatch(/\|/)
  })
})
