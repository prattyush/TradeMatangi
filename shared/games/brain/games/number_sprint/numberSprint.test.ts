import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { NUMBER_SPRINT_PARAMS } from '../../config/difficulty.brain'
import { createNumberSprintEngine, problemWeight, SHOW_ANSWER_MS, summariseNumberSprint, type NsResponse, type NsTrial } from './engine'

const make = (level: number, seed = 1) => createNumberSprintEngine(paramsAt(NUMBER_SPRINT_PARAMS, level), createRng(seed))
const trialsAt = (level: number, count: number, seed = 1): NsTrial[] => { const e = make(level, seed); return Array.from({ length: count }, () => e.next() as NsTrial) }
const entry = (n: number, trial: NsTrial, response: NsResponse | 'timeout', rtMs: number | null, correct: boolean, tag = correct ? 'ok' : 'wrong'): TrialLogEntry<NsTrial, NsResponse> =>
  ({ n, trial, response, rtMs, outcome: { correct, tag }, atMs: n })

describe('Number Sprint engine', () => {
  it('is deterministic for a seed', () => { expect(trialsAt(10, 40, 3)).toEqual(trialsAt(10, 40, 3)); expect(trialsAt(10, 40, 3)).not.toEqual(trialsAt(10, 40, 4)) })
  it('plus and minus only at first, all four operations from level 5, two-step problems from level 10, decimals from level 16', () => {
    expect(new Set(trialsAt(4, 300).map(t => t.problem.op))).toEqual(new Set(['add', 'sub']))
    expect(new Set(trialsAt(5, 300).map(t => t.problem.op))).toEqual(new Set(['add', 'sub', 'mul', 'div']))
    expect(trialsAt(10, 300).some(t => t.problem.op === 'two')).toBe(true)
    expect(trialsAt(15, 300).some(t => t.problem.decimal)).toBe(false)
    expect(trialsAt(16, 300).some(t => t.problem.decimal)).toBe(true)
  })
  it('negative answers only from level 12', () => {
    expect(trialsAt(11, 600).every(t => t.problem.answer >= 0)).toBe(true)
    expect(trialsAt(12, 600).some(t => t.problem.answer < 0)).toBe(true)
  })
  it('the soft time shrinks from 12 s to 4 s and the hard window from 24 s to 8 s', () => {
    expect(trialsAt(1, 1)[0]).toMatchObject({ tqMs: 12000, windowMs: 24000 }); expect(trialsAt(20, 1)[0]).toMatchObject({ tqMs: 4000, windowMs: 8000 })
  })
  it('accepts the right answer, rejects a wrong one, a skip and a timeout', () => {
    const e = make(1), t = e.next() as NsTrial
    expect(e.evaluate(t, t.problem.answer, 2000)).toMatchObject({ correct: true })
    expect(e.evaluate(t, t.problem.answer + 1, 2000)).toMatchObject({ correct: false, tag: 'wrong' })
    expect(e.evaluate(t, 'skip', 2000)).toMatchObject({ correct: false, tag: 'skip' })
    expect(e.evaluate(t, 'timeout', 24000)).toMatchObject({ correct: false, tag: 'timeout' })
  })
  it('a right answer moves on at once; a wrong answer, skip or timeout shows the answer for a second', () => {
    const e = make(1), t = e.next() as NsTrial
    expect(e.gapAfter!(t, { correct: true })).toBe(120)
    expect(e.gapAfter!(t, { correct: false, tag: 'wrong' })).toBe(SHOW_ANSWER_MS); expect(e.gapAfter!(t, { correct: false, tag: 'timeout' })).toBe(1000)
  })
})

describe('Number Sprint scoring', () => {
  const t1 = trialsAt(1, 60)
  it('weights: right = 0.7 + 0.3 x speed, wrong = -0.5, skipped or timed out = 0', () => {
    const t = t1[0] // soft time 12 s
    expect(problemWeight(entry(1, t, t.problem.answer, 0, true))).toBeCloseTo(1, 6)
    expect(problemWeight(entry(1, t, t.problem.answer, 6000, true))).toBeCloseTo(0.85, 6)
    expect(problemWeight(entry(1, t, t.problem.answer, 12000, true))).toBeCloseTo(0.7, 6)
    expect(problemWeight(entry(1, t, t.problem.answer + 1, 3000, false))).toBe(-0.5)
    expect(problemWeight(entry(1, t, 'skip', 3000, false, 'skip'))).toBe(0)
    expect(problemWeight(entry(1, t, 'timeout', null, false, 'timeout'))).toBe(0)
  })
  it('hand-computed: 30 right at 2.4 s (weight 0.94 each), 4 wrong, against an items target of 40', () => {
    const log = [
      ...t1.slice(0, 30).map((t, i) => entry(i + 1, t, t.problem.answer, 2400, true)),
      ...t1.slice(30, 34).map((t, i) => entry(31 + i, t, t.problem.answer + 1, 1500, false)),
    ]
    // sum = 30 x (0.7 + 0.3 x 0.8) - 4 x 0.5 = 28.2 - 2 = 26.2 ; 26.2 / 40 = 0.655
    expect(summariseNumberSprint(log, 1).score).toBe(66)
    expect(summariseNumberSprint(log, 1).stats).toMatchObject({ problems: 34, solved: 30, wrong: 4, median_time_ms: 2400, weighted_total: 26.2 })
  })
  it('wrong answers can never lift the total above zero: guessing scores nothing', () => {
    expect(summariseNumberSprint(t1.map((t, i) => entry(i + 1, t, t.problem.answer + 3, 1000, false)), 1).score).toBe(0)
  })
  it('finds the operation missed most often and the accuracy per operation (for the Warm-up)', () => {
    const l5 = trialsAt(5, 200)
    const log = l5.map((t, i) => (t.problem.op === 'mul' ? entry(i + 1, t, t.problem.answer + 1, 2000, false) : entry(i + 1, t, t.problem.answer, 2000, true)))
    const stats = summariseNumberSprint(log, 5).stats!
    expect(stats.most_missed_op).toBe(3); expect(stats.acc_mul).toBe(0); expect(stats.acc_add).toBe(100)
    expect(summariseNumberSprint(l5.map((t, i) => entry(i + 1, t, t.problem.answer, 2000, true)), 5).stats!.most_missed_op).toBe(0)
  })
  it('review rows show the problem, what was typed and the right answer', () => {
    const t = t1[0]
    expect(summariseNumberSprint([entry(1, t, t.problem.answer + 1, 1000, false)], 1).review![0]).toMatchObject({ shown: t.problem.text, correct: false })
  })
})
