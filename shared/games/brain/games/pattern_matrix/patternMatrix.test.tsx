import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { PATTERN_MATRIX_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { createPatternMatrixEngine, describeFigure, summarisePatternMatrix, type PmResponse, type PmTrial } from './engine'
import { ATTRS, DOMAIN, distractorsAreWrong, FIGURE_KEYS, generateMatrices, isUnambiguous, predictions, type Figure, type MatrixPuzzle } from './generator'

const params = (level: number) => paramsAt(PATTERN_MATRIX_PARAMS, level)
const set = (level: number, seed = 1, count = 10) => generateMatrices({ params: params(level), seed, count })
const sameFigure = (a: Figure, b: Figure) => FIGURE_KEYS.every(key => a[key] === b[key])
const LEVELS = [1, 3, 5, 8, 10, 13, 14, 17, 20]

describe('Pattern Matrix generator', () => {
  it('is deterministic for a seed', () => { expect(set(10, 3)).toEqual(set(10, 3)); expect(set(10, 3)).not.toEqual(set(10, 4)) })
  it.each(LEVELS)('level %i: the right figure is unique, every other option breaks a rule, options are distinct', level => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const puzzle of set(level, seed)) {
        expect(puzzle.options).toHaveLength(Math.round(params(level).options))
        expect(puzzle.options[puzzle.correct]).toBeDefined()
        expect(distractorsAreWrong(puzzle), `level ${level} seed ${seed}`).toBe(true)
        for (let i = 0; i < puzzle.options.length; i++) for (let j = i + 1; j < puzzle.options.length; j++) expect(sameFigure(puzzle.options[i], puzzle.options[j])).toBe(false)
        puzzle.options.forEach((option, i) => { if (i !== puzzle.correct) expect(puzzle.changed[i].length).toBeGreaterThan(0) })
        expect(puzzle.changed[puzzle.correct]).toEqual([])
        for (const cell of [...puzzle.cells, ...puzzle.options]) for (const key of ATTRS) { expect(cell[key]).toBeGreaterThanOrEqual(0); expect(cell[key]).toBeLessThan(DOMAIN[key]) }
      }
    }
  })
  it('the number of rule-following attributes follows the level: 1 at level 1, 4 from level 15, plus the overlay from 14', () => {
    const ruled = (puzzle: MatrixPuzzle) => puzzle.rules.filter(rule => rule.attr !== 'mask').length
    expect(set(1).every(p => ruled(p) === 1)).toBe(true)
    expect(set(20).every(p => ruled(p) === 4)).toBe(true)
    expect(set(13).every(p => !p.overlay && p.rules.every(r => r.attr !== 'mask'))).toBe(true)
    expect(set(14).every(p => p.overlay && p.rules.some(r => r.attr === 'mask' && r.kind === 'logic'))).toBe(true)
  })
  it('options grow from 6 to 8 and the wrong ones get closer to the right one', () => {
    expect(set(1)[0].options).toHaveLength(6); expect(set(20)[0].options).toHaveLength(8)
    const nearShare = (level: number) => { const all = [1, 2, 3, 4, 5, 6].flatMap(seed => set(level, seed)); const wrong = all.flatMap(p => p.changed.filter((c, i) => i !== p.correct)); return wrong.filter(c => c.length === 1).length / wrong.length }
    expect(nearShare(20)).toBeGreaterThan(nearShare(1) + 0.3)
    expect(nearShare(20)).toBeGreaterThan(0.95)
  })
  it('the rule solver finds every rule kind and reports ambiguity when two rules fit with different answers', () => {
    // row values: progression +1 rows (0,1,2),(1,2,3),(0,1) -> 2
    expect(predictions([0, 1, 2, 1, 2, 3, 0, 1], 'shape', false).map(p => p.value)).toContain(2)
    // distribute: rows are shifts of the same three values
    expect(predictions([0, 1, 2, 1, 2, 0, 2, 0], 'colour', false).filter(p => p.kind === 'distribute').map(p => p.value)).toEqual([1])
    // constant rows
    expect(predictions([2, 2, 2, 0, 0, 0, 3, 3], 'size', false).filter(p => p.kind === 'constant').map(p => p.value)).toEqual([3])
    // fixed
    expect(predictions([1, 1, 1, 1, 1, 1, 1, 1], 'count', false).map(p => p.value)).toEqual([1, 1])
    // xor / and masks, and an ambiguous mask grid (both fit, different answers)
    expect(predictions([3, 5, 6, 9, 3, 10, 7, 12], 'mask', true)).toEqual([{ kind: 'logic', detail: 0, value: 11 }])
    const both = predictions([0, 0, 0, 0, 0, 0, 5, 5], 'mask', true)
    expect(new Set(both.map(p => p.value)).size).toBeGreaterThan(1)
    const grids = Object.fromEntries(FIGURE_KEYS.map(key => [key, key === 'mask' ? [0, 0, 0, 0, 0, 0, 5, 5, 5] : [0, 0, 0, 0, 0, 0, 0, 0, 0]])) as Record<(typeof FIGURE_KEYS)[number], number[]>
    expect(isUnambiguous(grids, true)).toBe(false)
  })
  it('worst-case generation of a whole set at level 20 is quick (it still runs in a Worker with the others)', () => {
    const t = performance.now(); set(20, 9, 10); expect(performance.now() - t).toBeLessThan(2000)
  })
})

describe('Pattern Matrix engine and scoring', () => {
  const play = (level: number, answer: (t: PmTrial) => PmResponse | 'timeout', rt = 20000) => {
    const engine = createPatternMatrixEngine(params(level), createRng(3))
    const log: TrialLogEntry<PmTrial, PmResponse>[] = []
    for (let t = engine.next(); t !== null; t = engine.next()) {
      const response = answer(t)
      log.push({ n: log.length + 1, trial: t, response, rtMs: response === 'timeout' ? null : rt, outcome: engine.evaluate(t, response, rt), atMs: log.length })
    }
    return log
  }
  const right = (t: PmTrial) => t.puzzle.correct
  const wrongOne = (t: PmTrial) => (t.puzzle.correct + 1) % t.puzzle.options.length
  it('deals ten puzzles, counted when judged', () => {
    expect(play(5, right)).toHaveLength(ROUND_COUNTS.pattern_matrix)
    const engine = createPatternMatrixEngine(params(5), createRng(3))
    for (let i = 0; i < 25; i++) engine.next()
    expect(engine.next()).not.toBeNull()
  })
  it('a perfect player at RT_fast scores 100; slow but right scores 85; guessing scores nothing', () => {
    expect(summarisePatternMatrix(play(10, right, 12000), 10).score).toBeGreaterThanOrEqual(99)
    // speed 0 at the time limit: 100 x 1 x 0.85
    expect(summarisePatternMatrix(play(10, right, params(10).rtSlow), 10).score).toBe(85)
    expect(summarisePatternMatrix(play(10, wrongOne), 10).score).toBe(0)
    expect(summarisePatternMatrix(play(10, () => 'timeout'), 10).score).toBe(0)
  })
  it('chance-corrects over the ten puzzles: right answers to 1 in 6 is about nothing', () => {
    let n = 0
    const log = play(1, t => (n++ === 0 ? right(t) : wrongOne(t)))
    expect(summarisePatternMatrix(log, 1).score).toBeLessThanOrEqual(2)
  })
  it('separates a near miss (one attribute off) from a far one, and reports accuracy by rule type', () => {
    const log = play(10, t => (t.puzzle.changed.findIndex(c => c.length === 1) >= 0 ? t.puzzle.changed.findIndex(c => c.length === 1) : wrongOne(t)))
    const stats = summarisePatternMatrix(log, 10).stats!
    expect(stats.err_near).toBeGreaterThan(0)
    expect(stats.err_near + stats.err_far).toBe(log.length)
    expect(summarisePatternMatrix(play(10, right), 10).stats).toMatchObject({ solved: 10, accuracy: 1 })
    expect(Object.keys(stats).length).toBeLessThanOrEqual(20)
  })
  it('review rows describe the right figure in words', () => {
    const row = summarisePatternMatrix(play(5, right), 5).review![0]
    expect(row.correct).toBe(true)
    expect(row.correctAnswer).toBe(describeFigure(play(5, right)[0].trial.puzzle.options[play(5, right)[0].trial.puzzle.correct]))
    expect(row.shown).toMatch(/^rules: /)
  })
})

describe('Pattern Matrix drawing', () => {
  it('every figure of every puzzle can be drawn and described: count 0 to 3 means 1 to 4 shapes', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { FigureView } = await import('./FigureView')
    for (const level of [1, 10, 14, 20]) for (const puzzle of set(level, 7)) for (const figure of [...puzzle.cells, ...puzzle.options]) {
      const html = renderToStaticMarkup(<FigureView figure={figure} />)
      expect((html.match(/<g /g) ?? []).length).toBe(figure.count + 1)
      expect(describeFigure(figure)).toMatch(/^[1-4] /)
    }
  })
})
