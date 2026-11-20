import type { TrialGameDefinition } from '../../../core/types'
import { ROUND_COUNTS, TRACK_DOTS_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createTrackDotsEngine, summariseTrackDots, type TdResponse, type TdTrial } from './engine'

const trackTheDots: TrialGameDefinition<TdTrial, TdResponse> = {
  id: 'track_the_dots', kind: 'trial', category: 'attention', title: 'Track the Dots',
  blurb: 'Follow the marked dots as they move.',
  instructions: [
    'Some dots are marked in orange. Remember them: then all dots look the same and start to move.',
    'When they stop, click the dots you were following.',
    'More dots, more targets and faster movement at higher levels. From level 12 the dots pass behind a screen; from level 16 other dots blink to distract you.',
    'Eight rounds. Picking at random scores nothing.',
  ],
  paramTable: TRACK_DOTS_PARAMS,
  reducedMotionParams: params => ({ ...params, speed: Math.round(params.speed * 0.7) }),
  session: { kind: 'rounds', count: () => ROUND_COUNTS.track_the_dots },
  createEngine: createTrackDotsEngine,
  summarise: summariseTrackDots,
  View,
}
export default trackTheDots
