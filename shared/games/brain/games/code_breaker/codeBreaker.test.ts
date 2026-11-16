import { describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { CODE_BREAKER_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import { codeBreakerSim, codeScore, createCodeBreakerEngine, summariseCodeBreaker, type CbResponse, type CbTrial } from './engine'
import { allCodes, feedback, generateCode, generateCodes, isConsistent, openingGuess, solverGuesses, type CodePuzzle } from './solver'

const params = (level: number) => paramsAt(CODE_BREAKER_PARAMS, level)
const LEVELS = [1, 5, 9, 10, 15, 16, 20]

describe('Code Breaker feedback', () => {
  it('counts exact and misplaced symbols the way Mastermind does (each symbol once)', () => {
    expect(feedback([1, 2, 3, 4], [1, 2, 3, 4])).toEqual({ exact: 4, misplaced: 0 })
    expect(feedback([1, 2, 3, 4], [4, 3, 2, 1])).toEqual({ exact: 0, misplaced: 4 })
    expect(feedback([1, 2, 3, 4], [1, 3, 2, 5])).toEqual({ exact: 1, misplaced: 2 })
    expect(feedback([1, 1, 2, 3], [1, 2, 1, 1])).toEqual({ exact: 1, misplaced: 2 }) // the spare 1 of the guess finds nothing left
    expect(feedback([0, 0, 1, 1], [1, 1, 0, 0])).toEqual({ exact: 0, misplaced: 4 })
    expect(feedback([5, 5, 5], [5, 5, 5])).toEqual({ exact: 3, misplaced: 0 })
    expect(feedback([1, 2, 3], [4, 4, 4])).toEqual({ exact: 0, misplaced: 0 })
  })
  it('is symmetric: the feedback of a guess against a code is the code against the guess', () => {
    const rng = createRng(4)
    for (let i = 0; i < 300; i++) {
      const a = Array.from({ length: 4 }, () => rng.int(0, 5)), b = Array.from({ length: 4 }, () => rng.int(0, 5))
      expect(feedback(a, b)).toEqual(feedback(b, a))
    }
  })
})

describe('Code Breaker solver and codes', () => {
  it('enumerates every code: S^L with repeats, S!/(S-L)! without', () => {
    expect(allCodes(3, 4, true)).toHaveLength(64); expect(allCodes(3, 4, false)).toHaveLength(24); expect(allCodes(4, 6, false)).toHaveLength(360)
    expect(allCodes(3, 4, false).every(code => new Set(code).size === 3)).toBe(true)
  })
  it('the simple solver always finds the code, and its guesses stay consistent with all earlier feedback', () => {
    for (const [length, symbols, repeats] of [[3, 4, false], [4, 6, false], [4, 6, true], [5, 8, true]] as const) {
      const rng = createRng(length * 10 + symbols)
      for (let i = 0; i < 12; i++) {
        const secret = generateCode(rng, { length, symbols, repeats: repeats ? 1 : 0, hidden: 0, guesses: 10 }).secret
        const guesses = solverGuesses(secret, symbols, repeats)
        expect(guesses[guesses.length - 1]).toEqual(secret)
        guesses.forEach((guess, k) => expect(isConsistent(guess, guesses.slice(0, k), secret, null)).toBe(true))
        expect(guesses.length).toBeLessThanOrEqual(10)
      }
    }
  })
  it('opens with 0 1 2 .. without repeats and 0 0 1 1 .. with them', () => {
    expect(openingGuess(4, false)).toEqual([0, 1, 2, 3]); expect(openingGuess(5, true)).toEqual([0, 0, 1, 1, 2])
  })
  it('is deterministic for a seed; codes have the right length and symbols, and repeat only when allowed', () => {
    const args = (level: number, seed: number) => ({ params: params(level), seed, count: 6 })
    expect(generateCodes(args(10, 3))).toEqual(generateCodes(args(10, 3)))
    for (const level of LEVELS) for (const seed of [1, 2, 3]) for (const code of generateCodes(args(level, seed))) {
      expect(code.secret).toHaveLength(Math.round(params(level).length))
      expect(code.secret.every(s => s >= 0 && s < Math.round(params(level).symbols))).toBe(true)
      if (params(level).repeats < 1) expect(new Set(code.secret).size).toBe(code.secret.length)
      expect(code.par).toBeGreaterThanOrEqual(1)
      // the careful solver always has a guess to spare inside the limit
      expect(code.par).toBeLessThanOrEqual(Math.round(params(level).guesses) - 1)
    }
  })
  it('par is the number of guesses the simple solver needs on that very code', () => {
    for (const level of [10, 16]) for (const code of generateCodes({ params: params(level), seed: 5, count: 6 })) expect(solverGuesses(code.secret, Math.round(params(level).symbols), true, 30, code.hidden)).toHaveLength(code.par)
  })
  it('the code gets longer and the alphabet wider with the level; the guess limit shrinks', () => {
    expect(params(1)).toMatchObject({ length: 3, symbols: 5, guesses: 10 }); expect(params(20)).toMatchObject({ length: 5, symbols: 8, guesses: 8 })
    expect(params(9).repeats).toBe(0); expect(params(10).repeats).toBe(1)
  })
  it('a hidden feedback value appears once per code from level 16 only', () => {
    expect(generateCodes({ params: params(15), seed: 1, count: 6 }).every(c => c.hidden === null)).toBe(true)
    const hidden = generateCodes({ params: params(16), seed: 1, count: 6 })
    expect(hidden.every(c => c.hidden !== null && c.hidden.guess >= 1 && c.hidden.guess <= 3 && (c.hidden.value === 'exact' || c.hidden.value === 'misplaced'))).toBe(true)
  })
  it('worst-case generation of six codes at level 20 is quick', () => {
    const t = performance.now(); generateCodes({ params: params(20), seed: 3, count: 6 }); expect(performance.now() - t).toBeLessThan(3000)
  })
})

describe('Code Breaker consistency', () => {
  it('a guess is consistent when it could still be the code given the feedback shown so far', () => {
    const secret = [0, 1, 2, 3]
    expect(isConsistent([0, 1, 3, 2], [[0, 1, 2, 3]], secret, null)).toBe(false) // the first guess was exact: another code scores differently
    expect(isConsistent([0, 1, 2, 3], [[0, 1, 3, 2]], secret, null)).toBe(true)
    expect(isConsistent([3, 2, 1, 0], [[0, 1, 2, 3]], secret, null)).toBe(false)
  })
  it('a hidden value is skipped: the player could not see it', () => {
    const secret = [0, 1, 2, 3]
    // feedback of [0,1,3,2] is 2 exact, 2 misplaced; a candidate with 2 exact but 1 misplaced is wrong only on the hidden value
    expect(isConsistent([0, 1, 4, 4], [[0, 1, 3, 2]], secret, null)).toBe(false)
    expect(isConsistent([0, 1, 4, 4], [[0, 1, 3, 2]], secret, { guess: 0, value: 'misplaced' })).toBe(true)
  })
})

describe('Code Breaker engine and scoring', () => {
  const play = (level: number, answer: (t: CbTrial) => CbResponse | 'timeout') => {
    const engine = createCodeBreakerEngine(params(level), createRng(3))
    const log: TrialLogEntry<CbTrial, CbResponse>[] = []
    for (let t = engine.next(); t !== null; t = engine.next()) {
      const response = answer(t)
      log.push({ n: log.length + 1, trial: t, response, rtMs: response === 'timeout' ? null : 30000, outcome: engine.evaluate(t, response, 30000), atMs: log.length })
    }
    return log
  }
  const solver = (t: CbTrial): CbResponse => ({ guesses: solverGuesses(t.code.secret, t.symbols, t.repeats, 30, t.code.hidden), solved: true })
  const padded = (t: CbTrial, extra: number): CbResponse => {
    const guesses = solverGuesses(t.code.secret, t.symbols, t.repeats, 30, t.code.hidden)
    const wrong = guesses[0].map(s => (s + 1) % t.symbols)
    return { guesses: [...Array.from({ length: extra }, () => wrong), ...guesses], solved: true }
  }
  it('deals six codes', () => { expect(play(5, solver)).toHaveLength(ROUND_COUNTS.code_breaker) })
  it('a solver that reaches par scores 100, and its guesses are all consistent', () => {
    const log = play(10, solver)
    expect(log.every(entry => entry.outcome.correct)).toBe(true)
    expect(summariseCodeBreaker(log, 10).score).toBe(100)
    expect(summariseCodeBreaker(log, 10).stats).toMatchObject({ solved: 6, solve_rate_pct: 100, consistency_pct: 100 })
    expect(summariseCodeBreaker(log, 10).stats!.mean_guesses).toBe(summariseCodeBreaker(log, 10).stats!.mean_par)
  })
  it('puzzle score = (1 - (guesses - par) / par) x the consistent share of guesses, floored at 0; +0.1 only when every guess was consistent', () => {
    const [entry] = play(5, solver)
    const par = entry.trial.code.par
    expect(codeScore(entry).score).toBe(1)
    const slower = (extra: number): TrialLogEntry<CbTrial, CbResponse> => ({ ...entry, response: padded(entry.trial, extra) })
    // one wasted guess, a repeat of an opening guess that cannot be the code: it is inconsistent, so there is no bonus and the base is scaled
    const one = codeScore(slower(1))
    expect(one.consistent).toBeLessThan(one.guesses)
    expect(one.score).toBeCloseTo(Math.max(0, 1 - 1 / par) * (one.consistent / one.guesses), 6)
    expect(codeScore(slower(par)).score).toBe(0)
    expect(codeScore({ ...entry, response: { guesses: [[0, 0, 0]], solved: false } }).score).toBe(0)
    expect(codeScore({ ...entry, response: 'timeout' }).score).toBe(0)
  })
  it('the consistency bonus lifts a slightly slow but consistent solve above its base score', () => {
    const [entry] = play(5, solver)
    // A consistent route with one extra step: guess another code that is still possible, then continue.
    const secret = entry.trial.code.secret
    const first = openingGuess(entry.trial.length, false)
    const candidates = allCodes(entry.trial.length, entry.trial.symbols, false).filter(c => JSON.stringify(feedback(first, c)) === JSON.stringify(feedback(first, secret)) && JSON.stringify(c) !== JSON.stringify(first))
    if (candidates.length > 1 && JSON.stringify(secret) !== JSON.stringify(candidates[candidates.length - 1])) {
      const guesses = [first, candidates[candidates.length - 1], secret]
      const scored = codeScore({ ...entry, response: { guesses, solved: true } })
      expect(scored.consistent).toBe(3)
      const base = Math.max(0, 1 - (3 - entry.trial.code.par) / entry.trial.code.par)
      expect(scored.score).toBeCloseTo(Math.min(1, base + 0.1), 6)
    }
  })
  it('unsolved and timed-out codes score 0; guessing scores about nothing', () => {
    expect(summariseCodeBreaker(play(5, () => 'timeout'), 5).score).toBe(0)
    expect(summariseCodeBreaker(play(5, t => ({ guesses: [t.code.secret.map(s => (s + 1) % t.symbols)], solved: false })), 5).score).toBe(0)
  })
  it('reports mean guesses against par, consistency and solve rate, within the 20-key limit; review shows the code', () => {
    const summary = summariseCodeBreaker(play(5, solver), 5)
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
    expect(summary.review![0].correctAnswer).toMatch(/^\d( \d)+$/)
  })
  it('the sim solver and the sim random player behave', () => {
    const trial = play(1, solver)[0].trial
    const sim = codeBreakerSim.correct(trial) as CbResponse
    expect(sim.solved).toBe(true); expect(sim.guesses).toHaveLength(trial.code.par)
    const random = codeBreakerSim.random(trial, createRng(1)) as CbResponse
    expect(random.guesses.length).toBeLessThanOrEqual(trial.guessLimit)
  })
})
