import { NO_TRADE_DAY } from '../../config/difficulty.market'
import type { GameDefinition } from '../../../core/types'
import { NO_TRADE_DAY_PARAMS } from '../../config/difficulty.market'
import View from './View'

const noTradeDay: GameDefinition = {
  id: 'no_trade_day', kind: 'market', category: 'discipline', title: 'No-Trade Day',
  blurb: 'Follow your rules and skip the bad setups.',
  instructions: [
    'Before each segment, commit to rules: a maximum number of trades, a loss limit, a stop after a losing streak, a cooldown after a loss, a lot limit.',
    'Then the segment replays faster than real time. Go LONG or SHORT in 1 to 3 lots, and EXIT. Every trade has a stop of 1 R.',
    'The game never blocks you. A broken rule is recorded and costs points, and so does a revenge trade: a quick re-entry after a loss with as many lots or more.',
    'You are scored half on your result against what was available and half on discipline. In a poor segment, standing aside is a good answer.',
  ],
  paramTable: NO_TRADE_DAY_PARAMS,
  roundsPerSession: () => NO_TRADE_DAY.segments,
  View,
}
export default noTradeDay
