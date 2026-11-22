/** Anagram Dash target words (spec 17.5 #19). Targets come from the common list; ANY valid word that uses all the letters is accepted. Seeded. */
import { createRng, type Rng } from '../../../core/rng'
import type { WordData } from '../../words/loader'

export interface AnagramPuzzle {
  /** The letters, scrambled (never already a valid word). */
  letters: string
  /** The word the puzzle was made from. */
  target: string
  /** Every valid word that uses all the letters exactly once each (includes the target): what the game accepts. */
  answers: string[]
  length: number
  tier: number
}

export const sortedLetters = (word: string): string => [...word].sort().join('')
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u'])
/** 0 to 1: how awkward the letters are (few vowels, repeated letters). */
export function awkwardness(word: string): number {
  const vowels = [...word].filter(c => VOWELS.has(c)).length
  const repeats = word.length - new Set(word).size
  return Math.min(1, Math.max(0, 0.7 - vowels / word.length) * 1.4 + repeats * 0.15)
}

function scramble(rng: Rng, word: string, answers: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 30; attempt++) {
    const letters = rng.shuffle([...word]).join('')
    if (!answers.has(letters) && letters !== word) return letters
  }
  return [...word].reverse().join('') // reversing a word is almost never a word; the loop above only fails for palindromes
}

export interface AnagramParams { length: number; tier: number; hard: number }

/** `count` distinct puzzles of one length, drawn from the common words up to `tier`. */
export function generateAnagrams(data: WordData, rng: Rng, params: AnagramParams, count: number): AnagramPuzzle[] {
  const length = Math.round(params.length), tier = Math.round(params.tier)
  const pool = data.common.filter(entry => entry.word.length === length && entry.tier <= tier).map(entry => entry.word)
  // All valid words of this length, grouped by their letters, so the accepted answers are found at once.
  const groups = new Map<string, string[]>()
  for (const word of data.valid) if (word.length === length) { const key = sortedLetters(word); const list = groups.get(key); if (list) list.push(word); else groups.set(key, [word]) }
  const picked = new Set<string>()
  const out: AnagramPuzzle[] = []
  for (let guard = 0; out.length < count && guard < count * 40 && pool.length; guard++) {
    // At higher levels the awkward words (few vowels, repeats) are preferred: draw three and keep the most awkward.
    let word = rng.pick(pool)
    if (rng.chance(params.hard)) for (let i = 0; i < 2; i++) { const other = rng.pick(pool); if (awkwardness(other) > awkwardness(word)) word = other }
    if (picked.has(word)) continue
    const answers = groups.get(sortedLetters(word)) ?? [word]
    // Words with several anagrams ("stop", "pots", "tops") are fine: all are accepted, so only the scramble must avoid every one.
    picked.add(word)
    out.push({ letters: scramble(rng, word, new Set(answers)), target: word, answers, length, tier })
  }
  return out
}

export interface GenerateAnagramArgs { params: Record<string, number>; seed: number; count: number }
export async function generateAnagramSet({ params, seed, count }: GenerateAnagramArgs): Promise<AnagramPuzzle[]> {
  const { loadWordData } = await import('../../words/loader')
  const data = await loadWordData()
  return generateAnagrams(data, createRng(seed), { length: params.length, tier: params.tier, hard: params.hard }, count)
}
