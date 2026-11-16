import { paramsAt } from '../../../core/difficulty'
import type { GameDefinition } from '../../../core/types'
import { LEVEL_RECALL_PARAMS } from '../../config/difficulty.market'
import View from './View'

const levelRecall: GameDefinition = {
  id: 'level_recall', kind: 'market', category: 'memory', title: 'Level Recall',
  blurb: 'Remember key levels, then place them.',
  instructions: [
    'A chart of yesterday and today so far shows key levels: the prior-day high, low and close, today\'s open, the opening range, today\'s high and low, an average price and a round number.',
    'Memorise them. When the time is up the chart goes and you click where each named level is on a blank price ladder.',
    'You are scored by how far off each one is, in units of how much this market moves in five minutes. Later levels show distractors and allow less time and less error.',
    'From level 10 some rounds show six swing points; you say whether each was higher or lower than the one before. The market and day are revealed afterwards.',
  ],
  paramTable: LEVEL_RECALL_PARAMS,
  roundsPerSession: level => paramsAt(LEVEL_RECALL_PARAMS, level).rounds,
  View,
}
export default levelRecall
