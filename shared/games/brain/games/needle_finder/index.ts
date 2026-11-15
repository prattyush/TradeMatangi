import type { TrialGameDefinition } from '../../../core/types'
import { NEEDLE_FINDER_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import View from './View'
import { createNeedleEngine, summariseNeedleFinder, type NfResponse, type NfTrial } from './engine'

const needleFinder: TrialGameDefinition<NfTrial, NfResponse> = {
  id: 'needle_finder', kind: 'trial', category: 'attention', title: 'Needle Finder',
  blurb: 'Find the odd one out, or say it is not there.',
  instructions: [
    'Find the red upright bar among the others and click it. If it is not there, press N.',
    'At first it is the only red one. From level 7 other bars are red or upright too, so you must look for both together.',
    'You get a time limit per screen. Faster correct answers score more.',
    'Clicking at random, or always saying "not there", scores nothing.',
  ],
  paramTable: NEEDLE_FINDER_PARAMS,
  session: { kind: 'rounds', count: () => ROUND_COUNTS.needle_finder },
  createEngine: createNeedleEngine,
  summarise: summariseNeedleFinder,
  View,
}
export default needleFinder
