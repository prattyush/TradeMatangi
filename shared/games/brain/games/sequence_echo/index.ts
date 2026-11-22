import { paramsAt } from '../../../core/difficulty'
import type { TrialGameDefinition } from '../../../core/types'
import { SEQUENCE_ECHO_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createSequenceEchoEngine, seRules, summariseSequenceEcho, type SeResponse, type SeTrial } from './engine'

const sequenceEcho: TrialGameDefinition<SeTrial, SeResponse> = {
  id: 'sequence_echo', kind: 'trial', category: 'memory', title: 'Sequence Echo',
  blurb: 'Repeat the sequence in order.',
  instructions: [
    'Items flash one at a time. Repeat the sequence in the same order by clicking the items or pressing their keys.',
    'From level 8 you repeat it BACKWARDS.',
    'Each success makes the sequence longer. Three misses end the game: your score is how long a sequence you managed.',
    'From level 15 grey dashed flashes appear between the items. Ignore them: they are not part of the sequence.',
  ],
  paramTable: SEQUENCE_ECHO_PARAMS,
  session: { kind: 'rounds', count: level => seRules(paramsAt(SEQUENCE_ECHO_PARAMS, level)).maxTrials },
  createEngine: createSequenceEchoEngine,
  summarise: summariseSequenceEcho,
  View,
}
export default sequenceEcho
