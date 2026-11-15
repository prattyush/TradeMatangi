/**
 * Arithmetic problems for Number Sprint and Equation Drop (spec 17.5 #13 and #14). Pure and seeded.
 * Division is always exact; two-step problems follow the usual precedence and are written with brackets where needed;
 * decimal problems are computed on integers scaled by 100 so the answer carries no floating-point error.
 */
import type { Rng } from '../../core/rng'

export type ProblemOp = 'add' | 'sub' | 'mul' | 'div' | 'two'
export const OP_CODES: Record<ProblemOp, number> = { add: 1, sub: 2, mul: 3, div: 4, two: 5 }
const SIGN: Record<'add' | 'sub' | 'mul' | 'div', string> = { add: '+', sub: '−', mul: '×', div: '÷' }

export interface Problem {
  /** The expression, without the answer ("14 + 9"). */
  text: string
  answer: number
  op: ProblemOp
  decimal: boolean
  /** Single-operation integer problems keep their parts so Equation Drop can hide one operand. */
  parts?: { a: number; b: number; sign: string }
}

export interface ProblemSpec {
  /** 0 plus and minus, 1 all four, 2 all four plus two-step problems. */
  ops: number
  addMax: number
  mulMax: number
  /** Allow carries and borrows. */
  carry: boolean
  negatives: boolean
  decimals: boolean
}

export const specFromParams = (params: Record<string, number>): ProblemSpec => ({
  ops: Math.round(params.ops), addMax: Math.round(params.addMax), mulMax: Math.round(params.mulMax),
  carry: (params.carry ?? 1) >= 1, negatives: (params.negatives ?? 0) >= 1, decimals: (params.decimals ?? 0) >= 1,
})

const digitsOf = (n: number): number[] => String(n).split('').reverse().map(Number)
/** True when a + b needs a carry in some column. */
export function addCarries(a: number, b: number): boolean {
  const da = digitsOf(a), db = digitsOf(b)
  for (let i = 0; i < Math.max(da.length, db.length); i++) if ((da[i] ?? 0) + (db[i] ?? 0) >= 10) return true
  return false
}
/** True when a - b (a >= b) needs a borrow in some column. */
export function subBorrows(a: number, b: number): boolean {
  const da = digitsOf(a), db = digitsOf(b)
  for (let i = 0; i < da.length; i++) if (da[i] < (db[i] ?? 0)) return true
  return false
}

export const answersEqual = (x: number, y: number): boolean => Math.abs(x - y) < 1e-9

/** Show a number without trailing zeros ("0.25", "12.5", "-3"). */
export const formatNumber = (value: number): string => String(Math.round(value * 1e6) / 1e6)

/** Parse what a player typed: an optional minus, digits and at most one decimal point. `null` when it is not a number. */
export function parseTyped(text: string): number | null {
  const trimmed = text.trim().replace(/^−/, '-')
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** A random number that goes digit by digit under `limit` (a digit string): every digit of the result is at most the digit of `limit`. */
function digitwiseUnder(rng: Rng, limit: number): number {
  const digits = digitsOf(limit)
  return digits.reduce((sum, d, i) => sum + rng.int(0, d) * 10 ** i, 0)
}

function singleInteger(rng: Rng, op: 'add' | 'sub' | 'mul' | 'div', spec: ProblemSpec): Problem {
  const lo = spec.addMax <= 9 ? 1 : 2
  if (op === 'add' || op === 'sub') {
    let a = rng.int(lo, spec.addMax), b: number
    if (op === 'add') {
      // Without carries every column of b stays under what is left of 9 - the digit of a.
      b = spec.carry ? rng.int(lo, spec.addMax) : digitwiseUnder(rng, Number(digitsOf(a).map(d => 9 - d).reverse().join('')))
      if (b < 1) { a = rng.int(lo, 8); b = rng.int(1, 9 - a) } // a was all nines: nothing can be added without a carry
    } else if (spec.carry) {
      b = rng.int(lo, spec.addMax)
      if (b > a && !spec.negatives) [a, b] = [b, a]
    } else {
      // No borrows: every digit of b is at most the digit of a.
      b = digitwiseUnder(rng, a)
      if (b < 1) { a = rng.int(2, 9); b = rng.int(1, a) } // a was a round number: subtract a single digit instead
    }
    return { text: `${a} ${SIGN[op]} ${b}`, answer: op === 'add' ? a + b : a - b, op, decimal: false, parts: { a, b, sign: SIGN[op] } }
  }
  const bMax = Math.max(3, Math.min(spec.mulMax, 12))
  if (op === 'mul') {
    const a = rng.int(2, spec.mulMax), b = rng.int(2, bMax)
    return { text: `${a} ${SIGN.mul} ${b}`, answer: a * b, op, decimal: false, parts: { a, b, sign: SIGN.mul } }
  }
  const b = rng.int(2, bMax), q = rng.int(2, spec.mulMax)
  return { text: `${b * q} ${SIGN.div} ${b}`, answer: q, op, decimal: false, parts: { a: b * q, b, sign: SIGN.div } }
}

function twoStep(rng: Rng, spec: ProblemSpec): Problem {
  const small = Math.max(3, Math.min(spec.mulMax, 12))
  const wide = Math.min(spec.addMax, 99)
  for (let tries = 0; tries < 40; tries++) {
    const form = rng.int(0, 4)
    const a = rng.int(2, wide), b = rng.int(2, wide), c = rng.int(2, wide)
    const x = rng.int(2, small), y = rng.int(2, small)
    let text: string, answer: number
    if (form === 0) { text = `${a} + ${b} ${SIGN.sub} ${c}`; answer = a + b - c }
    else if (form === 1) { text = `${x} ${SIGN.mul} ${y} + ${c}`; answer = x * y + c }
    else if (form === 2) { text = `${x} ${SIGN.mul} ${y} ${SIGN.sub} ${c}`; answer = x * y - c }
    else if (form === 3) { text = `(${a} + ${b}) ${SIGN.mul} ${x}`; answer = (a + b) * x }
    else { text = `${a} + ${x} ${SIGN.mul} ${y}`; answer = a + x * y }
    if ((answer < 0 && !spec.negatives) || Math.abs(answer) > 9999) continue
    return { text, answer, op: 'two', decimal: false }
  }
  return singleInteger(rng, 'add', spec)
}

/** A decimal problem such as `0.5 + 0.25`, `12.5 - 3.75` or `1.5 x 4`, worked in hundredths. */
function decimalProblem(rng: Rng, spec: ProblemSpec): Problem {
  const show = (hundredths: number) => formatNumber(hundredths / 100)
  const kind = rng.int(0, 2)
  if (kind === 2) {
    const tenths = rng.int(11, 59), k = rng.int(2, 9) // 1.1 .. 5.9 times a small whole number
    return { text: `${show(tenths * 10)} ${SIGN.mul} ${k}`, answer: (tenths * 10 * k) / 100, op: 'mul', decimal: true }
  }
  const dp = rng.chance(0.5) ? 10 : 1 // one or two decimal places
  let a = rng.int(5, 400) * dp, b = rng.int(5, 400) * dp
  if (kind === 1) {
    if (a < b && !spec.negatives) [a, b] = [b, a]
    return { text: `${show(a)} ${SIGN.sub} ${show(b)}`, answer: (a - b) / 100, op: 'sub', decimal: true }
  }
  return { text: `${show(a)} + ${show(b)}`, answer: (a + b) / 100, op: 'add', decimal: true }
}

export function makeProblem(rng: Rng, spec: ProblemSpec): Problem {
  if (spec.decimals && rng.chance(0.3)) return decimalProblem(rng, spec)
  if (spec.ops >= 2 && rng.chance(0.5)) return twoStep(rng, spec)
  const pool: Array<'add' | 'sub' | 'mul' | 'div'> = spec.ops === 0 ? ['add', 'sub'] : ['add', 'sub', 'mul', 'div']
  return singleInteger(rng, rng.pick(pool), spec)
}

/** Equation Drop's reverse form: hide one operand of a single-operation problem ("? + 9 = 23", answer 14). */
export function makeReverse(problem: Problem, rng: Rng): Problem | null {
  if (!problem.parts) return null
  const { a, b, sign } = problem.parts
  const hideLeft = rng.chance(0.5)
  return {
    text: hideLeft ? `? ${sign} ${b} = ${problem.answer}` : `${a} ${sign} ? = ${problem.answer}`,
    answer: hideLeft ? a : b, op: problem.op, decimal: false,
  }
}
