import type { TrialGameDefinition } from '../../../core/types'
import { ROUND_COUNTS, WORD_LADDER_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createWordLadderEngine, summariseWordLadder, type WlResponse, type WlTrial } from './engine'

const wordLadder: TrialGameDefinition<WlTrial, WlResponse> = {
  id: 'word_ladder', kind: 'trial', category: 'word', title: 'Word Ladder',
  blurb: 'Change one letter at a time to reach the goal word.',
  instructions: [
    'Go from the start word to the goal word by changing ONE letter at a time. Every step must be a real word of the same length.',
    'Type the next word and press Enter. Backspace on an empty box undoes your last step; Reset starts again.',
    'The puzzle shows par: the fewest steps possible. You score par divided by your steps, so detours cost points.',
    'Hint shows the next word on a shortest route and takes 20% off that puzzle. You get a few hints at first and none at the top levels.',
    'Five puzzles, each with a time limit.',
  ],
  paramTable: WORD_LADDER_PARAMS,
  session: { kind: 'rounds', count: () => ROUND_COUNTS.word_ladder },
  createEngine: createWordLadderEngine,
  summarise: summariseWordLadder,
  View,
}
export default wordLadder
