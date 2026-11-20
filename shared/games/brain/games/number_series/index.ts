import type { TrialGameDefinition } from '../../../core/types'
import { NUMBER_SERIES_PARAMS, ROUND_COUNTS } from '../../config/difficulty.brain'
import View from './View'
import { createNumberSeriesEngine, summariseNumberSeries, type NsrResponse, type NsrTrial } from './engine'

const numberSeries: TrialGameDefinition<NsrTrial, NsrResponse> = {
  id: 'number_series', kind: 'trial', category: 'reasoning', title: 'Number Series',
  blurb: 'What comes next in the series?',
  instructions: [
    'A series of numbers is shown with the next term missing. Find the rule and give the next term.',
    'Rules include adding or multiplying by a fixed amount, differences that grow, squares and cubes, each term built from the two before, two series woven together, and digit sums.',
    'Choose from 5 options (press 1 to 5 or click). From level 15 you type the answer and press Enter.',
    'Every puzzle has one answer whichever rule you have in mind: a solver checks it. 12 puzzles, each with a time limit. Guessing scores nothing.',
  ],
  paramTable: NUMBER_SERIES_PARAMS,
  session: { kind: 'rounds', count: () => ROUND_COUNTS.number_series },
  createEngine: createNumberSeriesEngine,
  summarise: summariseNumberSeries,
  View,
}
export default numberSeries
