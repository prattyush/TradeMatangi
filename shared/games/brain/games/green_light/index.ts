import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, GREEN_LIGHT_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createGreenLightEngine, summariseGreenLight, type GlResponse, type GlTrial } from './engine'

const greenLight: TrialGameDefinition<GlTrial, GlResponse> = {
  id: 'green_light', kind: 'trial', category: 'speed', title: 'Green Light',
  blurb: 'Go on green, hold back on the rest.',
  instructions: [
    'Symbols appear one at a time. Press Space (or the GO button) for a GO symbol.',
    'For a NO-GO symbol, do nothing. Pressing on a NO-GO counts against you.',
    'The banner before the first symbol tells you which one is GO.',
    'At higher levels the rule changes during the block; a banner shows the new rule.',
    'You have 75 seconds. Pressing every time or never pressing scores nothing.',
  ],
  paramTable: GREEN_LIGHT_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.green_light },
  createEngine: createGreenLightEngine,
  summarise: summariseGreenLight,
  View,
}
export default greenLight
