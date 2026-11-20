import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { NUMBER_SERIES_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { createNumberSeriesEngine, summariseNumberSeries, type NsrResponse, type NsrTrial } from './engine'
import { FAMILIES, FAMILY_TIER, familiesAt, fits, generateSeries, generateSeriesSet, isUnambiguousSeries, type Family, type SeriesPuzzle } from './generator'

const params = (level: number) => paramsAt(NUMBER_SERIES_PARAMS, level)
const set = (level: number, seed = 1, count = 12) => generateSeriesSet({ params: params(level), seed, count })
const nextFor = (family: Family, terms: number[]) => fits(terms).filter(f => f.family === family).map(f => f.next)
const LEVELS = [1, 4, 5, 9, 13, 17, 20]

describe('Number Series rule solver', () => {
  it('each family predicts its next term from a prefix', () => {
    expect(nextFor('arithmetic', [3, 7, 11, 15])).toEqual([19])
    expect(nextFor('geometric', [2, 6, 18, 54])).toEqual([162])
    expect(nextFor('geometric', [64, 32, 16, 8])).toEqual([4])
    expect(nextFor('alternating', [1, 3, 6, 8, 16, 18, 36])).toEqual([38])  // +2, x2, +2, x2, +2, x2 ... then +2
    expect(nextFor('second_order', [1, 2, 4, 7, 11])).toEqual([16])
    expect(nextFor('power', [5, 8, 13, 20])).toEqual([29])  // n squared + 4 for n = 1, 2, 3, 4
    expect(nextFor('linear', [1, 3, 7, 15, 31])).toEqual([63])
    expect(nextFor('fibonacci', [1, 1, 2, 3, 5])).toEqual([8])
    expect(nextFor('interleaved', [2, 10, 5, 20, 8, 40])).toEqual([11])
    expect(nextFor('digit_sum', [7, 14, 19, 29])).toEqual([40])
  })
  it('an arithmetic prefix is not ambiguous, but a short interleaved-looking one is', () => {
    expect(isUnambiguousSeries([2, 4, 6, 8, 10, 12], 14)).toBe(true)
    // Six terms of a doubling series: every reading (doubling, woven series, linear) gives 64.
    expect(isUnambiguousSeries([2, 4, 8, 16, 32, 64], 128)).toBe(true)
    // With only five terms one half of a woven reading has two terms (28 or 64 next): the puzzle is NOT accepted as unambiguous.
    expect(isUnambiguousSeries([2, 4, 8, 16, 32], 64)).toBe(false)
    expect(new Set(fits([2, 4, 8, 16, 32]).map(f => f.next))).toEqual(new Set([64, 28]))
  })
})

describe('Number Series generator', () => {
  it('is deterministic for a seed', () => { expect(set(9, 3)).toEqual(set(9, 3)); expect(set(9, 3)).not.toEqual(set(9, 4)) })
  it.each(LEVELS)('level %i: every puzzle is unambiguous under the whole rule library, the answer is among 5 distinct options', level => {
    for (const seed of [1, 2, 3, 4, 5, 6]) for (const puzzle of set(level, seed)) {
      const found = fits(puzzle.terms)
      expect(found.length, JSON.stringify(puzzle)).toBeGreaterThan(0)
      expect(found.every(f => f.next === puzzle.answer), JSON.stringify(puzzle)).toBe(true)
      expect(puzzle.options).toHaveLength(5)
      expect(new Set(puzzle.options).size).toBe(5)
      expect(puzzle.options).toContain(puzzle.answer)
      expect(puzzle.terms).toHaveLength(Math.round(params(level).shown))
      expect(puzzle.terms.every(Number.isInteger) && Number.isInteger(puzzle.answer)).toBe(true)
    }
  })
  it('the rule pool widens with the level: arithmetic and geometric first, digit-sum rules only at the top', () => {
    const familiesSeen = (level: number) => new Set([1, 2, 3, 4, 5, 6, 7, 8].flatMap(seed => set(level, seed)).map(p => p.family))
    expect([...familiesSeen(1)].sort()).toEqual(['arithmetic', 'geometric'])
    expect(familiesSeen(8).has('power')).toBe(false)
    for (const f of familiesAt(4)) expect(FAMILY_TIER[f]).toBeLessThanOrEqual(4)
    expect(familiesAt(4)).toEqual(FAMILIES)
    expect(familiesSeen(20).has('digit_sum')).toBe(true)
    expect(familiesSeen(9).has('digit_sum')).toBe(false)
  })
  it('shows 8 terms at level 1 and 5 at level 20', () => {
    expect(set(1)[0].terms).toHaveLength(8); expect(set(20)[0].terms).toHaveLength(5)
  })
  it('early levels keep the numbers small', () => { for (const seed of [1, 2, 3]) for (const p of set(1, seed)) expect(Math.max(...p.terms, p.answer)).toBeLessThanOrEqual(3000) })
  it('distractors include the plausible mistakes: the arithmetic guess and off-by-one', () => {
    const puzzle = generateSeries(createRng(5), { tier: 0, shown: 6 })
    const last = puzzle.terms[puzzle.terms.length - 1], prev = puzzle.terms[puzzle.terms.length - 2]
    const wrong = puzzle.options.filter(o => o !== puzzle.answer)
    if (puzzle.family === 'geometric') expect(wrong).toContain(last + (last - prev))
    expect(wrong.length).toBe(4)
  })
})

describe('Number Series engine and scoring', () => {
  const play = (level: number, answer: (t: NsrTrial) => NsrResponse | 'timeout', rt = 20000) => {
    const engine = createNumberSeriesEngine(params(level), createRng(3))
    const log: TrialLogEntry<NsrTrial, NsrResponse>[] = []
    for (let t = engine.next(); t !== null; t = engine.next()) {
      const response = answer(t)
      log.push({ n: log.length + 1, trial: t, response, rtMs: response === 'timeout' ? null : rt, outcome: engine.evaluate(t, response, rt), atMs: log.length })
    }
    return log
  }
  const right = (t: NsrTrial) => t.puzzle.answer
  const wrong = (t: NsrTrial) => t.puzzle.answer + 1
  it('deals twelve puzzles; typed answers from level 15', () => {
    expect(play(5, right)).toHaveLength(ROUND_COUNTS.number_series)
    expect(play(14, right)[0].trial.typed).toBe(false); expect(play(15, right)[0].trial.typed).toBe(true)
    expect(play(1, right)[0].trial).toMatchObject({ limitMs: 60000 }); expect(play(20, right)[0].trial).toMatchObject({ limitMs: 25000 })
  })
  it('a perfect player scores 100, slow but right 85, guessing among 5 about nothing', () => {
    expect(summariseNumberSeries(play(5, right, 7000), 5).score).toBe(100)
    expect(summariseNumberSeries(play(5, right, params(5).rtSlow), 5).score).toBe(85)
    expect(summariseNumberSeries(play(5, wrong), 5).score).toBe(0)
    let n = 0
    expect(summariseNumberSeries(play(5, t => (n++ % 5 === 0 ? right(t) : wrong(t))), 5).score).toBeLessThanOrEqual(10) // 25 % right is about chance (20 %)
  })
  it('typed levels score accuracy directly (no chance level to subtract)', () => {
    let n = 0
    const half = play(16, t => (n++ % 2 === 0 ? right(t) : wrong(t)), 6000)
    expect(summariseNumberSeries(half, 16).score).toBeGreaterThan(40)
    expect(summariseNumberSeries(half, 16).score).toBeLessThanOrEqual(50)
  })
  it('reports accuracy by rule family, median time and review rows with the rule in words', () => {
    const summary = summariseNumberSeries(play(13, right), 13)
    expect(summary.stats).toMatchObject({ puzzles: 12, solved: 12, accuracy: 1, median_time_ms: 20000, typed: 0 })
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
    expect(Object.keys(summary.stats!).filter(k => k.startsWith('acc_'))).toHaveLength(FAMILIES.length)
    expect(summary.review![0].correctAnswer).toMatch(/\(.+\)/)
  })
})
