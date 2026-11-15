import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { COLOUR_CLASH_PARAMS } from '../../config/difficulty.brain'
import { createColourClashEngine, describeCc, summariseColourClash, type CcResponse, type CcTrial } from './engine'

const trials = (level: number, count: number, seed = 1): CcTrial[] => {
  const engine = createColourClashEngine(paramsAt(COLOUR_CLASH_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => engine.next() as CcTrial)
}
const entry = (n: number, trial: CcTrial, response: CcResponse | 'timeout', rtMs: number | null, correct: boolean): TrialLogEntry<CcTrial, CcResponse> =>
  ({ n, trial, response, rtMs, outcome: { correct, tag: trial.kind }, atMs: n * 1000 })
const count = (list: CcTrial[], kind: CcTrial['kind']) => list.filter(t => t.kind === kind).length

describe('Colour Clash engine', () => {
  it('is deterministic for a seed', () => {
    expect(trials(10, 40, 5)).toEqual(trials(10, 40, 5))
    expect(trials(10, 40, 5)).not.toEqual(trials(10, 40, 6))
  })
  it('keeps the incongruent and neutral shares exact in every twenty trials', () => {
    const l1 = trials(1, 20); expect([count(l1, 'incongruent'), count(l1, 'neutral'), count(l1, 'congruent')]).toEqual([5, 0, 15])
    const l10 = trials(10, 20); expect([count(l10, 'incongruent'), count(l10, 'neutral'), count(l10, 'congruent')]).toEqual([9, 0, 11])
    const l20 = trials(20, 40); expect([count(l20.slice(0, 20), 'incongruent'), count(l20.slice(0, 20), 'neutral'), count(l20.slice(20), 'incongruent'), count(l20.slice(20), 'neutral')]).toEqual([13, 3, 13, 3])
  })
  it('congruent words match their ink, incongruent ones never do, neutral trials have no word', () => {
    for (const t of trials(20, 200)) {
      if (t.kind === 'congruent') expect(t.word).toBe(t.ink)
      else if (t.kind === 'incongruent') { expect(t.word).not.toBeNull(); expect(t.word).not.toBe(t.ink) }
      else expect(t.word).toBeNull()
    }
  })
  it('uses 4, 5 or 6 colours by level and always picks inks inside that set', () => {
    for (const [level, k] of [[1, 4], [5, 4], [10, 5], [15, 6], [20, 6]] as const) {
      const list = trials(level, 120)
      expect(Math.max(...list.map(t => t.ink))).toBeLessThan(k)
      expect(new Set(list.map(t => t.ink)).size).toBe(k)
      expect(list.every(t => t.order.length === k)).toBe(true)
    }
  })
  it('the answer buttons keep their order until level 16, then change every trial (always a permutation)', () => {
    const fixed = trials(15, 30)
    expect(fixed.every(t => t.order.join() === fixed[0].order.join())).toBe(true)
    const shuffled = trials(16, 60)
    expect(new Set(shuffled.map(t => t.order.join())).size).toBeGreaterThan(10)
    for (const t of shuffled) expect([...t.order].sort()).toEqual(Array.from({ length: t.order.length }, (_, i) => i))
  })
  it('never repeats the exact same stimulus twice in a row', () => {
    const list = trials(20, 300)
    for (let i = 1; i < list.length; i++) expect(`${list[i].word}/${list[i].ink}` === `${list[i - 1].word}/${list[i - 1].ink}`).toBe(false)
  })
  it('judges the ink colour; the word is irrelevant', () => {
    const engine = createColourClashEngine(paramsAt(COLOUR_CLASH_PARAMS, 20), createRng(2))
    const t = (engine.next() as CcTrial)
    expect(engine.evaluate(t, t.ink, 700)).toMatchObject({ correct: true, tag: t.kind })
    const wrong = t.word !== null && t.word !== t.ink ? t.word : (t.ink + 1) % 6
    expect(engine.evaluate(t, wrong, 700).correct).toBe(false)
    expect(engine.evaluate(t, 'timeout', 1100).correct).toBe(false)
    expect(engine.timing(t)).toEqual({ displayMs: null, windowMs: 1100, gapMs: 400 })
  })
})

describe('Colour Clash scoring', () => {
  const [con, inc] = [trials(10, 30).find(t => t.kind === 'congruent')!, trials(10, 30).find(t => t.kind === 'incongruent')!]
  it('hand-computed at level 1 (4 colours): 36 of 48 right', () => {
    // acc 0.75, chance 0.25 -> skill 0.6667; median RT 1100 -> speed (2200-1100)/1650 = 0.6667; 100 * 0.6667 * (0.6 + 0.4 * 0.6667) = 57.8
    const log = Array.from({ length: 48 }, (_, i) => i < 36 ? entry(i + 1, con, con.ink, 1100, true) : entry(i + 1, inc, (inc.ink + 1) % 4, 900, false))
    const summary = summariseColourClash(log, 1)
    expect(summary.score).toBe(58)
    expect(summary.stats).toMatchObject({ trials: 48, accuracy: 0.75, incongruent_error_rate: 1 })
  })
  it('chance-level answers score nothing', () => {
    const log = Array.from({ length: 40 }, (_, i) => entry(i + 1, con, i % 4 === 0 ? con.ink : (con.ink + 1) % 4, 600, i % 4 === 0))
    expect(summariseColourClash(log, 1).score).toBe(0)
  })
  it('the Stroop effect is the incongruent minus congruent median RT', () => {
    const log = [entry(1, con, con.ink, 700, true), entry(2, con, con.ink, 800, true), entry(3, inc, inc.ink, 1000, true), entry(4, inc, inc.ink, 1100, true), entry(5, inc, (inc.ink + 1) % 6, 900, false)]
    expect(summariseColourClash(log, 10).stats).toMatchObject({ median_rt_congruent: 750, median_rt_incongruent: 1050, stroop_effect: 300, incongruent_error_rate: 0.333 })
  })
  it('describes the word and its ink for the review', () => {
    expect(describeCc({ ...inc, word: 0, ink: 1 })).toBe('ORANGE printed in BLUE')
    expect(describeCc({ ...inc, word: null, ink: 3, kind: 'neutral' })).toBe('XXXX printed in RED')
  })
})
