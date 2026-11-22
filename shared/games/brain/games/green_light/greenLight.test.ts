import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { GREEN_LIGHT_PARAMS } from '../../config/difficulty.brain'
import { createGreenLightEngine, summariseGreenLight, type GlResponse, type GlTrial } from './engine'

const trials = (level: number, count: number, seed = 1): GlTrial[] => {
  const engine = createGreenLightEngine(paramsAt(GREEN_LIGHT_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => engine.next() as GlTrial)
}
const BLUE = 1, ORANGE = 0, GREEN = 2, RED = 3

describe('Green Light engine', () => {
  it('is deterministic for a seed', () => {
    expect(trials(20, 60, 3)).toEqual(trials(20, 60, 3))
    expect(trials(20, 60, 3)).not.toEqual(trials(20, 60, 4))
  })
  it('keeps the NO-GO share exact in every twenty trials (15 % at level 1, 35 % at level 20)', () => {
    expect(trials(1, 20).filter(t => !t.go)).toHaveLength(3)
    expect(trials(20, 20).filter(t => !t.go)).toHaveLength(7)
    expect(trials(10, 40).filter(t => !t.go)).toHaveLength(10)
  })
  it('stage 0: GO is the green circle and NO-GO the red square', () => {
    for (const t of trials(3, 80)) expect(t.go ? [t.shape, t.colour] : [t.shape, t.colour]).toEqual(t.go ? ['circle', GREEN] : ['square', RED])
  })
  it('stage 1: GO is any circle and NO-GO any square, in several colours', () => {
    const list = trials(8, 120)
    for (const t of list) expect(t.shape).toBe(t.go ? 'circle' : 'square')
    expect(new Set(list.map(t => t.colour)).size).toBeGreaterThan(2)
  })
  it('stage 2: the GO rule follows the current rule, and a banner announces each rule', () => {
    const list = trials(20, 51)
    const banners = list.map((t, i) => [i, t.banner] as const).filter(([, b]) => b !== null)
    expect(banners.map(([i]) => i)).toEqual([0, 12, 25, 38]) // 3 rule changes over a 51-trial block
    for (const [, text] of banners) expect(text).toMatch(/^GO = /)
    let rule = ''
    for (const t of list) {
      if (t.banner) rule = t.banner
      const colourRule = rule.match(/GO = (\w+) only/)![1]
      const byColour = ['orange', 'blue', 'green', 'red'].includes(colourRule)
      if (byColour) expect(t.go).toBe(({ orange: ORANGE, blue: BLUE, green: GREEN, red: RED } as Record<string, number>)[colourRule] === t.colour)
      else expect(t.go).toBe(`${t.shape}s` === colourRule)
    }
  })
  it('the first trial of every block carries a rule banner; the others do not (stages 0 and 1)', () => {
    for (const level of [1, 8]) { const list = trials(level, 10); expect(list[0].banner).toMatch(/GO = /); expect(list.slice(1).every(t => t.banner === null)).toBe(true) }
  })
  it('timing: display, a short grace for the answer, a jittered gap, and banner time', () => {
    const list = trials(20, 51)
    for (const t of list) {
      expect(t.displayMs).toBe(450); expect(t.windowMs).toBe(600)
      expect(t.gapMs).toBeGreaterThanOrEqual(400); expect(t.gapMs).toBeLessThanOrEqual(1600)
      expect(t.preMs).toBe(t.banner ? 1500 : 0)
    }
    expect(new Set(list.map(t => t.gapMs)).size).toBeGreaterThan(10)
    const engine = createGreenLightEngine(paramsAt(GREEN_LIGHT_PARAMS, 1), createRng(1))
    expect(engine.timing(engine.next() as GlTrial)).toMatchObject({ displayMs: 1000, windowMs: 1150, preMs: 1500 })
  })
  it('classifies hits, misses, false alarms and correct rejections', () => {
    const engine = createGreenLightEngine(paramsAt(GREEN_LIGHT_PARAMS, 1), createRng(9))
    const go = trials(1, 40).find(t => t.go)!, nogo = trials(1, 40).find(t => !t.go)!
    expect(engine.evaluate(go, 'press', 400)).toEqual({ correct: true, tag: 'hit' })
    expect(engine.evaluate(go, 'timeout', 1150)).toEqual({ correct: false, tag: 'miss' })
    expect(engine.evaluate(nogo, 'press', 400)).toEqual({ correct: false, tag: 'fa' })
    expect(engine.evaluate(nogo, 'timeout', 1150)).toEqual({ correct: true, tag: 'cr' })
  })
})

describe('Green Light scoring', () => {
  const go = trials(1, 40).find(t => t.go)!, nogo = trials(1, 40).find(t => !t.go)!
  const e = (n: number, trial: GlTrial, response: GlResponse | 'timeout', rtMs: number | null, tag: string, correct: boolean): TrialLogEntry<GlTrial, GlResponse> =>
    ({ n, trial, response, rtMs, outcome: { correct, tag }, atMs: n * 1000 })
  it('hand-computed at level 1: 24 of 30 hits, 1 of 10 false alarms, median hit 400 ms', () => {
    // skill = 0.8 - 0.1 = 0.7; speed = (700 - 400) / 420 = 0.714; 100 * 0.7 * (0.7 + 0.3 * 0.714) = 63.5; expected 37 trials, 40 done
    const log = [
      ...Array.from({ length: 24 }, (_, i) => e(i + 1, go, 'press', 400, 'hit', true)),
      ...Array.from({ length: 6 }, (_, i) => e(25 + i, go, 'timeout', null, 'miss', false)),
      e(31, nogo, 'press', 380, 'fa', false),
      ...Array.from({ length: 9 }, (_, i) => e(32 + i, nogo, 'timeout', null, 'cr', true)),
    ]
    const summary = summariseGreenLight(log, 1)
    expect(summary.score).toBe(64)
    expect(summary.stats).toMatchObject({ trials: 40, hit_rate: 0.8, false_alarm_rate: 0.1, median_rt: 400 })
  })
  it('always pressing and never pressing both score 0', () => {
    const always = [...Array.from({ length: 30 }, (_, i) => e(i + 1, go, 'press', 300, 'hit', true)), ...Array.from({ length: 10 }, (_, i) => e(31 + i, nogo, 'press', 300, 'fa', false))]
    const never = [...Array.from({ length: 30 }, (_, i) => e(i + 1, go, 'timeout', null, 'miss', false)), ...Array.from({ length: 10 }, (_, i) => e(31 + i, nogo, 'timeout', null, 'cr', true))]
    expect(summariseGreenLight(always, 1).score).toBe(0)
    expect(summariseGreenLight(never, 1).score).toBe(0)
  })
  it('an anticipated press on a GO symbol is not a hit and has no RT', () => {
    const early = { ...e(1, go, 'press', null, 'early', false), outcome: { correct: false, tag: 'early', anticipated: true } }
    const stats = summariseGreenLight([early, e(2, go, 'press', 400, 'hit', true), e(3, nogo, 'timeout', null, 'cr', true)], 1).stats!
    expect(stats).toMatchObject({ hit_rate: 0.5, anticipations: 1, median_rt: 400 })
  })
  it('reports RT variability and writes a review row per trial', () => {
    const log = [e(1, go, 'press', 300, 'hit', true), e(2, go, 'press', 500, 'hit', true), e(3, nogo, 'timeout', null, 'cr', true)]
    const summary = summariseGreenLight(log, 1)
    expect(summary.stats!.rt_cv).toBeCloseTo(0.354, 2)
    expect(summary.review).toHaveLength(3)
    expect(summary.review![2]).toMatchObject({ answered: 'held back', correctAnswer: 'hold back', correct: true })
  })
})
