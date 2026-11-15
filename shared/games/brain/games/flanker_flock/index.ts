import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, FLANKER_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createFlankerEngine, summariseFlanker, type FlResponse, type FlTrial } from './engine'

const flankerFlock: TrialGameDefinition<FlTrial, FlResponse> = {
  id: 'flanker_flock', kind: 'trial', category: 'attention', title: 'Flanker Flock',
  blurb: 'Which way does the middle arrow point?',
  instructions: [
    'A row of arrows appears. Press ← or → for the direction of the MIDDLE arrow only.',
    'The arrows around it may point the same way, the other way, or be plain dashes. Ignore them.',
    'Higher levels add more arrows and show them for less time.',
    'From level 14 two rows appear and a cue tells you which row to judge; the other is a decoy.',
    'You have 60 seconds. Fast and accurate scores best; guessing scores nothing.',
  ],
  paramTable: FLANKER_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.flanker_flock },
  createEngine: createFlankerEngine,
  summarise: summariseFlanker,
  View,
}
export default flankerFlock
