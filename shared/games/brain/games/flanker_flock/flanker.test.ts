import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { FLANKER_PARAMS } from '../../config/difficulty.brain'
import { createFlankerEngine, cueText, summariseFlanker, type FlResponse, type FlTrial } from './engine'

const trials = (level: number, count: number, seed = 1): FlTrial[] => {
  const e = createFlankerEngine(paramsAt(FLANKER_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => e.next() as FlTrial)
}
const count = (list: FlTrial[], kind: FlTrial['kind']) => list.filter(t => t.kind === kind).length
const entry = (n: number, trial: FlTrial, response: FlResponse | 'timeout', rtMs: number | null, correct: boolean, anticipated = false): TrialLogEntry<FlTrial, FlResponse> => ({ n, trial, response, rtMs, outcome: { correct, tag: trial.kind, anticipated }, atMs: n })

describe('Flanker engine', () => {
  it('is deterministic for a seed', () => { expect(trials(10, 40, 3)).toEqual(trials(10, 40, 3)); expect(trials(10, 40, 3)).not.toEqual(trials(10, 40, 4)) })
  it('keeps the condition shares exact in every twenty trials', () => {
    const l1 = trials(1, 20); expect([count(l1, 'incongruent'), count(l1, 'neutral'), count(l1, 'congruent')]).toEqual([7, 4, 9])
    const l20 = trials(20, 20); expect([count(l20, 'incongruent'), count(l20, 'neutral'), count(l20, 'congruent')]).toEqual([13, 0, 7])
  })
  it('the middle arrow is the target; flankers agree, disagree or are plain dashes; their number follows the level', () => {
    for (const [level, flankers] of [[1, 2], [5, 3], [10, 4], [15, 5], [20, 6]] as const) {
      for (const t of trials(level, 40)) {
        expect(t.row).toHaveLength(2 * flankers + 1)
        expect(t.row[flankers]).toBe(t.dir)
        const sides = t.row.filter((_, i) => i !== flankers)
        if (t.kind === 'congruent') expect(sides.every(s => s === t.dir)).toBe(true)
        else if (t.kind === 'incongruent') expect(sides.every(s => s !== t.dir && s !== 'neutral')).toBe(true)
        else expect(sides.every(s => s === 'neutral')).toBe(true)
      }
    }
  })
  it('both directions occur; display and window shrink with the level', () => {
    expect(new Set(trials(1, 60).map(t => t.dir)).size).toBe(2)
    expect(trials(1, 1)[0]).toMatchObject({ displayMs: 1500, windowMs: 2000, gapMs: 400 })
    expect(trials(20, 1)[0]).toMatchObject({ displayMs: 500, windowMs: 900 })
  })
  it('vertical jitter from level 10; a decoy row and a cue from level 14', () => {
    expect(trials(9, 60).every(t => t.offsetY === 0)).toBe(true)
    expect(trials(10, 60).some(t => t.offsetY !== 0)).toBe(true)
    expect(trials(13, 30).every(t => t.decoy === null && t.preMs === 0)).toBe(true)
    const hard = trials(14, 60)
    expect(hard.every(t => t.decoy !== null && t.decoy.length === t.row.length && t.preMs === 500)).toBe(true)
    expect(new Set(hard.map(t => t.targetRow)).size).toBe(2)
    expect(cueText(hard.find(t => t.targetRow === 0)!)).toMatch(/TOP/); expect(cueText(hard.find(t => t.targetRow === 1)!)).toMatch(/BOTTOM/); expect(cueText(trials(1, 1)[0])).toBeNull()
  })
  it('judges the middle arrow only', () => {
    const e = createFlankerEngine(paramsAt(FLANKER_PARAMS, 1), createRng(2)), t = e.next() as FlTrial
    expect(e.evaluate(t, t.dir, 500).correct).toBe(true)
    expect(e.evaluate(t, t.dir === 'left' ? 'right' : 'left', 500).correct).toBe(false)
    expect(e.evaluate(t, 'timeout', 2000).correct).toBe(false)
  })
})

describe('Flanker scoring', () => {
  const [con, inc] = [trials(10, 40).find(t => t.kind === 'congruent')!, trials(10, 40).find(t => t.kind === 'incongruent')!]
  it('hand-computed at level 1: 36 of 40 right at a median of 700 ms', () => {
    // skill (0.9 - 0.5) / 0.5 = .8; speed (1400 - 700)/1070 = .6542; 100 * .8 * (.6 + .4 * .6542) = 69.3; 40 trials of 38 expected -> volume 1
    const log = Array.from({ length: 40 }, (_, i) => i < 36 ? entry(i + 1, con, con.dir, 700, true) : entry(i + 1, inc, inc.dir === 'left' ? 'right' : 'left', 600, false))
    const summary = summariseFlanker(log, 1)
    expect(summary.score).toBe(69)
    expect(summary.stats).toMatchObject({ trials: 40, accuracy: 0.9, median_rt: 700, err_incongruent: 4, err_congruent: 0 })
  })
  it('the flanker effect is the incongruent minus congruent median RT; guessing scores nothing', () => {
    const log = [entry(1, con, con.dir, 400, true), entry(2, con, con.dir, 500, true), entry(3, inc, inc.dir, 620, true), entry(4, inc, inc.dir, 700, true)]
    expect(summariseFlanker(log, 10).stats).toMatchObject({ median_rt_congruent: 450, median_rt_incongruent: 660, flanker_effect: 210 })
    const guess = Array.from({ length: 40 }, (_, i) => entry(i + 1, con, i % 2 ? con.dir : (con.dir === 'left' ? 'right' : 'left'), 400, i % 2 === 1))
    expect(summariseFlanker(guess, 1).score).toBe(0)
    expect(summariseFlanker([entry(1, con, con.dir, null, false, true)], 1).stats).toMatchObject({ anticipations: 1 })
  })
})
