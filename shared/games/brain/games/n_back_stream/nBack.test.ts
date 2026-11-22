import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { N_BACK_PARAMS } from '../../config/difficulty.brain'
import { createNBackEngine, summariseNBack, type NbResponse, type NbTrial } from './engine'

const trials = (level: number, count: number, seed = 1): NbTrial[] => {
  const e = createNBackEngine(paramsAt(N_BACK_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => e.next() as NbTrial)
}
const engine = (level: number) => createNBackEngine(paramsAt(N_BACK_PARAMS, level), createRng(1))
const press = (letter: number | null, pos: number | null = null): NbResponse => ({ letter, pos })

describe('N-Back engine', () => {
  it('is deterministic for a seed', () => {
    expect(trials(10, 60, 5)).toEqual(trials(10, 60, 5)); expect(trials(10, 60, 5)).not.toEqual(trials(10, 60, 6))
  })
  it('n follows the level: 1, 2 from level 6, 3 from 13, 4 from 19', () => {
    expect([1, 5, 6, 12, 13, 18, 19, 20].map(l => trials(l, 1)[0].n)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })
  it('the first n items are warm-up (never a match); the rest are classified by what they really are', () => {
    for (const level of [1, 10, 15, 19]) {
      const list = trials(level, 90, 3), n = list[0].n
      list.slice(0, n).forEach(t => expect(t.letterKind).toBe('warmup'))
      list.forEach((t, i) => {
        if (i < n) return
        const back = list[i - n].letter
        if (t.letterKind === 'match') expect(t.letter).toBe(back)
        else expect(t.letter).not.toBe(back)
        if (t.letterKind === 'lure') expect([list[i - n - 1]?.letter, n > 1 ? list[i - n + 1].letter : undefined]).toContain(t.letter)
        if (t.letterKind === 'normal') expect([list[i - n - 1]?.letter, n > 1 ? list[i - n + 1].letter : undefined]).not.toContain(t.letter)
      })
    }
  })
  it('keeps the match and lure shares in a run of twenty scored trials (level 10: 27 % matches, 10 % lures)', () => {
    const list = trials(10, 22).slice(2)
    expect(list.filter(t => t.letterKind === 'match')).toHaveLength(5)
    const lures = list.filter(t => t.letterKind === 'lure').length
    expect(lures).toBeLessThanOrEqual(2); expect(lures).toBeGreaterThan(0)
    expect(trials(1, 21).slice(1).filter(t => t.letterKind === 'match')).toHaveLength(6) // 30 %
    expect(trials(1, 80).every(t => t.letterKind !== 'lure')).toBe(true) // none before level 10
  })
  it('single mode shows only the letter; dual mode (from level 16) adds an independent position stream', () => {
    expect(trials(15, 30).every(t => !t.dual && t.posKind === 'warmup')).toBe(true)
    const dual = trials(16, 80, 2)
    expect(dual.every(t => t.dual)).toBe(true)
    expect(dual.some(t => t.posKind === 'match')).toBe(true)
    expect(dual.some(t => (t.posKind === 'match') !== (t.letterKind === 'match'))).toBe(true)
    expect(dual.every(t => t.pos >= 0 && t.pos < 9)).toBe(true)
  })
  it('timing: a fixed pace, item on screen for the item time minus the blank gap, responses collected for the whole window', () => {
    const e = engine(1), t = e.next() as NbTrial
    expect(e.timing(t)).toEqual({ displayMs: 1500, windowMs: 2000, gapMs: 0, fixedCadence: true })
    const hard = createNBackEngine(paramsAt(N_BACK_PARAMS, 20), createRng(1))
    expect(hard.timing(hard.next() as NbTrial)).toMatchObject({ displayMs: 700, windowMs: 1200 })
  })
  it('judges each key per modality: hit, miss, false alarm, lure false alarm, correct rejection', () => {
    const e = engine(10)
    const base: NbTrial = { index: 5, n: 2, dual: false, letter: 0, pos: 4, letterKind: 'match', posKind: 'warmup', itemMs: 1500, blankMs: 500 }
    expect(e.evaluate(base, press(600))).toEqual({ correct: true, tag: 'hit' })
    expect(e.evaluate(base, press(null))).toEqual({ correct: false, tag: 'miss' })
    expect(e.evaluate({ ...base, letterKind: 'normal' }, press(600))).toEqual({ correct: false, tag: 'fa' })
    expect(e.evaluate({ ...base, letterKind: 'normal' }, press(null))).toEqual({ correct: true, tag: 'cr' })
    expect(e.evaluate({ ...base, letterKind: 'lure' }, press(600))).toEqual({ correct: false, tag: 'lfa' })
    expect(e.evaluate({ ...base, letterKind: 'lure' }, press(null))).toEqual({ correct: true, tag: 'lcr' })
    expect(e.evaluate({ ...base, letterKind: 'warmup' }, press(600))).toEqual({ correct: true, tag: 'skip' })
    expect(e.evaluate(base, 'timeout').tag).toBe('miss')
  })
  it('dual: both keys are judged and the trial is right only when both are', () => {
    const e = engine(16)
    const t: NbTrial = { index: 9, n: 3, dual: true, letter: 1, pos: 2, letterKind: 'match', posKind: 'normal', itemMs: 1300, blankMs: 500 }
    expect(e.evaluate(t, press(500, null))).toEqual({ correct: true, tag: 'hit|cr' })
    expect(e.evaluate(t, press(500, 700))).toEqual({ correct: false, tag: 'hit|fa' })
    expect(e.evaluate(t, press(null, null))).toEqual({ correct: false, tag: 'miss|cr' })
  })
})

describe('N-Back scoring', () => {
  const entry = (n: number, trial: NbTrial, response: NbResponse, tag: string, correct: boolean): TrialLogEntry<NbTrial, NbResponse> => ({ n, trial, response, rtMs: null, outcome: { correct, tag }, atMs: n })
  const t = (index: number, kind: NbTrial['letterKind']): NbTrial => ({ index, n: 2, dual: false, letter: 0, pos: 4, letterKind: kind, posKind: 'warmup', itemMs: 1500, blankMs: 500 })
  it('hand-computed: hit rate minus false-alarm rate, with the lure false-alarm rate reported', () => {
    // 8 matches: 6 hits, 2 misses -> HR .75. non-matches: 4 normal (1 fa), 4 lures (2 lfa) -> FAR 3/8 = .375. skill .375
    const log = [
      entry(1, t(0, 'warmup'), press(null), 'skip', true), entry(2, t(1, 'warmup'), press(null), 'skip', true),
      ...Array.from({ length: 6 }, (_, i) => entry(3 + i, t(2 + i, 'match'), press(600), 'hit', true)),
      ...Array.from({ length: 2 }, (_, i) => entry(9 + i, t(8 + i, 'match'), press(null), 'miss', false)),
      entry(11, t(10, 'normal'), press(600), 'fa', false), ...Array.from({ length: 3 }, (_, i) => entry(12 + i, t(11 + i, 'normal'), press(null), 'cr', true)),
      ...Array.from({ length: 2 }, (_, i) => entry(15 + i, t(14 + i, 'lure'), press(600), 'lfa', false)), ...Array.from({ length: 2 }, (_, i) => entry(17 + i, t(16 + i, 'lure'), press(null), 'lcr', true)),
    ]
    const summary = summariseNBack(log, 10)
    expect(summary.score).toBe(38)
    expect(summary.stats).toMatchObject({ trials: 16, hit_rate: 0.75, false_alarm_rate: 0.375, lure_false_alarm_rate: 0.5, n_reached: 2 })
  })
  it('pooled over both keys in dual mode; warm-up trials are not scored; always or never pressing scores 0', () => {
    const d = (kind: NbTrial['letterKind'], pk: NbTrial['letterKind']): NbTrial => ({ ...t(5, kind), dual: true, posKind: pk })
    const log = [entry(1, d('match', 'match'), press(500, 500), 'hit|hit', true), entry(2, d('normal', 'normal'), press(null), 'cr|cr', true), entry(3, d('warmup', 'warmup'), press(null), 'skip|skip', true)]
    expect(summariseNBack(log, 20).score).toBe(100)
    const always = [entry(1, t(5, 'match'), press(500), 'hit', true), entry(2, t(6, 'normal'), press(500), 'fa', false)]
    const never = [entry(1, t(5, 'match'), press(null), 'miss', false), entry(2, t(6, 'normal'), press(null), 'cr', true)]
    expect(summariseNBack(always, 1).score).toBe(0); expect(summariseNBack(never, 1).score).toBe(0)
    expect(summariseNBack([], 1).score).toBe(0)
  })
})
