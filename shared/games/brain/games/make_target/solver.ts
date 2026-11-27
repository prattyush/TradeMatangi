/**
 * Make Target solver and puzzle generator (spec 17.5 #15). Pure and seeded; the generator is the heavy part (an exhaustive
 * search over every way to combine up to six numbers), so the website runs it in a Web Worker (`makeTarget.worker.ts`,
 * spec 17.7 / C7) and a puzzle set is built before the block starts.
 *
 * Rules: each given number is used at most once; `+ - x /` on two numbers at a time; every intermediate result must be a
 * positive integer (a subtraction never goes to zero or below, a division must be exact). The solver is a breadth-first search over
 * the multiset of numbers still available, so the first layer that contains the target is the minimum number of operations.
 */
import { createRng, type Rng } from '../../../core/rng'

export type Operator = '+' | '-' | '*' | '/'
export interface Step { a: number; op: Operator; b: number; result: number }
export interface Solution { depth: number; steps: Step[] }

export const OPERATOR_SIGN: Record<Operator, string> = { '+': '+', '-': '−', '*': '×', '/': '÷' }

/** The result of `a op b`, or `null` when the rules do not allow it (not a positive integer, or a pointless x1 and /1). */
export function apply(a: number, op: Operator, b: number): number | null {
  let value: number
  if (op === '+') value = a + b
  else if (op === '-') value = a - b
  else if (op === '*') { if (a === 1 || b === 1) return null; value = a * b }
  else { if (b === 0 || b === 1 || a % b !== 0) return null; value = a / b }
  return Number.isInteger(value) && value > 0 ? value : null
}

const OPERATORS: Operator[] = ['+', '-', '*', '/']
const keyOf = (numbers: number[]): string => numbers.join(',')

interface Node { numbers: number[]; parent: number; step: Step | null }

/**
 * Fewest operations that turn `numbers` into a list containing `target`, with one way to do it. `limit` caps the depth
 * searched (default: use every number). `null` when it cannot be reached within the limit. A target that is already
 * among the numbers is depth 0.
 */
export function solve(numbers: number[], target: number, limit = numbers.length - 1): Solution | null {
  const start = [...numbers].sort((x, y) => x - y)
  if (start.includes(target)) return { depth: 0, steps: [] }
  const nodes: Node[] = [{ numbers: start, parent: -1, step: null }]
  const seen = new Set<string>([keyOf(start)])
  let layer = [0]
  for (let depth = 1; depth <= limit && layer.length; depth++) {
    const nextLayer: number[] = []
    for (const index of layer) {
      const current = nodes[index].numbers
      for (let i = 0; i < current.length; i++) {
        for (let j = 0; j < current.length; j++) {
          if (i === j) continue
          const a = current[i], b = current[j]
          // Commutative operations once per unordered pair; subtraction and division only larger-first.
          for (const op of OPERATORS) {
            if ((op === '+' || op === '*') && i > j) continue
            if ((op === '-' || op === '/') && a < b) continue
            const result = apply(a, op, b)
            if (result === null) continue
            const rest = current.filter((_, k) => k !== i && k !== j)
            rest.push(result)
            rest.sort((x, y) => x - y)
            const key = keyOf(rest)
            if (seen.has(key)) continue
            seen.add(key)
            nodes.push({ numbers: rest, parent: index, step: { a, op, b, result } })
            if (result === target) return { depth, steps: pathTo(nodes, nodes.length - 1) }
            nextLayer.push(nodes.length - 1)
          }
        }
      }
    }
    layer = nextLayer
  }
  return null
}

function pathTo(nodes: Node[], index: number): Step[] {
  const steps: Step[] = []
  for (let at = index; at > 0; at = nodes[at].parent) steps.push(nodes[at].step as Step)
  return steps.reverse()
}

export interface Puzzle { numbers: number[]; target: number; /** Fewest operations any solution needs. */ depth: number; solution: Step[] }
export interface PuzzleParams { numbers: number; targetMax: number; minDepth: number; bigNumbers: number }

const BIG = [10, 25, 50, 75, 100]
const TARGET_MIN = 10
const MAX_ATTEMPTS = 40

function pickNumbers(rng: Rng, params: PuzzleParams): number[] {
  const big = Math.min(params.bigNumbers, params.numbers)
  const small = Array.from({ length: params.numbers - big }, () => rng.int(1, 9))
  return rng.shuffle([...small, ...rng.shuffle(BIG).slice(0, big)])
}

/** A random target built by really combining some of the numbers, so a solution is guaranteed to exist. */
function reachableTarget(rng: Rng, numbers: number[], uses: number): number | null {
  let pool = rng.shuffle(numbers).slice(0, uses)
  while (pool.length > 1) {
    const options: Array<{ i: number; j: number; op: Operator; value: number }> = []
    for (let i = 0; i < pool.length; i++) for (let j = 0; j < pool.length; j++) {
      if (i === j) continue
      for (const op of OPERATORS) {
        const value = apply(pool[i], op, pool[j])
        if (value !== null) options.push({ i, j, op, value })
      }
    }
    if (!options.length) return null
    const pick = rng.pick(options)
    pool = [...pool.filter((_, k) => k !== pick.i && k !== pick.j), pick.value]
  }
  return pool[0]
}

/**
 * One puzzle whose shortest solution needs at least `minDepth` operations, when one can be found in a bounded number of tries;
 * otherwise the hardest puzzle found (its true depth is recorded either way).
 */
export function generatePuzzle(rng: Rng, params: PuzzleParams): Puzzle {
  let best: Puzzle | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const numbers = pickNumbers(rng, params)
    const uses = Math.min(numbers.length, Math.max(params.minDepth + 1, 2) + rng.int(0, 1))
    const target = reachableTarget(rng, numbers, uses)
    if (target === null || target < TARGET_MIN || target > params.targetMax || numbers.includes(target)) continue
    // Is there a shorter way than asked for? (Cheap when there is: the search stops at the first hit.)
    const shorter = params.minDepth > 1 ? solve(numbers, target, params.minDepth - 1) : null
    if (shorter) {
      if (!best || shorter.depth > best.depth) best = { numbers, target, depth: shorter.depth, solution: shorter.steps }
      continue
    }
    const solution = solve(numbers, target)
    if (solution) return { numbers, target, depth: solution.depth, solution: solution.steps }
  }
  if (best) return best
  // Always possible: two small numbers and their sum is a valid (depth 1) puzzle only above TARGET_MIN, so build one that is.
  const numbers = [rng.int(4, 9), rng.int(4, 9), rng.int(2, 5), rng.int(2, 5)].slice(0, Math.max(2, params.numbers))
  const target = numbers[0] * numbers[1] + numbers[2]
  const solution = solve(numbers, target) as Solution
  return { numbers, target, depth: solution.depth, solution: solution.steps }
}

export interface GenerateArgs { params: Record<string, number>; seed: number; count: number }

/** The worker entry point and the inline fallback: a whole puzzle set for a block. */
export function generatePuzzles({ params, seed, count }: GenerateArgs): Puzzle[] {
  const rng = createRng(seed)
  const spec: PuzzleParams = {
    numbers: Math.round(params.numbers), targetMax: Math.round(params.targetMax), minDepth: Math.round(params.minDepth), bigNumbers: Math.round(params.bigNumbers),
  }
  return Array.from({ length: count }, () => generatePuzzle(rng, spec))
}
