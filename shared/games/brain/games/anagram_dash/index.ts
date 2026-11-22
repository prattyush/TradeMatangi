import type { TrialGameDefinition } from '../../../core/types'
import { ANAGRAM_DASH_PARAMS, BLOCK_SECONDS } from '../../config/difficulty.brain'
import View from './View'
import { createAnagramEngine, summariseAnagramDash, type AdResponse, type AdTrial } from './engine'

const anagramDash: TrialGameDefinition<AdTrial, AdResponse> = {
  id: 'anagram_dash', kind: 'trial', category: 'word', title: 'Anagram Dash',
  blurb: 'Unscramble the letters.',
  instructions: [
    'Scrambled letters are shown. Type a word that uses ALL of them, once each, and press Enter. Any real word that fits is accepted.',
    'Longer words are worth more, and faster is worth more. Shuffle re-arranges the tiles; Hint shows the first letter (the word is then worth 30% less) and you only have a few hints in the block; Skip (Tab) costs nothing but time.',
    'A wrong word is just rejected, so you can keep trying until the time for that word runs out.',
    'Words get longer, less common and more awkward as you level up. You have 90 seconds.',
  ],
  paramTable: ANAGRAM_DASH_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.anagram_dash },
  createEngine: createAnagramEngine,
  summarise: summariseAnagramDash,
  View,
}
export default anagramDash
