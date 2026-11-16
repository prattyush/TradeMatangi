/**
 * Simulated players for the Word games (spec 17.10, C6). Their puzzles need the word lists, which load asynchronously, so each
 * game's definition is cloned here with an engine that is given a ready-made puzzle set.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { paramsAt } from '../../core/difficulty'
import { createRng } from '../../core/rng'
import type { TrialGameDefinition } from '../../core/types'
import { simulateBlock, simulateMany } from '../engine/simPlayers'
import anagramDash from '../games/anagram_dash'
import { anagramDashSim, createAnagramEngine } from '../games/anagram_dash/engine'
import { generateAnagrams } from '../games/anagram_dash/generator'
import letterGrid from '../games/letter_grid'
import { createLetterGridEngine, letterGridSim } from '../games/letter_grid/engine'
import { generateGrid } from '../games/letter_grid/generator'
import wordLadder from '../games/word_ladder'
import { createWordLadderEngine, wordLadderSim } from '../games/word_ladder/engine'
import { generateLadder } from '../games/word_ladder/generator'
import { loadWordData, type WordData } from './loader'

let data: WordData
beforeAll(async () => { data = await loadWordData() })
const LEVELS = [1, 10, 20] as const
/* eslint-disable @typescript-eslint/no-explicit-any */
const withPuzzles = (definition: TrialGameDefinition<any, any>, build: (params: Record<string, number>, seed: number) => any, engine: any): TrialGameDefinition<any, any> => ({
  ...definition,
  createEngine: (params, rng) => engine(params, rng, build(params, Math.floor(rng.next() * 1e9) + 1)),
})

describe.each(LEVELS)('Word games, simulated players, level %i', level => {
  const games = () => [
    ['anagram_dash', withPuzzles(anagramDash, (p, seed) => generateAnagrams(data, createRng(seed), { length: p.length, tier: p.tier, hard: p.hard }, 80), createAnagramEngine), anagramDashSim],
    ['letter_grid', withPuzzles(letterGrid, (p, seed) => [generateGrid(data, createRng(seed), { n: p.n, minLen: p.minLen, minWords: p.minWords })], createLetterGridEngine), letterGridSim],
    ['word_ladder', withPuzzles(wordLadder, (p, seed) => { const rng = createRng(seed), used = new Set<string>(); return Array.from({ length: 5 }, () => { const x = generateLadder(data, rng, { length: p.length, par: p.par }, used); used.add(x.start); return x }) }, createWordLadderEngine), wordLadderSim],
  ] as const
  it('a perfect player scores 95 or more', () => {
    for (const [name, definition, sim] of games()) for (const seed of [1, 2]) expect(simulateBlock(definition, sim as any, level, 'perfect', seed).score, `${name} seed ${seed}`).toBeGreaterThanOrEqual(95)
  })
  it('random and fast-random players score about nothing', () => {
    for (const [name, definition, sim] of games()) {
      for (const profile of ['random', 'fastRandom'] as const) {
        const scores = simulateMany(definition, sim as any, level, profile, 6)
        expect(Math.max(...scores), `${name} ${profile}`).toBeLessThanOrEqual(25)
      }
    }
  })
  it('the parameters are defined and finite at this level', () => {
    for (const [, definition] of games()) for (const value of Object.values(paramsAt(definition.paramTable, level))) expect(Number.isFinite(value)).toBe(true)
  })
})
