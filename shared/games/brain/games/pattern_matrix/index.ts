import type { TrialGameDefinition } from '../../../core/types'
import { PATTERN_MATRIX_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import View from './View'
import { createPatternMatrixEngine, summarisePatternMatrix, type PmResponse, type PmTrial } from './engine'

const patternMatrix: TrialGameDefinition<PmTrial, PmResponse> = {
  id: 'pattern_matrix', kind: 'trial', category: 'reasoning', title: 'Pattern Matrix',
  blurb: 'Find the piece that completes the pattern.',
  instructions: [
    'A 3 by 3 grid of figures has its last cell missing. Pick the option that completes it.',
    'Figures change in shape, number, size, colour, turn and shading. Each kind of change follows a rule along the rows: it stays the same, steps up or down, or uses each of three values once per row.',
    'Work out the rules from the first two rows, then apply them to the third. Press 1 to 8 or click an option.',
    'Only one option fits every rule. Higher levels have more rules at once, look-alike options and, from level 14, dots combined by XOR or AND.',
    'There are 10 puzzles with a time limit each. Guessing scores nothing.',
  ],
  paramTable: PATTERN_MATRIX_PARAMS,
  session: { kind: 'rounds', count: () => ROUND_COUNTS.pattern_matrix },
  createEngine: createPatternMatrixEngine,
  summarise: summarisePatternMatrix,
  View,
}
export default patternMatrix
