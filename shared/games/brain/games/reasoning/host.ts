/** Builds a Reasoning game's puzzle set: in the module Web Worker when there is one, otherwise on the calling thread. */
import { buildPuzzleSet } from '../../engine/puzzleHost'
import type { GeneratorRegistry } from '../../engine/generatorHost'
import type { CodePuzzle, GenerateCodesArgs } from '../code_breaker/solver'
import type { GenerateSeriesArgs, SeriesPuzzle } from '../number_series/generator'
import type { GenerateMatrixArgs, MatrixPuzzle } from '../pattern_matrix/generator'
import { REASONING_GENERATORS } from './registry'

const makeWorker = () => new Worker(new URL('./reasoning.worker.ts', import.meta.url), { type: 'module' })
const registry = REASONING_GENERATORS as unknown as GeneratorRegistry

export const buildMatrices = (args: GenerateMatrixArgs) => buildPuzzleSet<MatrixPuzzle[]>(makeWorker, registry, 'patternMatrix', args)
export const buildSeries = (args: GenerateSeriesArgs) => buildPuzzleSet<SeriesPuzzle[]>(makeWorker, registry, 'numberSeries', args)
export const buildCodes = (args: GenerateCodesArgs) => buildPuzzleSet<CodePuzzle[]>(makeWorker, registry, 'codeBreaker', args)
