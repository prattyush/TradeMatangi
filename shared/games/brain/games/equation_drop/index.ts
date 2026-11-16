import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, EQUATION_DROP_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createEquationDropEngine, summariseEquationDrop, type EdResponse, type EdTrial } from './engine'

const equationDrop: TrialGameDefinition<EdTrial, EdResponse> = {
  id: 'equation_drop', kind: 'trial', category: 'math', title: 'Equation Drop',
  blurb: 'Clear the falling equations before they land.',
  instructions: [
    'Equations fall from the top. Type an answer and press Enter: EVERY falling equation with that answer clears at once.',
    'An equation that reaches the bottom costs a life. You have three lives and 90 seconds.',
    'Clearing several in a row builds a combo that scores more. A wrong answer breaks the combo, costs a little, and freezes typing for a moment.',
    'From level 12 some equations are reversed: "? + 9 = 23". Type the missing number.',
    'Equations fall faster and more of them fall together as you go.',
  ],
  paramTable: EQUATION_DROP_PARAMS,
  reducedMotionParams: params => ({ ...params, fallStartMs: Math.round(params.fallStartMs * 1.4), fallEndMs: Math.round(params.fallEndMs * 1.4) }),
  session: { kind: 'timed', seconds: BLOCK_SECONDS.equation_drop },
  createEngine: createEquationDropEngine,
  summarise: summariseEquationDrop,
  View,
}
export default equationDrop
