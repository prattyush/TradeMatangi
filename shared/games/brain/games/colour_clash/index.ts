import type { TrialGameDefinition } from '../../../core/types'
import { BLOCK_SECONDS, COLOUR_CLASH_PARAMS } from '../../config/difficulty.brain'
import View from './View'
import { createColourClashEngine, summariseColourClash, type CcResponse, type CcTrial } from './engine'

const colourClash: TrialGameDefinition<CcTrial, CcResponse> = {
  id: 'colour_clash', kind: 'trial', category: 'speed', title: 'Colour Clash',
  blurb: 'Name the ink colour, not the word.',
  instructions: [
    'A colour word appears, printed in a colour. Choose the colour it is printed in, not the word it spells.',
    'Click a button or press its number key. Each button also shows a pattern and its number.',
    'Sometimes the word matches its colour, often it does not. Bars (XXXX) have no word to ignore.',
    'At the top levels the buttons change places every time, so do not rely on position.',
    'You have 60 seconds. Guessing scores nothing.',
  ],
  paramTable: COLOUR_CLASH_PARAMS,
  session: { kind: 'timed', seconds: BLOCK_SECONDS.colour_clash },
  createEngine: createColourClashEngine,
  summarise: summariseColourClash,
  View,
}
export default colourClash
