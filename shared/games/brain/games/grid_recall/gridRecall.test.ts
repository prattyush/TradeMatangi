import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { GRID_RECALL_PARAMS } from '../../config/difficulty.brain'
import { createGridRecallEngine, grExpected, grGrade, grRules, summariseGridRecall, type GrResponse, type GrTrial } from './engine'

const engine = (level: number, seed = 1) => createGridRecallEngine(paramsAt(GRID_RECALL_PARAMS, level), createRng(seed))
const make = (level: number, seed = 1): GrTrial => engine(level, seed).next() as GrTrial
const entry = (n: number, trial: GrTrial, response: GrResponse): TrialLogEntry<GrTrial, GrResponse> => ({ n, trial, response, rtMs: null, outcome: { correct: grGrade(trial, response).success }, atMs: n })

describe('Grid Recall rules by level', () => {
  it('derives the ceiling, gain target and trial cap from the grid and start span (correction C1)', () => {
    expect(grRules(paramsAt(GRID_RECALL_PARAMS, 1))).toMatchObject({ gridN: 3, startSpan: 3, step: 2, maxSpan: 7, gainTarget: 5, maxTrials: 8 })
    expect(grRules(paramsAt(GRID_RECALL_PARAMS, 5))).toMatchObject({ gridN: 4, step: 1, maxSpan: 12, gainTarget: 6, maxTrials: 9 })
    expect(grRules(paramsAt(GRID_RECALL_PARAMS, 20))).toMatchObject({ gridN: 6, startSpan: 5, maxSpan: 12, gainTarget: 6, maxTrials: 9 })
  })
  it('mode: in order to level 7, all at once 8 to 11, reverse from 12; the grid turns only from 18', () => {
    expect([1, 7, 8, 11, 12, 20].map(l => make(l).mode)).toEqual([0, 0, 1, 1, 2, 2])
    expect([1, 17].map(l => make(l).transform)).toEqual(['none', 'none'])
    const turns = new Set(Array.from({ length: 40 }, (_, i) => make(18, i + 1).transform))
    expect(turns.has('none')).toBe(false); expect(turns.size).toBeGreaterThan(2)
  })
  it('flash and gap follow the level', () => {
    expect(make(1)).toMatchObject({ flashMs: 700, gapMs: 200 })
    expect(make(20)).toMatchObject({ flashMs: 300, gapMs: 200 })
  })
})

describe('Grid Recall engine', () => {
  it('is deterministic for a seed, and the sequence is distinct tiles inside the grid', () => {
    expect(make(10, 4)).toEqual(make(10, 4)); expect(make(10, 4)).not.toEqual(make(10, 5))
    for (let seed = 1; seed < 30; seed++) {
      const t = make(10, seed)
      expect(t.sequence).toHaveLength(t.span); expect(new Set(t.sequence).size).toBe(t.span)
      expect(Math.max(...t.sequence)).toBeLessThan(25)
    }
  })
  it('the span rises with each success by the step, a failure keeps it, three failures end the game', () => {
    const e = engine(5)
    const spans: number[] = []
    for (const ok of [true, true, false, true, false, false]) {
      const t = e.next() as GrTrial
      spans.push(t.span)
      e.evaluate(t, ok ? grExpected(t) : [])
    }
    expect(spans).toEqual([3, 4, 5, 5, 6, 6])
    expect(e.next()).toBeNull()
    expect(e.progress!()).toMatchObject({ span: 6, strikes: 3 })
  })
  it('a perfect player at level 1 climbs 3, 5, 7 and the session then ends at the ceiling', () => {
    const e = engine(1)
    const spans: number[] = []
    for (let t = e.next() as GrTrial | null; t; t = e.next() as GrTrial | null) { spans.push(t.span); e.evaluate(t, grExpected(t)) }
    expect(spans).toEqual([3, 5, 7])
  })
  it('a replaced round (a bad frame) changes nothing: the engine only moves when a round is judged', () => {
    const e = engine(5)
    const first = e.next() as GrTrial, replacement = e.next() as GrTrial
    expect(replacement.span).toBe(first.span)
    expect(e.progress!()).toMatchObject({ span: 3, strikes: 0, trial: 0 })
  })
  it('stages: a ready beat, a critical show stage, a turn when the grid turns, then the open answer', () => {
    const plain = engine(1).stages!(make(1))
    expect(plain.map(s => s.name)).toEqual(['ready', 'show', 'respond'])
    expect(plain[1]).toMatchObject({ critical: true, ms: 3 * 900 + 300 }); expect(plain[2].ms).toBeNull()
    const turned = engine(18).stages!(make(18))
    expect(turned.map(s => s.name)).toEqual(['ready', 'show', 'turn', 'respond'])
    expect(engine(8).stages!(make(8))[1].ms).toBeLessThan(plain[1].ms as number + 3000)
  })
})

describe('Grid Recall grading', () => {
  const base: GrTrial = { span: 4, sequence: [2, 7, 1, 5], gridN: 3, mode: 0, flashMs: 700, gapMs: 200, simultaneousMs: 2000, transform: 'none' }
  it('in order: every position must match', () => {
    expect(grGrade(base, [2, 7, 1, 5]).success).toBe(true)
    expect(grGrade(base, [7, 2, 1, 5])).toMatchObject({ success: false, fraction: 0.5 })
    expect(grGrade(base, [2, 7, 1])).toMatchObject({ success: false, fraction: 0.75 })
    expect(grGrade(base, [2, 7, 1, 5, 0]).success).toBe(false) // too many answers
  })
  it('reverse mode expects the sequence backwards', () => {
    const reverse = { ...base, mode: 2 as const }
    expect(grExpected(reverse)).toEqual([5, 1, 7, 2])
    expect(grGrade(reverse, [5, 1, 7, 2]).success).toBe(true)
    expect(grGrade(reverse, [2, 7, 1, 5]).success).toBe(false)
  })
  it('all-at-once mode accepts any order, and a repeated tap counts once', () => {
    const set = { ...base, mode: 1 as const }
    expect(grGrade(set, [5, 1, 2, 7]).success).toBe(true)
    expect(grGrade(set, [2, 2, 2, 2])).toMatchObject({ success: false, fraction: 0.25 })
    expect(grGrade(set, [2, 7, 1, 5]).chance).toBeCloseTo(4 / 9)
    expect(grGrade(base, []).chance).toBeCloseTo(1 / 9)
  })
})

describe('Grid Recall scoring', () => {
  it('hand-computed at level 5: peak span 5 from a start of 3, accuracy part from chance-corrected fractions', () => {
    const t3 = { ...make(5), span: 3, sequence: [0, 1, 2] }, t4 = { ...make(5), span: 4, sequence: [0, 1, 2, 3] }, t5 = { ...make(5), span: 5, sequence: [0, 1, 2, 3, 4] }, t6 = { ...make(5), span: 6, sequence: [0, 1, 2, 3, 4, 5] }
    const log = [entry(1, t3, [0, 1, 2]), entry(2, t4, [0, 1, 2, 3]), entry(3, t5, [0, 1, 2, 3, 4]), entry(4, t6, [0, 1, 2, 3, 9, 8])]
    const summary = summariseGridRecall(log, 5)
    // gain 3 of 6 -> progress .5; trial 4 fraction 4/6, chance 1/16 -> adjusted .6222; mean adjusted (3 + .6222)/4 = .9056
    expect(summary.score).toBe(Math.round(100 * (0.7 * 0.5 + 0.3 * ((3 + (4 / 6 - 1 / 16) / (1 - 1 / 16)) / 4))))
    expect(summary.stats).toMatchObject({ peak_span: 5, strikes: 1, trials: 4 })
    expect(summary.review).toHaveLength(4)
    expect(summary.review![3]).toMatchObject({ correct: false, correctAnswer: '1 2 3 4 5 6' })
  })
  it('a first-trial failure leaves only a small accuracy part; guessing scores about nothing', () => {
    const t = make(1)
    expect(summariseGridRecall([entry(1, t, [8, 8, 8])], 1).score).toBe(0)
    expect(summariseGridRecall([], 1).score).toBe(0)
  })
})
