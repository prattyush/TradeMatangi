import { beforeAll, describe, expect, it } from 'vitest'
import { paramsAt } from '../../../core/difficulty'
import { createRng } from '../../../core/rng'
import type { TrialLogEntry } from '../../../core/trial'
import { LETTER_GRID_PARAMS } from '../../config/difficulty.brain'
import { loadWordData, type WordData } from '../../words/loader'
import { buildTrie } from '../../words/wordlist'
import { acceptedWords, createLetterGridEngine, gridValue, summariseLetterGrid, type LgResponse, type LgTrial } from './engine'
import { generateGrid, solveGrid, wordValue, type GridPuzzle } from './generator'

let data: WordData
beforeAll(async () => { data = await loadWordData() })
const params = (level: number) => paramsAt(LETTER_GRID_PARAMS, level)
const make = (level: number, seed = 1) => generateGrid(data, createRng(seed), { n: params(level).n, minLen: params(level).minLen, minWords: params(level).minWords })

/** An independent brute force: enumerate every simple path of the grid and look the string up in a Set. */
function brute(letters: string[], n: number, minLen: number, words: Set<string>): Set<string> {
  const found = new Set<string>()
  const go = (path: number[]) => {
    const word = path.map(i => letters[i]).join('')
    if (word.length >= minLen && words.has(word)) found.add(word)
    if (word.length >= 7) return
    const last = path[path.length - 1], row = Math.floor(last / n), col = last % n
    for (let r = Math.max(0, row - 1); r <= Math.min(n - 1, row + 1); r++) for (let c = Math.max(0, col - 1); c <= Math.min(n - 1, col + 1); c++) {
      const cell = r * n + c
      if (!path.includes(cell)) go([...path, cell])
    }
  }
  for (let i = 0; i < n * n; i++) go([i])
  return found
}

describe('Letter Grid solver', () => {
  it('finds exactly the words a brute-force path enumeration finds, each with a valid path (3x3 and 4x4, real dictionary, words up to 7 letters)', () => {
    const trie = data.trie()
    const small = new Set(data.valid.filter(w => w.length <= 7))
    const smallTrie = buildTrie([...small].sort())
    void trie
    const rng = createRng(11)
    for (const n of [3, 4]) for (let g = 0; g < 4; g++) {
      const letters = Array.from({ length: n * n }, () => 'abcdeilnorstu'[rng.int(0, 12)])
      const solved = solveGrid(smallTrie, letters, n, 3, () => false)
      const expected = brute(letters, n, 3, small)
      expect(new Set(solved.map(w => w.word))).toEqual(expected)
      for (const w of solved) {
        expect(w.path.map(i => letters[i]).join('')).toBe(w.word)
        expect(new Set(w.path).size).toBe(w.path.length)
        for (let i = 1; i < w.path.length; i++) {
          const a = w.path[i - 1], b = w.path[i]
          expect(Math.abs(Math.floor(a / n) - Math.floor(b / n)) <= 1 && Math.abs((a % n) - (b % n)) <= 1).toBe(true)
        }
      }
    }
  })
  it('never reuses a cell: a word needing the same letter twice from one cell is not found', () => {
    const trie = buildTrie(['aa', 'aaa'].sort())
    expect(solveGrid(trie, ['a', 'b', 'b', 'b'], 2, 2, () => false)).toEqual([])
    expect(solveGrid(trie, ['a', 'a', 'b', 'b'], 2, 2, () => false).map(w => w.word)).toEqual(['aa'])
  })
  it('word values by length: 3 -> 1, 4 -> 2, 5 -> 4, 6 -> 7, 7 or more -> 11', () => {
    expect([2, 3, 4, 5, 6, 7, 9].map(wordValue)).toEqual([0, 1, 2, 4, 7, 11, 11])
  })
})

describe('Letter Grid generator', () => {
  it('is deterministic for a seed', () => { expect(make(5, 3)).toEqual(make(5, 3)); expect(make(5, 3)).not.toEqual(make(5, 4)) })
  it.each([1, 5, 10, 15, 20])('level %i: the grid has enough common words, a word of six letters or more, and a consistent value', level => {
    const grid = make(level, 2), p = params(level)
    expect(grid.n).toBe(Math.round(p.n)); expect(grid.letters).toHaveLength(grid.n * grid.n)
    expect(grid.commonCount).toBeGreaterThanOrEqual(p.minWords)
    expect(grid.words.some(w => w.word.length >= 6)).toBe(true)
    expect(grid.words.every(w => w.word.length >= Math.round(p.minLen) && data.validSet.has(w.word))).toBe(true)
    expect(grid.commonValue).toBe(grid.words.filter(w => w.common).reduce((s, w) => s + w.value, 0))
    expect(grid.words.filter(w => w.common).every(w => data.commonSet.has(w.word))).toBe(true)
  })
  it('letters are drawn from an English-like distribution (E common, Z and Q rare)', () => {
    const counts: Record<string, number> = {}
    for (let seed = 1; seed <= 20; seed++) for (const l of make(1, seed).letters) counts[l] = (counts[l] ?? 0) + 1
    expect(counts.e).toBeGreaterThan((counts.z ?? 0) * 3)
    expect(counts.e).toBeGreaterThan(counts.q ?? 0)
  })
  it('a grid is built quickly (the solver runs inside the worker)', () => { const t = performance.now(); make(20, 9); expect(performance.now() - t).toBeLessThan(3000) })
})

describe('Letter Grid engine and scoring', () => {
  const play = (level: number, response: LgResponse | 'timeout') => {
    const grid = make(level, 3)
    const engine = createLetterGridEngine(params(level), createRng(1), [grid])
    const trial = engine.next() as LgTrial
    const entry: TrialLogEntry<LgTrial, LgResponse> = { n: 1, trial, response, rtMs: 100000, outcome: engine.evaluate(trial, response, 100000), atMs: 0 }
    return { grid, log: [entry], engine }
  }
  it('is one grid per session', () => {
    const { engine } = play(1, { words: [], invalid: 0, repeats: 0 })
    expect(engine.next()).toBeNull()
  })
  it('counts each valid word once; repeats and invalid words are worth nothing', () => {
    const grid = make(1, 3)
    const words = grid.words.slice(0, 3).map(w => w.word)
    expect(acceptedWords(grid, { words: [...words, words[0], 'zzzzz'], invalid: 1, repeats: 1 }).map(w => w.word)).toEqual(words)
    expect(gridValue(grid, { words: [...words, words[0]], invalid: 0, repeats: 1 })).toBe(grid.words.slice(0, 3).reduce((s, w) => s + w.value, 0))
    expect(gridValue(grid, 'timeout')).toBe(0)
  })
  it('score = 100 x value / (target share x common value), capped at 100: everything scores 100, half the target 50, nothing 0', () => {
    const { grid, log } = play(5, { words: [], invalid: 0, repeats: 0 })
    expect(summariseLetterGrid(log, 5).score).toBe(0)
    const target = params(5).targetShare * grid.commonValue
    const all = summariseLetterGrid(play(5, { words: grid.words.map(w => w.word), invalid: 0, repeats: 0 }).log, 5)
    expect(all.score).toBe(100)
    // a prefix of the value-ordered list reaching about half the target
    let value = 0
    const half: string[] = []
    for (const w of [...grid.words].sort((a, b) => a.value - b.value)) { if (value + w.value > target / 2) break; value += w.value; half.push(w.word) }
    expect(Math.abs(summariseLetterGrid(play(5, { words: half, invalid: 0, repeats: 0 }).log, 5).score - 100 * value / target)).toBeLessThanOrEqual(1)
  })
  it('reports words, longest word, share of the common value, rare words and entry errors; the review lists what was missed', () => {
    const { grid, log } = play(1, { words: grid0().words.slice(0, 5).map(w => w.word), invalid: 2, repeats: 1 })
    function grid0(): GridPuzzle { return make(1, 3) }
    const summary = summariseLetterGrid(log, 1)
    expect(summary.stats).toMatchObject({ words_found: 5, invalid_entries: 2, repeats: 1, common_possible: grid.commonCount })
    expect(Object.keys(summary.stats!).length).toBeLessThanOrEqual(20)
    expect(summary.review).toHaveLength(1)
    expect(summary.review![0].correctAnswer).toMatch(/common words worth/)
  })
})
