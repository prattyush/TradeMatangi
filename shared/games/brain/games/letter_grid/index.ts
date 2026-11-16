import type { TrialGameDefinition } from '../../../core/types'
import { LETTER_GRID_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createLetterGridEngine, GRID_SECONDS, summariseLetterGrid, type LgResponse, type LgTrial } from './engine'

const letterGrid: TrialGameDefinition<LgTrial, LgResponse> = {
  id: 'letter_grid', kind: 'trial', category: 'word', title: 'Letter Grid',
  blurb: 'Find words by chaining neighbouring letters.',
  instructions: [
    'Make words from the grid by chaining letters that touch (sideways, up, down and diagonally). A letter cannot be used twice in one word.',
    'Click the letters in order (or drag across them), or just type the word. Press Enter to submit, Backspace to undo.',
    'Longer words are worth more: 3 letters 1, 4 letters 2, 5 letters 4, 6 letters 7, 7 or more 11. A repeated or invalid word scores 0.',
    'Your score is the value you find compared with a share of the value of the common words in the grid. You have 2 minutes.',
  ],
  paramTable: LETTER_GRID_PARAMS,
  session: { kind: 'timed', seconds: GRID_SECONDS },
  createEngine: createLetterGridEngine,
  summarise: summariseLetterGrid,
  View,
}
export default letterGrid
