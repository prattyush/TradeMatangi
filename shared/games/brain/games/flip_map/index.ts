import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, FLIP_MAP_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createFlipMapEngine, summariseFlipMap, type FmResponse, type FmTrial } from './engine'

const flipMap: TrialGameDefinition<FmTrial, FmResponse> = {
  id: 'flip_map', kind: 'trial', category: 'flexibility', title: 'Flip Map',
  blurb: 'Keys keep changing meaning; keep up.',
  instructions: [
    'An arrow appears. Press an arrow key, but which one depends on the current RULE.',
    'SAME: press the key the arrow points to. OPPOSITE: press the other way. From level 16 TURN: press the key 90 degrees clockwise from it.',
    'The rule changes every 4 to 12 arrows. At first the rule stays on screen; from level 7 it shows only briefly; from level 13 you must notice the change yourself from a red flash after a mistake.',
    'You have 75 seconds. Fast and accurate scores best; guessing scores nothing.',
  ],
  paramTable: FLIP_MAP_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.flip_map },
  createEngine: createFlipMapEngine,
  summarise: summariseFlipMap,
  View,
}
export default flipMap
