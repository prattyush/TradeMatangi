import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { EQUATION_DROP_PARAMS } from '../../config/difficulty.brain'
import { BLOCK_MS, createDropSim, createEquationDropEngine, EARLY_DEATH_MS, LIVES, SPAWN_SLACK, summariseEquationDrop, weightedClears, WRONG_LOCK_MS, type DropSim, type EdResponse, type EdTrial } from './engine'

type Policy = (sim: DropSim, params: Record<string, number>, rng: ReturnType<typeof createRng>) => void
/** Run a whole block on a virtual clock with 20 ms steps. */
function run(level: number, seed: number, policy: Policy): { sim: DropSim; log: TrialLogEntry<EdTrial, EdResponse>[]; params: Record<string, number> } {
  const params = paramsAt(EQUATION_DROP_PARAMS, level)
  const sim = createDropSim(params, createRng(seed))
  const rng = createRng(seed + 99)
  for (let t = 0; t < BLOCK_MS + 2000 && !sim.over; t += 20) { sim.step(20); policy(sim, params, rng) }
  return { sim, log: sim.log, params }
}
/** Types the oldest equation's answer once it has been on screen for RT_fast. */
const perfect: Policy = (sim, params) => {
  const ready = sim.drops.filter(d => sim.elapsedMs - d.trial.spawnMs >= params.rtFast)
  if (ready.length && !sim.locked) sim.submit(ready[0].trial.answer)
}
let nextAt = 0
const random: Policy = (sim, _p, rng) => { if (sim.elapsedMs < 25) nextAt = 0; if (sim.elapsedMs >= nextAt) { sim.submit(rng.int(0, 60)); nextAt = sim.elapsedMs + 1000 } }
const idle: Policy = () => undefined
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

describe('Equation Drop simulation', () => {
  it('is deterministic for a seed', () => {
    expect(run(8, 4, perfect).log).toEqual(run(8, 4, perfect).log)
    expect(run(8, 4, perfect).log).not.toEqual(run(8, 5, perfect).log)
  })
  it('a drop falls from y 0 to 1 over its fall time and costs a life when it lands; three lives end the block', () => {
    const { sim, log } = run(1, 1, idle)
    expect(sim.over).toBe(true)
    expect(sim.lives).toBe(0)
    expect(log.filter(e => e.outcome.tag === 'landed')).toHaveLength(LIVES)
    expect(sim.elapsedMs).toBeLessThan(BLOCK_MS)
    const params = paramsAt(EQUATION_DROP_PARAMS, 1)
    const probe = createDropSim(params, createRng(1))
    while (probe.drops.length === 0) probe.step(20)
    const drop = probe.drops[0]
    expect(drop.y).toBeLessThan(0.05)
    for (let i = 0; i < 100; i++) probe.step(20)
    expect(probe.drops[0].y).toBeCloseTo((100 * 20 + 20) / drop.trial.fallMs, 1)
  })
  it('fall time shortens through the block and never spawns faster than a perfect player can clear', () => {
    const params = paramsAt(EQUATION_DROP_PARAMS, 10)
    const { log } = run(10, 2, perfect)
    const drops = log.filter(e => e.trial.kind === 'drop').map(e => e.trial)
    expect(drops[0].fallMs).toBeGreaterThan(drops[drops.length - 1].fallMs)
    expect(drops[0].fallMs).toBeLessThanOrEqual(params.fallStartMs); expect(drops[drops.length - 1].fallMs).toBeGreaterThanOrEqual(params.fallEndMs)
    const spawns = drops.map(d => d.spawnMs).sort((a, b) => a - b)
    for (let i = 1; i < spawns.length; i++) expect(spawns[i] - spawns[i - 1]).toBeGreaterThanOrEqual(params.rtFast * SPAWN_SLACK - 21)
  })
  it('never has more equations on screen than the level allows (2 at level 1, 6 at level 20)', () => {
    for (const [level, cap] of [[1, 2], [10, 4], [20, 6]] as const) {
      let most = 0
      run(level, 3, (sim, p, rng) => { most = Math.max(most, sim.drops.length); random(sim, p, rng) })
      expect(most).toBeLessThanOrEqual(cap)
    }
  })
  it('typing a value clears EVERY falling equation with that answer and the combo builds', () => {
    const params = { ...paramsAt(EQUATION_DROP_PARAMS, 10), maxDrops: 6 }
    // Find a moment with two equations that share an answer by retrying seeds.
    let cleared = 0
    for (let seed = 1; seed < 400 && cleared < 2; seed++) {
      const sim = createDropSim(params, createRng(seed))
      for (let t = 0; t < 20000 && !sim.over; t += 20) {
        sim.step(20)
        const seen = new Map<number, number>()
        for (const d of sim.drops) seen.set(d.trial.answer, (seen.get(d.trial.answer) ?? 0) + 1)
        const dup = [...seen].find(([, n]) => n >= 2)
        if (dup) { cleared = sim.submit(dup[0]).length; expect(sim.drops.some(d => d.trial.answer === dup[0])).toBe(false); expect(sim.combo).toBe(cleared); break }
      }
    }
    expect(cleared).toBeGreaterThanOrEqual(2)
  })
  it('a wrong answer breaks the combo, is logged, and locks typing for 300 ms', () => {
    const params = paramsAt(EQUATION_DROP_PARAMS, 5)
    const sim = createDropSim(params, createRng(7))
    while (sim.drops.length === 0) sim.step(20)
    sim.submit(sim.drops[0].trial.answer)
    expect(sim.combo).toBe(1)
    while (sim.drops.length === 0) sim.step(20)
    const answers = new Set(sim.drops.map(d => d.trial.answer))
    let wrong = 1; while (answers.has(wrong)) wrong += 1
    expect(sim.submit(wrong)).toEqual([])
    expect(sim.combo).toBe(0)
    expect(sim.locked).toBe(true)
    expect(sim.submit(sim.drops[0].trial.answer)).toEqual([]) // locked
    for (let i = 0; i < WRONG_LOCK_MS / 20 + 1; i++) sim.step(20)
    expect(sim.locked).toBe(false)
    expect(sim.log[sim.log.length - 1]).toMatchObject({ trial: { kind: 'typed', answer: wrong }, outcome: { correct: false, tag: 'wrong' } })
  })
  it('from level 12 about a third of the equations are reversed ("? + 9 = 23"); the answer is the missing number', () => {
    const early = run(11, 5, perfect).log.filter(e => e.trial.kind === 'drop')
    expect(early.every(e => !e.trial.reverse)).toBe(true)
    const late = run(12, 5, perfect).log.filter(e => e.trial.kind === 'drop')
    const reversed = late.filter(e => e.trial.reverse)
    expect(reversed.length / late.length).toBeGreaterThan(0.1)
    for (const e of reversed) {
      expect(e.trial.text).toMatch(/\?/)
      const [left, right] = e.trial.text.replace('?', String(e.trial.answer)).split(' = ')
      const value = Number(new Function(`return (${left.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-')})`)())
      expect(value).toBe(Number(right))
    }
  })
  it('every equation answer is a whole number of at least 0', () => {
    for (const e of run(20, 6, perfect).log.filter(e => e.trial.kind === 'drop')) { expect(Number.isInteger(e.trial.answer)).toBe(true); expect(e.trial.answer).toBeGreaterThanOrEqual(0) }
  })
  it('the generic engine gives drops one after another (used by the registry)', () => {
    const engine = createEquationDropEngine(paramsAt(EQUATION_DROP_PARAMS, 5), createRng(1))
    const t = engine.next() as EdTrial
    expect(engine.evaluate(t, t.answer, 1500)).toMatchObject({ correct: true })
    expect(engine.evaluate(t, 'timeout', t.fallMs)).toMatchObject({ correct: false, tag: 'landed' })
  })
})

describe('Equation Drop scoring', () => {
  it('a perfect player scores 95 or more at every level and never loses a life', () => {
    for (let level = 1; level <= 20; level++) {
      const { log } = run(level, 11, perfect)
      const summary = summariseEquationDrop(log, level)
      expect(summary.score, `level ${level}`).toBeGreaterThanOrEqual(95)
      expect(summary.stats).toMatchObject({ lives_lost: 0, died: 0, wrong_entries: 0, typed_accuracy_pct: 100 })
    }
  })
  it('an idle player and a random typist score nothing (and are capped at 70 anyway when they die early)', () => {
    for (const level of [1, 10, 20]) {
      expect(summariseEquationDrop(run(level, 3, idle).log, level).score).toBe(0)
      const scores = Array.from({ length: 30 }, (_, seed) => summariseEquationDrop(run(level, seed + 1, random).log, level).score)
      expect(mean(scores)).toBeLessThanOrEqual(10)
      expect(Math.max(...scores)).toBeLessThanOrEqual(30)
    }
  })
  it('the weighted total is 1 + 0.1 x min(combo, 5) per clear, minus 0.25 per wrong entry', () => {
    const clear = (n: number, combo: number): TrialLogEntry<EdTrial, EdResponse> =>
      ({ n, trial: { kind: 'drop', id: n, text: '1 + 1', answer: 2, reverse: false, spawnMs: 0, fallMs: 5000, lane: 0.5, combo }, response: 2, rtMs: 1500, outcome: { correct: true, tag: 'cleared' }, atMs: n * 100 })
    const miss: TrialLogEntry<EdTrial, EdResponse> = { n: 9, trial: { kind: 'typed', id: -1, text: '(typed)', answer: 9, reverse: false, spawnMs: 0, fallMs: 0, lane: 0 }, response: 9, rtMs: null, outcome: { correct: false, tag: 'wrong' }, atMs: 900 }
    const log = [clear(1, 1), clear(2, 2), clear(3, 3), clear(4, 4), clear(5, 5), clear(6, 6), miss]
    // 1.1 + 1.2 + 1.3 + 1.4 + 1.5 + 1.5 - 0.25
    expect(weightedClears(log)).toBeCloseTo(7.75, 6)
    expect(weightedClears([miss, miss])).toBe(0)
  })
  it('losing all three lives before 60 s caps the score at 70; losing them later does not', () => {
    const clear = (n: number): TrialLogEntry<EdTrial, EdResponse> =>
      ({ n, trial: { kind: 'drop', id: n, text: '1 + 1', answer: 2, reverse: false, spawnMs: 0, fallMs: 5000, lane: 0.5, combo: 5 }, response: 2, rtMs: 1500, outcome: { correct: true, tag: 'cleared' }, atMs: n * 100 })
    const landed = (n: number, atMs: number): TrialLogEntry<EdTrial, EdResponse> =>
      ({ n, trial: { kind: 'drop', id: n, text: '1 + 1', answer: 2, reverse: false, spawnMs: 0, fallMs: 5000, lane: 0.5 }, response: 'timeout', rtMs: null, outcome: { correct: false, tag: 'landed' }, atMs })
    const clears = Array.from({ length: 40 }, (_, i) => clear(i + 1))
    expect(summariseEquationDrop(clears, 1).score).toBe(100)
    const early = summariseEquationDrop([...clears, landed(41, 20000), landed(42, 25000), landed(43, 30000)], 1)
    expect(early.score).toBe(70); expect(early.stats).toMatchObject({ died: 1, lives_lost: 3, survived_s: 30 })
    expect(summariseEquationDrop([...clears, landed(41, 20000), landed(42, 25000)], 1).score).toBe(100) // two lives lost: not dead
    expect(summariseEquationDrop([...clears, landed(41, 50000), landed(42, 55000), landed(43, 62000)], 1).score).toBe(100) // died after 60 s
  })
  it('review rows say what fell and what was typed', () => {
    const summary = summariseEquationDrop(run(5, 2, perfect).log, 5)
    expect(summary.review!.length).toBeGreaterThan(20)
    expect(summary.review![0]).toMatchObject({ correct: true })
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
  })
})
