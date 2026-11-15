import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, NUMBER_SPRINT_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createNumberSprintEngine, summariseNumberSprint, type NsResponse, type NsTrial } from './engine'

const numberSprint: TrialGameDefinition<NsTrial, NsResponse> = {
  id: 'number_sprint', kind: 'trial', category: 'math', title: 'Number Sprint',
  blurb: 'Quick mental arithmetic.',
  instructions: [
    'A sum appears. Type the answer and press Enter. A right answer moves on at once.',
    'A wrong answer shows the right one for a second and costs half a point. Skipping (Tab) or running out of time scores nothing.',
    'Faster correct answers earn more. Sums get bigger, add times and divide, then two steps, negatives and decimals.',
    'Division always comes out exact. You have 90 seconds.',
  ],
  paramTable: NUMBER_SPRINT_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.number_sprint },
  createEngine: createNumberSprintEngine,
  summarise: summariseNumberSprint,
  View,
}
export default numberSprint
