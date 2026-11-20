import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { MAKE_TARGET_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { MAIN_THREAD_BUDGET_MS, createInlineHost, createWorkerHost, installWorkerRuntime, type WorkerLike } from '../../engine/generatorHost'
import { createMakeTargetEngine, puzzleScore, summariseMakeTarget, type MtResponse, type MtTrial } from './engine'
import { buildPuzzles } from './host'
import { apply, generatePuzzle, generatePuzzles, solve, type Operator, type Puzzle, type Step } from './solver'

const OPS: Operator[] = ['+', '-', '*', '/']

/** An independent exhaustive search with no memo and no pruning beyond the game's rules: the fewest operations to make `target`. */
function bruteMinDepth(numbers: number[], target: number): number | null {
  let best: number | null = null
  const go = (pool: number[], depth: number) => {
    if (pool.includes(target)) { if (best === null || depth < best) best = depth; return }
    if (pool.length < 2 || (best !== null && depth + 1 >= best)) return
    for (let i = 0; i < pool.length; i++) for (let j = 0; j < pool.length; j++) {
      if (i === j) continue
      for (const op of OPS) {
        const value = apply(pool[i], op, pool[j])
        if (value !== null) go([...pool.filter((_, k) => k !== i && k !== j), value], depth + 1)
      }
    }
  }
  go(numbers, 0)
  return best
}
/** Replay a solution step by step against the rules and the given numbers. */
function replay(numbers: number[], steps: Step[]): number[] {
  let pool = [...numbers]
  for (const step of steps) {
    const ai = pool.indexOf(step.a); expect(ai, `${step.a} available`).toBeGreaterThanOrEqual(0)
    pool.splice(ai, 1)
    const bi = pool.indexOf(step.b); expect(bi, `${step.b} available`).toBeGreaterThanOrEqual(0)
    pool.splice(bi, 1)
    expect(apply(step.a, step.op, step.b)).toBe(step.result)
    pool.push(step.result)
  }
  return pool
}

describe('Make Target rules', () => {
  it('results must be positive whole numbers; division must be exact; x1 and /1 are refused', () => {
    expect(apply(6, '+', 4)).toBe(10); expect(apply(6, '-', 4)).toBe(2); expect(apply(6, '*', 4)).toBe(24); expect(apply(8, '/', 4)).toBe(2)
    expect(apply(4, '-', 6)).toBeNull(); expect(apply(4, '-', 4)).toBeNull(); expect(apply(7, '/', 2)).toBeNull(); expect(apply(6, '/', 1)).toBeNull(); expect(apply(6, '*', 1)).toBeNull(); expect(apply(1, '*', 6)).toBeNull()
  })
})

describe('Make Target solver', () => {
  it('matches an independent brute-force search on 300 random small puzzles (reachable and unreachable targets)', () => {
    const rng = createRng(21)
    let reachable = 0, unreachable = 0
    for (let i = 0; i < 300; i++) {
      const count = rng.int(3, 5)
      const numbers = Array.from({ length: count }, () => rng.int(1, 12))
      const target = rng.int(2, 150)
      const brute = bruteMinDepth(numbers, target)
      const found = solve(numbers, target)
      expect(found === null ? null : found.depth, `${numbers} -> ${target}`).toBe(brute)
      if (found) {
        reachable += 1
        expect(replay(numbers, found.steps)).toContain(target)
        expect(found.steps).toHaveLength(found.depth)
      } else unreachable += 1
    }
    expect(reachable).toBeGreaterThan(80); expect(unreachable).toBeGreaterThan(20)
  })
  it('known cases: the classic 100 from 25, 4, 2, 6 needs three steps; a number already on the board is depth 0', () => {
    expect(solve([25, 4, 2, 6], 100)!.depth).toBe(1)
    expect(solve([6, 3, 2], 36)!.depth).toBe(2) // (6 + ... ) 6 x 3 = 18, x 2 = 36
    expect(solve([5, 5, 5], 7)).toBeNull() // no way to 7 from 5, 5, 5
    expect(solve([3, 8], 8)).toEqual({ depth: 0, steps: [] })
  })
  it('a depth limit stops the search: a target that needs three steps is not found within two', () => {
    const numbers = [2, 3, 5, 7]
    const target = Array.from({ length: 190 }, (_, i) => i + 10).find(t => solve(numbers, t)?.depth === 3)!
    expect(target).toBeDefined()
    expect(solve(numbers, target, 2)).toBeNull()
    expect(solve(numbers, target, 3)!.depth).toBe(3)
  })
})

describe('Make Target generator', () => {
  const levels = [1, 5, 8, 10, 15, 18, 20]
  it('is deterministic for a seed', () => {
    const params = paramsAt(MAKE_TARGET_PARAMS, 12)
    expect(generatePuzzles({ params, seed: 5, count: 8 })).toEqual(generatePuzzles({ params, seed: 5, count: 8 }))
    expect(generatePuzzles({ params, seed: 5, count: 8 })).not.toEqual(generatePuzzles({ params, seed: 6, count: 8 }))
  })
  it.each(levels)('level %i: every puzzle is solvable, its recorded depth is the true minimum, and the target is in range', level => {
    const params = paramsAt(MAKE_TARGET_PARAMS, level)
    for (const seed of [1, 2, 3]) {
      for (const puzzle of generatePuzzles({ params, seed, count: 8 })) {
        expect(puzzle.numbers).toHaveLength(Math.round(params.numbers))
        expect(puzzle.target).toBeGreaterThanOrEqual(10); expect(puzzle.target).toBeLessThanOrEqual(params.targetMax)
        expect(puzzle.numbers).not.toContain(puzzle.target)
        const proof = solve(puzzle.numbers, puzzle.target)!
        expect(proof, JSON.stringify(puzzle)).not.toBeNull()
        expect(puzzle.depth).toBe(proof.depth)
        expect(replay(puzzle.numbers, puzzle.solution)).toContain(puzzle.target)
        expect(puzzle.solution).toHaveLength(puzzle.depth)
      }
    }
  })
  it('asks for a minimum number of operations that rises with the level, and gets it for nearly every puzzle', () => {
    const meanDepth = (level: number) => {
      const set = [1, 2, 3, 4].flatMap(seed => generatePuzzles({ params: paramsAt(MAKE_TARGET_PARAMS, level), seed, count: 8 }))
      return { mean: set.reduce((s, p) => s + p.depth, 0) / set.length, meets: set.filter(p => p.depth >= Math.round(paramsAt(MAKE_TARGET_PARAMS, level).minDepth)).length / set.length }
    }
    const l1 = meanDepth(1), l10 = meanDepth(10), l20 = meanDepth(20)
    expect(l1.mean).toBeLessThan(l10.mean + 0.01); expect(l10.mean).toBeLessThan(l20.mean)
    // Level 20 asks for 5 operations from 6 numbers: nearly every target is reachable in 4, so only some puzzles meet it. The true depth is recorded either way.
    expect(l1.meets).toBeGreaterThan(0.95); expect(l10.meets).toBeGreaterThan(0.9); expect(l20.meets).toBeGreaterThan(0.3); expect(l20.mean).toBeGreaterThanOrEqual(4)
  })
  it('big numbers (10, 25, 50, 75, 100) appear from level 8 and not before', () => {
    const big = (level: number) => generatePuzzles({ params: paramsAt(MAKE_TARGET_PARAMS, level), seed: 2, count: 8 }).flatMap(p => p.numbers).filter(n => n >= 10)
    expect(big(5)).toHaveLength(0); expect(big(10).length).toBeGreaterThan(0)
  })
  it('builds a puzzle even for a hopeless request (the fallback is always valid)', () => {
    const puzzle = generatePuzzle(createRng(1), { numbers: 4, targetMax: 11, minDepth: 5, bigNumbers: 0 })
    expect(solve(puzzle.numbers, puzzle.target)).not.toBeNull()
  })
  it('worst-case generation of a whole puzzle set at level 20 is bounded (it runs in a Worker, not on the main thread)', () => {
    const t = performance.now()
    generatePuzzles({ params: paramsAt(MAKE_TARGET_PARAMS, 20), seed: 9, count: 8 })
    const ms = performance.now() - t
    expect(ms).toBeLessThan(4000)
    // One puzzle is far over the 8 ms main-thread budget, which is exactly why the work is moved off the main thread.
    expect(MAIN_THREAD_BUDGET_MS).toBe(8)
  })
})

describe('Make Target host', () => {
  it('runs the generator through a worker protocol and gets the same puzzles as running it inline', async () => {
    const args = { params: paramsAt(MAKE_TARGET_PARAMS, 10), seed: 4, count: 4 }
    // A worker double: a message in, the runtime answers, the host resolves.
    const listeners: Array<(event: { data: unknown }) => void> = []
    const scope = { addEventListener: (_t: 'message', l: (event: { data: never }) => void) => void listeners.push(l as never), postMessage: (m: unknown) => void host_listeners.forEach(l => l({ data: m as never })) }
    const host_listeners: Array<(event: { data: never }) => void> = []
    installWorkerRuntime({ makeTarget: generatePuzzles as never }, scope as never)
    const worker: WorkerLike = {
      postMessage: message => listeners.forEach(l => l({ data: message })),
      addEventListener: ((type: string, l: (event: never) => void) => { if (type === 'message') host_listeners.push(l) }) as WorkerLike['addEventListener'],
      terminate: () => undefined,
    }
    const viaWorker = await createWorkerHost(worker).run<Puzzle[]>('makeTarget', args)
    const inline = await createInlineHost({ makeTarget: generatePuzzles as never }).run<Puzzle[]>('makeTarget', args)
    expect(viaWorker).toEqual(inline)
    expect(viaWorker).toEqual(generatePuzzles(args))
  })
  it('buildPuzzles falls back to the calling thread when there is no Worker', async () => {
    const args = { params: paramsAt(MAKE_TARGET_PARAMS, 3), seed: 8, count: 8 }
    expect(typeof Worker).toBe('undefined') // plain node
    expect(await buildPuzzles(args)).toEqual(generatePuzzles(args))
  })
})

describe('Make Target engine and scoring', () => {
  const params = (level: number) => paramsAt(MAKE_TARGET_PARAMS, level)
  const play = (level: number, answer: (t: MtTrial) => MtResponse | 'timeout', rt = 20000) => {
    const engine = createMakeTargetEngine(params(level), createRng(3))
    const log: TrialLogEntry<MtTrial, MtResponse>[] = []
    for (let t = engine.next(); t !== null; t = engine.next()) {
      const response = answer(t)
      log.push({ n: log.length + 1, trial: t, response, rtMs: response === 'timeout' ? null : rt, outcome: engine.evaluate(t, response, rt), atMs: log.length })
    }
    return log
  }
  const exact = (t: MtTrial): MtResponse => ({ value: t.puzzle.target, steps: t.puzzle.depth })
  it('deals eight puzzles, counted when judged, in a fixed order', () => {
    const log = play(5, exact)
    expect(log).toHaveLength(ROUND_COUNTS.make_target)
    expect(log.map(e => e.trial.puzzle)).toEqual(play(5, exact).map(e => e.trial.puzzle))
    const engine = createMakeTargetEngine(params(5), createRng(3))
    for (let i = 0; i < 20; i++) engine.next() // handed out, never judged
    expect(engine.next()).not.toBeNull()
  })
  it('uses a ready-made puzzle set when given one (the one the Worker built)', () => {
    const set = generatePuzzles({ params: params(5), seed: 77, count: 8 })
    const engine = createMakeTargetEngine(params(5), createRng(1), set)
    expect((engine.next() as MtTrial).puzzle).toBe(set[0])
  })
  it('exact = 0.8 + 0.2 x speed, within 2 of the target (levels 1-6 only) = 0.5, anything else 0', () => {
    const log = play(5, t => ({ value: t.puzzle.target + 1, steps: 1 }))
    expect(log[0].outcome.tag).toBe('near'); expect(puzzleScore(log[0], 11000)).toBe(0.5)
    const high = play(10, t => ({ value: t.puzzle.target + 1, steps: 1 }))
    expect(high[0].outcome.tag).toBe('wrong'); expect(puzzleScore(high[0], 9000)).toBe(0)
    const fast = play(5, exact, 11000)[0], slow = play(5, exact, 55000)[0], mid = play(5, exact, 33000)[0]
    expect(puzzleScore(fast, 11000)).toBeCloseTo(1, 6); expect(puzzleScore(slow, 11000)).toBeCloseTo(0.8, 6); expect(puzzleScore(mid, 11000)).toBeCloseTo(0.9, 6)
    expect(puzzleScore(play(5, () => 'timeout')[0], 11000)).toBe(0)
  })
  it('a perfect player at RT_fast scores 100; solving all eight slowly scores 80; half credit alone is 50 at most', () => {
    expect(summariseMakeTarget(play(5, exact, 11000), 5).score).toBe(100)
    expect(summariseMakeTarget(play(5, exact, 55000), 5).score).toBe(80)
    expect(summariseMakeTarget(play(5, t => ({ value: t.puzzle.target + 2, steps: 1 })), 5).score).toBe(50)
    expect(summariseMakeTarget(play(5, () => 'timeout'), 5).score).toBe(0)
  })
  it('records solved ratio, median solve time, depth and the review shows the solver\'s solution', () => {
    let n = 0
    const log = play(5, t => (++n % 2 ? exact(t) : 'timeout'), 15000)
    const summary = summariseMakeTarget(log, 5)
    expect(summary.stats).toMatchObject({ puzzles: 8, solved: 4, solved_pct: 50, timeouts: 4, median_solve_ms: 15000 })
    expect(summary.stats!.avg_depth_solved).toBeGreaterThan(0)
    expect(summary.review![0].correctAnswer).toMatch(/=/)
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
  })
})
