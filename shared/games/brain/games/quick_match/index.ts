import type { TrialGameDefinition } from '../../../core/types'
import { QUICK_MATCH_PARAMS, BLOCK_SECONDS } from '../../config/difficulty.brain'
import View from './View'
import { createQuickMatchEngine, summariseQuickMatch, type QmResponse, type QmTrial } from './engine'

const quickMatch: TrialGameDefinition<QmTrial, QmResponse> = {
  id: 'quick_match', kind: 'trial', category: 'speed', title: 'Quick Match',
  blurb: 'Same or different? Decide as fast as you can.',
  instructions: [
    'Two items appear together. Press S if they are the same, D if they are different.',
    'At higher levels the shapes are rotated, and a mirror image counts as different.',
    'The items disappear sooner as you level up, but your answer still counts.',
    'You have 60 seconds. Fast and accurate answers score best; guessing scores nothing.',
  ],
  paramTable: QUICK_MATCH_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.quick_match },
  createEngine: createQuickMatchEngine,
  summarise: summariseQuickMatch,
  View,
}
export default quickMatch
