import type { TrialGameDefinition } from '../../../core/types'
import { MAKE_TARGET_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import View from './View'
import { createMakeTargetEngine, summariseMakeTarget, type MtResponse, type MtTrial } from './engine'

const makeTarget: TrialGameDefinition<MtTrial, MtResponse> = {
  id: 'make_target', kind: 'trial', category: 'math', title: 'Make Target',
  blurb: 'Reach the target from the numbers you are given.',
  instructions: [
    'Reach the target number by combining the given numbers with + − × ÷. Each given number can be used once.',
    'Click a number, an operator, then a second number: the two are replaced by the result. Every result must be a whole number above zero; divisions must be exact.',
    'You do not have to use every number. Undo and Reset are free. Reaching the target scores; faster scores more.',
    'At levels 1 to 6 you can also "Submit closest": a result within 2 of the target earns half credit.',
    'There are 8 puzzles, each with a time limit. A solver checks every puzzle can be solved.',
  ],
  paramTable: MAKE_TARGET_PARAMS,
  session: { kind: 'rounds', count: () => ROUND_COUNTS.make_target },
  createEngine: createMakeTargetEngine,
  summarise: summariseMakeTarget,
  View,
}
export default makeTarget
