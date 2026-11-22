import { generateCodes } from '../code_breaker/solver'
import { generateSeriesSet } from '../number_series/generator'
import { generateMatrices } from '../pattern_matrix/generator'

/** The generators the Reasoning worker (and the inline fallback) can run. */
export const REASONING_GENERATORS = { patternMatrix: generateMatrices, numberSeries: generateSeriesSet, codeBreaker: generateCodes }
export type ReasoningName = keyof typeof REASONING_GENERATORS
