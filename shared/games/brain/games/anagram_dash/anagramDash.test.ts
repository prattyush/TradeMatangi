import { beforeAll, describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { ANAGRAM_DASH_PARAMS } from '../../config/difficulty.brain'
import { loadWordData, type WordData } from '../../words/loader'
import { awkwardness, generateAnagrams, sortedLetters, type AnagramPuzzle } from './generator'
import { createAnagramEngine, summariseAnagramDash, targetValue, wordScore, type AdResponse, type AdTrial } from './engine'

let data: WordData
beforeAll(async () => { data = await loadWordData() })
const params = (level: number) => paramsAt(ANAGRAM_DASH_PARAMS, level)
const make = (level: number, seed = 1, count = 40): AnagramPuzzle[] => generateAnagrams(data, createRng(seed), { length: params(level).length, tier: params(level).tier, hard: params(level).hard }, count)
const LEVELS = [1, 5, 10, 15, 20]

describe('Anagram Dash generator', () => {
  it('is deterministic for a seed', () => { expect(make(10, 3)).toEqual(make(10, 3)); expect(make(10, 3)).not.toEqual(make(10, 4)) })
  it.each(LEVELS)('level %i: targets are common words of the right length and tier; every accepted answer is a valid anagram; the scramble is not a word', level => {
    const p = params(level), tiers = new Map(data.common.map(entry => [entry.word, entry.tier]))
    const puzzles = make(level, 2)
    expect(puzzles).toHaveLength(40)
    expect(new Set(puzzles.map(x => x.target)).size).toBe(40)
    for (const puzzle of puzzles) {
      expect(puzzle.target).toHaveLength(Math.round(p.length))
      expect(tiers.get(puzzle.target)).toBeLessThanOrEqual(Math.round(p.tier))
      expect(puzzle.answers).toContain(puzzle.target)
      for (const answer of puzzle.answers) { expect(data.validSet.has(answer)).toBe(true); expect(sortedLetters(answer)).toBe(sortedLetters(puzzle.letters)) }
      expect(puzzle.letters).toHaveLength(puzzle.target.length)
      expect(puzzle.answers).not.toContain(puzzle.letters)
    }
  })
  it('accepts every valid word that fits, not just the intended one ("stop" also takes "pots", "tops")', () => {
    const stop = generateAnagrams(data, createRng(1), { length: 4, tier: 3, hard: 0 }, 400).find(p => p.answers.length >= 3)!
    expect(stop.answers.length).toBeGreaterThanOrEqual(3)
    expect(new Set(stop.answers.map(sortedLetters)).size).toBe(1)
  })
  it('levels lengthen the words and move to less common tiers; awkward letters are preferred at high levels', () => {
    expect(make(1)[0].target).toHaveLength(4); expect(make(20)[0].target).toHaveLength(9)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const easy = generateAnagrams(data, createRng(5), { length: 6, tier: 2, hard: 0 }, 150)
    const hard = generateAnagrams(data, createRng(5), { length: 6, tier: 2, hard: 1 }, 150)
    expect(mean(hard.map(p => awkwardness(p.target)))).toBeGreaterThan(mean(easy.map(p => awkwardness(p.target))) + 0.03)
  })
  it('generation is quick even from the full list', () => { const t = performance.now(); make(20, 7, 80); expect(performance.now() - t).toBeLessThan(1500) })
})

describe('Anagram Dash engine and scoring', () => {
  const play = (level: number, answer: (t: AdTrial) => AdResponse | 'timeout', rt = 3000, count = 12) => {
    const engine = createAnagramEngine(params(level), createRng(3), make(level, 3, 60))
    const log: TrialLogEntry<AdTrial, AdResponse>[] = []
    for (let i = 0; i < count; i++) {
      const t = engine.next() as AdTrial
      const response = answer(t)
      log.push({ n: i + 1, trial: t, response, rtMs: response === 'timeout' ? null : rt, outcome: engine.evaluate(t, response, rt), atMs: i })
    }
    return log
  }
  const right = (t: AdTrial): AdResponse => ({ word: t.puzzle.target, hinted: false, misses: 0 })
  it('the target value follows the spec formula 0.8 x 90 / expert x (length - 2) x 0.85', () => {
    expect(targetValue(params(1))).toBe(15); expect(targetValue(params(20))).toBe(Math.round(0.8 * (90 / 16) * 7 * 0.85))
  })
  it('a word is worth (length - 2) x (0.7 + 0.3 x speed), 30% less with a hint, and nothing when skipped or wrong', () => {
    const [entry] = play(1, right, 0)
    expect(wordScore(entry)).toBeCloseTo(2, 6)
    expect(wordScore({ ...entry, rtMs: 30000 })).toBeCloseTo(1.4, 6)
    expect(wordScore({ ...entry, response: { word: entry.trial.puzzle.target, hinted: true, misses: 0 } })).toBeCloseTo(1.4, 6)
    expect(wordScore({ ...entry, response: 'skip', outcome: { correct: false, tag: 'skip' } })).toBe(0)
    expect(wordScore({ ...entry, response: { word: 'zzzz', hinted: false, misses: 0 }, outcome: { correct: false, tag: 'wrong' } })).toBe(0)
  })
  it('judges any accepted anagram right and others wrong', () => {
    const engine = createAnagramEngine(params(1), createRng(1), make(1, 3, 30))
    const t = engine.next() as AdTrial
    for (const answer of t.puzzle.answers) expect(engine.evaluate(t, { word: answer, hinted: false, misses: 0 }, 2000).correct).toBe(true)
    expect(engine.evaluate(t, { word: 'zzzz', hinted: false, misses: 0 }, 2000)).toMatchObject({ correct: false, tag: 'wrong' })
    expect(engine.evaluate(t, 'skip', 2000)).toMatchObject({ tag: 'skip' }); expect(engine.evaluate(t, 'timeout', 60000)).toMatchObject({ tag: 'timeout' })
  })
  it('a player at the pace that matches the target scores 100; a few words score proportionally; skipping everything scores 0', () => {
    expect(summariseAnagramDash(play(1, right, 3000, 20), 1).score).toBe(100)
    const few = summariseAnagramDash(play(1, right, 3000, 3), 1)
    expect(few.score).toBeGreaterThan(20); expect(few.score).toBeLessThan(60)
    expect(summariseAnagramDash(play(1, () => 'skip'), 1).score).toBe(0)
  })
  it('reports words solved, longest word, hint rate, skips, timeouts and wrong entries within 20 keys', () => {
    let n = 0
    const log = play(5, t => (n++ % 4 === 0 ? 'skip' : { word: t.puzzle.target, hinted: n % 3 === 0, misses: 2 }))
    const stats = summariseAnagramDash(log, 5).stats!
    expect(stats).toMatchObject({ words: 12, longest_word: 5, skipped: 3 })
    expect(stats.hint_rate_pct).toBeGreaterThan(0)
    expect(stats.wrong_entries).toBe(18)
    expect(Object.keys(stats).length).toBeLessThanOrEqual(20)
  })
})
