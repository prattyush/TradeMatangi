import type { TrialGameDefinition } from '../../../core/types'
import { CARD_SORTER_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import View from './View'
import { createCardSorterEngine, summariseCardSorter, type CsResponse, type CsTrial } from './engine'

const cardSorter: TrialGameDefinition<CsTrial, CsResponse> = {
  id: 'card_sorter', kind: 'trial', category: 'flexibility', title: 'Card Sorter',
  blurb: 'Work out the hidden rule, then adapt when it changes.',
  instructions: [
    'Match each new card to one of the four cards at the top. The rule is hidden: it may be colour, shape or number of symbols.',
    'After each choice you only see "match" or "no match". Use it to find the rule.',
    'After a run of correct matches the rule changes without warning. When you start getting "no match", look for the new rule.',
    'Press 1 to 4 or click a card. There are 64 cards and no time pressure.',
    'Sticking with the old rule after a change costs points.',
  ],
  paramTable: CARD_SORTER_PARAMS,
  session: { kind: 'rounds', count: () => ROUND_COUNTS.card_sorter },
  createEngine: createCardSorterEngine,
  summarise: summariseCardSorter,
  View,
}
export default cardSorter
