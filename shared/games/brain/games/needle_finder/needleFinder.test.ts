import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { NEEDLE_FINDER_PARAMS } from '../../config/difficulty.brain'
import { correctNf, createNeedleEngine, NF_HEIGHT, NF_WIDTH, searchSlope, summariseNeedleFinder, type NfResponse, type NfTrial } from './engine'

const trials = (level: number, count = 20, seed = 1): NfTrial[] => {
  const e = createNeedleEngine(paramsAt(NEEDLE_FINDER_PARAMS, level), createRng(seed))
  return Array.from({ length: count }, () => e.next() as NfTrial)
}
const RED = 3
const isNeedle = (i: { colour: number; orient: string }) => i.colour === RED && i.orient === 'v'
const entry = (n: number, trial: NfTrial, response: NfResponse | 'timeout', rtMs: number | null, correct: boolean, tag: string): TrialLogEntry<NfTrial, NfResponse> => ({ n, trial, response, rtMs, outcome: { correct, tag }, atMs: n })

describe('Needle Finder engine', () => {
  it('is deterministic, and runs exactly twenty judged screens', () => {
    expect(trials(10, 20, 3)).toEqual(trials(10, 20, 3)); expect(trials(10, 20, 3)).not.toEqual(trials(10, 20, 4))
    const e = createNeedleEngine(paramsAt(NEEDLE_FINDER_PARAMS, 1), createRng(1))
    for (let i = 0; i < 20; i++) { const t = e.next() as NfTrial; expect(t).not.toBeNull(); e.evaluate(t, 'timeout', 1000) }
    expect(e.next()).toBeNull()
  })
  it('a screen thrown away for a bad frame is replaced for free: only judged screens count', () => {
    const e = createNeedleEngine(paramsAt(NEEDLE_FINDER_PARAMS, 1), createRng(1))
    for (let i = 0; i < 5; i++) e.next() // five screens discarded without an answer
    expect(e.progress!()).toMatchObject({ trial: 0, of: 20 })
    let judged = 0
    for (let t = e.next() as NfTrial | null; t; t = e.next() as NfTrial | null) { e.evaluate(t, 'timeout', 1000); judged += 1 }
    expect(judged).toBe(20)
  })
  it('absent screens are exactly the stated share of twenty (20 % at level 1, 30 % at level 20)', () => {
    expect(trials(1).filter(t => t.target === -1)).toHaveLength(4)
    expect(trials(20).filter(t => t.target === -1)).toHaveLength(6)
    expect(trials(10).filter(t => t.target === -1)).toHaveLength(5)
  })
  it('a present screen has exactly one needle (the red upright bar) at the target index; an absent one has none', () => {
    for (const level of [1, 7, 10, 15, 20]) {
      for (const t of trials(level, 20, 5)) {
        const needles = t.items.map((item, i) => (isNeedle(item) ? i : -1)).filter(i => i >= 0)
        expect(needles).toEqual(t.target === -1 ? [] : [t.target])
      }
    }
  })
  it('feature search (to level 6): one colour differs; conjunction (7 to 14): red and upright are shared separately; level 15 adds more kinds', () => {
    for (const t of trials(6)) expect(new Set(t.items.filter(i => !isNeedle(i)).map(i => `${i.colour}${i.orient}`))).toEqual(new Set([`${1}v`]))
    const conj = trials(7).flatMap(t => t.items.filter(i => !isNeedle(i)).map(i => `${i.colour}${i.orient}`))
    expect(new Set(conj)).toEqual(new Set(['3h', '1v']))
    const hard = trials(15, 20).flatMap(t => t.items.filter(i => !isNeedle(i)).map(i => `${i.colour}${i.orient}`))
    expect(new Set(hard).size).toBeGreaterThanOrEqual(3)
  })
  it('set size follows the level and varies inside a block (half, three quarters, full) so a slope can be estimated', () => {
    for (const [level, size] of [[1, 8], [10, 24], [20, 60]] as const) {
      const sizes = new Set(trials(level).map(t => t.setSize))
      expect([...sizes].sort((a, b) => a - b)).toEqual([Math.round(size * 0.5), Math.round(size * 0.75), size].sort((a, b) => a - b))
      for (const t of trials(level)) expect(t.items).toHaveLength(t.setSize)
    }
  })
  it('items sit inside the arena; with no jitter every item has its own cell', () => {
    for (const level of [1, 20]) for (const t of trials(level)) for (const item of t.items) { expect(item.x).toBeGreaterThanOrEqual(0); expect(item.x).toBeLessThanOrEqual(NF_WIDTH); expect(item.y).toBeGreaterThanOrEqual(0); expect(item.y).toBeLessThanOrEqual(NF_HEIGHT) }
    for (const t of trials(1)) expect(new Set(t.items.map(i => `${i.x.toFixed(3)},${i.y.toFixed(3)}`)).size).toBe(t.items.length)
  })
  it('the time limit shrinks with the level; there is no display timer, the screen stays until answered', () => {
    expect(trials(1, 1)[0].limitMs).toBe(15000); expect(trials(20, 1)[0].limitMs).toBe(5000)
    const e = createNeedleEngine(paramsAt(NEEDLE_FINDER_PARAMS, 10), createRng(1))
    expect(e.timing(e.next() as NfTrial)).toEqual({ displayMs: null, windowMs: 10000, gapMs: 600 })
  })
  it('judges hit, wrong click, miss (said absent), false alarm (clicked on an empty screen), correct rejection, timeout', () => {
    const e = createNeedleEngine(paramsAt(NEEDLE_FINDER_PARAMS, 1), createRng(1))
    const present = trials(1).find(t => t.target !== -1)!, absent = trials(1).find(t => t.target === -1)!
    const wrong = (present.target + 1) % present.items.length
    expect(e.evaluate(present, correctNf(present), 900)).toEqual({ correct: true, tag: 'hit' })
    expect(e.evaluate(present, { type: 'click', index: wrong }, 900)).toEqual({ correct: false, tag: 'wrong' })
    expect(e.evaluate(present, { type: 'absent' }, 900)).toEqual({ correct: false, tag: 'miss' })
    expect(e.evaluate(absent, { type: 'click', index: 0 }, 900)).toEqual({ correct: false, tag: 'fa' })
    expect(e.evaluate(absent, { type: 'absent' }, 900)).toEqual({ correct: true, tag: 'cr' })
    expect(e.evaluate(present, 'timeout', 15000)).toEqual({ correct: false, tag: 'timeout' })
  })
})

describe('Needle Finder scoring', () => {
  const [present, absent] = [trials(1).find(t => t.target !== -1)!, trials(1).find(t => t.target === -1)!]
  const hit = (n: number, ms: number) => entry(n, present, correctNf(present), ms, true, 'hit')
  it('search slope: ms per extra item from a least-squares fit; zero without enough spread', () => {
    expect(searchSlope([{ size: 10, ms: 1000 }, { size: 20, ms: 1500 }, { size: 30, ms: 2000 }, { size: 10, ms: 1000 }, { size: 20, ms: 1500 }, { size: 30, ms: 2000 }])).toBeCloseTo(50)
    expect(searchSlope([{ size: 10, ms: 1000 }, { size: 10, ms: 1200 }])).toBe(0)
    expect(searchSlope(Array.from({ length: 8 }, () => ({ size: 20, ms: 900 })))).toBe(0)
  })
  it('hand-computed at level 1: 12 of 16 present found, 4 of 4 absent rejected, median search 3 s of a 15 s limit', () => {
    // skill = 12/16 - 0/4 = .75; each correct trial earns .6 + .4 * (1 - t/15000); at 3000 ms -> .6 + .4 * .8 = .92 -> 100 * .75 * .92 = 69
    const log = [
      ...Array.from({ length: 12 }, (_, i) => hit(i + 1, 3000)),
      ...Array.from({ length: 4 }, (_, i) => entry(13 + i, present, 'timeout', null, false, 'timeout')),
      ...Array.from({ length: 4 }, (_, i) => entry(17 + i, absent, { type: 'absent' }, 3000, true, 'cr')),
    ]
    const summary = summariseNeedleFinder(log, 1)
    expect(summary.score).toBe(69)
    expect(summary.stats).toMatchObject({ trials: 20, accuracy: 0.8, median_search_ms: 3000, absent_accuracy: 1 })
    expect(summary.review).toHaveLength(20)
  })
  it('always saying "not there" scores 0; clicking at random on empty screens cannot help; a quick perfect run scores high', () => {
    const alwaysAbsent = [...Array.from({ length: 16 }, (_, i) => entry(i + 1, present, { type: 'absent' }, 500, false, 'miss')), ...Array.from({ length: 4 }, (_, i) => entry(17 + i, absent, { type: 'absent' }, 500, true, 'cr'))]
    expect(summariseNeedleFinder(alwaysAbsent, 1).score).toBe(0)
    const clicksOnEmpty = [...Array.from({ length: 16 }, (_, i) => hit(i + 1, 1000)), ...Array.from({ length: 4 }, (_, i) => entry(17 + i, absent, { type: 'click', index: 0 }, 1000, false, 'fa'))]
    expect(summariseNeedleFinder(clicksOnEmpty, 1).score).toBe(Math.round(100 * (1 - 1) * 0.97)) // hit rate 1 minus false-alarm rate 1
    const perfect = [...Array.from({ length: 16 }, (_, i) => hit(i + 1, 750)), ...Array.from({ length: 4 }, (_, i) => entry(17 + i, absent, { type: 'absent' }, 750, true, 'cr'))]
    expect(summariseNeedleFinder(perfect, 1).score).toBe(98)
    expect(summariseNeedleFinder([], 1).score).toBe(0)
  })
})
