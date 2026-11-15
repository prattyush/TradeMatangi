import type { TrialGameDefinition } from '../../../core/types'
import { GRID_RECALL_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createGridRecallEngine, grRules, summariseGridRecall, type GrResponse, type GrTrial } from './engine'
import { paramsAt } from '../../../core/difficulty'

const gridRecall: TrialGameDefinition<GrTrial, GrResponse> = {
  id: 'grid_recall', kind: 'trial', category: 'memory', title: 'Grid Recall',
  blurb: 'Remember which tiles lit up.',
  instructions: [
    'Tiles light up on a grid. Remember where, then tap them.',
    'At first they light one by one and you tap them in the same order. From level 8 they light together and order does not matter; from level 12 you tap them in reverse.',
    'Each success adds tiles. Three misses end the game, so your score is how far your memory span got.',
    'From level 18 the grid is turned or flipped before you answer: tap where the tiles went.',
  ],
  paramTable: GRID_RECALL_PARAMS,
  session: { kind: 'rounds', count: level => grRules(paramsAt(GRID_RECALL_PARAMS, level)).maxTrials },
  createEngine: createGridRecallEngine,
  summarise: summariseGridRecall,
  View,
}
export default gridRecall
