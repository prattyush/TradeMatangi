/**
 * Letter Grid generator and solver (spec 17.5 #20, corrections C3). An n x n grid of letters; words are chains of adjacent
 * letters (diagonals too) that never reuse a cell. The solver walks the grid with the valid-list trie and returns EVERY valid word
 * with one path for it. Seeded.
 */
import { createRng, type Rng } from '../../../core/rng'
import type { WordData } from '../../words/loader'
import type { Trie } from '../../words/wordlist'

export interface GridWord { word: string; /** One valid chain of cell indices (row-major) spelling the word. */ path: number[]; /** In the common list (tier 1). */ common: boolean; value: number }
export interface GridPuzzle {
  n: number
  letters: string[]
  minLen: number
  /** Every valid word of at least `minLen` letters. */
  words: GridWord[]
  /** Sum of the values of the COMMON words: the yardstick for the score (a person cannot be asked for obscure words, C3). */
  commonValue: number
  commonCount: number
}

/** Word value by length: 3 -> 1, 4 -> 2, 5 -> 4, 6 -> 7, 7 or more -> 11. */
export const wordValue = (length: number): number => (length <= 2 ? 0 : length === 3 ? 1 : length === 4 ? 2 : length === 5 ? 4 : length === 6 ? 7 : 11)

// Letter weights close to Boggle's, so grids look like Boggle grids (Q is rare and stands alone).
const WEIGHTS: Record<string, number> = {
  a: 8.2, b: 1.5, c: 2.8, d: 4.3, e: 12, f: 2.2, g: 2, h: 6, i: 7, j: 0.2, k: 0.8, l: 4, m: 2.4, n: 6.7, o: 7.5, p: 1.9, q: 0.1, r: 6, s: 6.3, t: 9, u: 2.8, v: 1, w: 2.4, x: 0.2, y: 2, z: 0.1,
}
const LETTERS = Object.keys(WEIGHTS)
const TOTAL = LETTERS.reduce((s, l) => s + WEIGHTS[l], 0)
function randomLetter(rng: Rng): string {
  let r = rng.next() * TOTAL
  for (const l of LETTERS) { r -= WEIGHTS[l]; if (r < 0) return l }
  return 'e'
}

/** All valid words in the grid (at least `minLen` letters), each once, with a path. */
export function solveGrid(trie: Trie, letters: readonly string[], n: number, minLen: number, isCommon: (word: string) => boolean): GridWord[] {
  const found = new Map<string, number[]>()
  const used = new Uint8Array(n * n)
  const path: number[] = []
  const chars: string[] = []
  const visit = (cell: number, node: number) => {
    const next = trie.step(node, letters[cell].charCodeAt(0) - 97)
    if (next === -1) return
    used[cell] = 1; path.push(cell); chars.push(letters[cell])
    if (chars.length >= minLen && trie.isWord(next)) { const word = chars.join(''); if (!found.has(word)) found.set(word, [...path]) }
    const row = Math.floor(cell / n), col = cell % n
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const r = row + dr, c = col + dc
      if (r < 0 || c < 0 || r >= n || c >= n) continue
      const neighbour = r * n + c
      if (!used[neighbour]) visit(neighbour, next)
    }
    used[cell] = 0; path.pop(); chars.pop()
  }
  for (let cell = 0; cell < n * n; cell++) visit(cell, 0)
  return [...found].map(([word, p]) => ({ word, path: p, common: isCommon(word), value: wordValue(word.length) })).sort((a, b) => b.value - a.value || (a.word < b.word ? -1 : 1))
}

export interface GridParams { n: number; minLen: number; minWords: number }
const ATTEMPTS = 200

/** A grid with at least `minWords` common words and a word of six letters or more; the best grid found if none qualifies. */
export function generateGrid(data: WordData, rng: Rng, params: GridParams): GridPuzzle {
  const n = Math.round(params.n), minLen = Math.round(params.minLen)
  const trie = data.trie()
  let best: GridPuzzle | null = null
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const letters = Array.from({ length: n * n }, () => randomLetter(rng))
    const words = solveGrid(trie, letters, n, minLen, w => data.commonSet.has(w))
    const common = words.filter(w => w.common)
    const puzzle: GridPuzzle = { n, letters, minLen, words, commonValue: common.reduce((s, w) => s + w.value, 0), commonCount: common.length }
    if (!best || puzzle.commonCount > best.commonCount) best = puzzle
    if (puzzle.commonCount >= params.minWords && words.some(w => w.word.length >= 6)) return puzzle
  }
  return best as GridPuzzle
}

export interface GenerateGridArgs { params: Record<string, number>; seed: number; count: number }
export async function generateGridSet({ params, seed, count }: GenerateGridArgs): Promise<GridPuzzle[]> {
  const { loadWordData } = await import('../../words/loader')
  const data = await loadWordData()
  const rng = createRng(seed)
  return Array.from({ length: count }, () => generateGrid(data, rng, { n: params.n, minLen: params.minLen, minWords: params.minWords }))
}
