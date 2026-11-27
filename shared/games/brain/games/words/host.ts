/** Builds a Word game's puzzle set: in the module Web Worker when there is one (lists decoded there), otherwise on the calling thread. */
import type { GeneratorRegistry } from '../../engine/generatorHost'
import { buildPuzzleSet } from '../../engine/puzzleHost'
import type { AnagramPuzzle, GenerateAnagramArgs } from '../anagram_dash/generator'
import type { GenerateGridArgs, GridPuzzle } from '../letter_grid/generator'
import type { GenerateLadderArgs, LadderPuzzle } from '../word_ladder/generator'
import { releaseWordData } from '../../words/loader'
import { WORD_GENERATORS } from './registry'

const makeWorker = () => new Worker(new URL('./words.worker.ts', import.meta.url), { type: 'module' })
const registry = WORD_GENERATORS as unknown as GeneratorRegistry
// On the calling thread the decoded lists would stay in memory: let go of them as soon as the puzzles are built.
const build = <R,>(name: string, args: unknown) => buildPuzzleSet<R>(makeWorker, registry, name, args, releaseWordData)

export const buildAnagrams = (args: GenerateAnagramArgs) => build<AnagramPuzzle[]>('anagramDash', args)
export const buildGrids = (args: GenerateGridArgs) => build<GridPuzzle[]>('letterGrid', args)
export const buildLadders = (args: GenerateLadderArgs) => build<LadderPuzzle[]>('wordLadder', args)
