import { describe, expect, it } from 'vitest'
import { createRng } from '../../core/rng'
import { addCarries, answersEqual, formatNumber, makeProblem, makeReverse, parseTyped, specFromParams, subBorrows, type Problem, type ProblemSpec } from './arithmetic'

const spec = (over: Partial<ProblemSpec> = {}): ProblemSpec => ({ ops: 1, addMax: 99, mulMax: 12, carry: true, negatives: false, decimals: false, ...over })
const many = (s: ProblemSpec, count = 400, seed = 1): Problem[] => { const rng = createRng(seed); return Array.from({ length: count }, () => makeProblem(rng, s)) }
/** Evaluate the printed expression independently of the generator (brackets and precedence as written). */
const evaluate = (text: string): number => Number(new Function(`return (${text.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')})`)().toFixed(9))

describe('arithmetic problems', () => {
  it('are deterministic for a seed', () => {
    expect(many(spec(), 50, 3)).toEqual(many(spec(), 50, 3))
    expect(many(spec(), 50, 3)).not.toEqual(many(spec(), 50, 4))
  })
  it('every answer matches the printed expression, for every operation, two-step and decimal problems', () => {
    for (const s of [spec({ ops: 0, addMax: 9 }), spec(), spec({ ops: 2, negatives: true }), spec({ ops: 2, decimals: true, negatives: true, addMax: 999 })]) {
      for (const problem of many(s)) expect(evaluate(problem.text), problem.text).toBeCloseTo(problem.answer, 6)
    }
  })
  it('division is always exact and never by 0 or 1', () => {
    const divisions = many(spec({ ops: 1 }), 600).filter(p => p.op === 'div')
    expect(divisions.length).toBeGreaterThan(50)
    for (const p of divisions) { expect(Number.isInteger(p.answer)).toBe(true); expect(p.parts!.b).toBeGreaterThanOrEqual(2); expect(p.parts!.a % p.parts!.b).toBe(0) }
  })
  it('plus and minus only at ops 0; the four operations at ops 1; two-step problems appear at ops 2', () => {
    expect(new Set(many(spec({ ops: 0 })).map(p => p.op))).toEqual(new Set(['add', 'sub']))
    expect(new Set(many(spec({ ops: 1 })).map(p => p.op))).toEqual(new Set(['add', 'sub', 'mul', 'div']))
    expect(many(spec({ ops: 2 })).some(p => p.op === 'two')).toBe(true)
  })
  it('without carries (levels 1 and 2) no addition carries and no subtraction borrows; with them both occur', () => {
    for (const addMax of [9, 20]) {
      for (const p of many(spec({ ops: 0, addMax, carry: false }), 600)) {
        const { a, b } = p.parts!
        if (p.op === 'add') expect(addCarries(a, b), p.text).toBe(false)
        else { expect(a, p.text).toBeGreaterThanOrEqual(b); expect(subBorrows(a, b), p.text).toBe(false) }
      }
    }
    const loose = many(spec({ ops: 0, addMax: 99, carry: true }), 600)
    expect(loose.some(p => p.op === 'add' && addCarries(p.parts!.a, p.parts!.b))).toBe(true)
    expect(loose.some(p => p.op === 'sub' && subBorrows(p.parts!.a, p.parts!.b))).toBe(true)
  })
  it('negative answers appear only when allowed', () => {
    expect(many(spec({ ops: 2 }), 800).every(p => p.answer >= 0)).toBe(true)
    expect(many(spec({ ops: 2, negatives: true }), 800).some(p => p.answer < 0)).toBe(true)
  })
  it('decimal problems come out without floating-point error, with at most two decimal places', () => {
    const decimals = many(spec({ decimals: true, addMax: 99 }), 600).filter(p => p.decimal)
    expect(decimals.length).toBeGreaterThan(100)
    for (const p of decimals) { expect(Math.round(p.answer * 100) / 100, p.text).toBe(p.answer); expect(formatNumber(p.answer)).toMatch(/^-?\d+(\.\d{1,2})?$/) }
    expect(many(spec({ decimals: false }), 300).every(p => !p.decimal)).toBe(true)
  })
  it('operands and answers stay inside the configured sizes', () => {
    for (const p of many(spec({ ops: 1, addMax: 9, mulMax: 5 }), 400)) { expect(p.parts!.a).toBeLessThanOrEqual(45); expect(Math.abs(p.answer)).toBeLessThanOrEqual(45) }
    for (const p of many(spec({ ops: 2, addMax: 999, mulMax: 30 }), 400)) expect(Math.abs(p.answer)).toBeLessThanOrEqual(9999)
  })
  it('reverse form hides one operand and the answer fills it in', () => {
    const rng = createRng(5)
    const singles = many(spec({ ops: 1 }), 200).filter(p => p.parts)
    let reversed = 0
    for (const p of singles) {
      const r = makeReverse(p, rng)!
      reversed += 1
      expect(r.text).toMatch(/\?/)
      const [left, right] = r.text.replace('?', String(r.answer)).split(' = ')
      expect(evaluate(left), r.text).toBe(Number(right))
    }
    expect(reversed).toBe(singles.length)
    expect(makeReverse(many(spec({ ops: 2 }), 100).find(p => p.op === 'two')!, rng)).toBeNull()
  })
  it('parses what a player types', () => {
    expect(parseTyped('42')).toBe(42); expect(parseTyped(' -7 ')).toBe(-7); expect(parseTyped('−7')).toBe(-7); expect(parseTyped('0.25')).toBe(0.25); expect(parseTyped('.5')).toBe(0.5)
    for (const bad of ['', '-', '.', '1.2.3', '4a', '--3']) expect(parseTyped(bad), bad).toBeNull()
    expect(answersEqual(0.1 + 0.2, 0.3)).toBe(true); expect(answersEqual(4, 5)).toBe(false)
  })
  it('builds a spec from level parameters', () => {
    expect(specFromParams({ ops: 2, addMax: 99, mulMax: 12, carry: 1, negatives: 0, decimals: 1 })).toEqual({ ops: 2, addMax: 99, mulMax: 12, carry: true, negatives: false, decimals: true })
  })
})
