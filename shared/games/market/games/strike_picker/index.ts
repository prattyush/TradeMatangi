import { paramsAt } from '../../../core/difficulty'
import type { GameDefinition } from '../../../core/types'
import { STRIKE_PICKER_PARAMS } from '../../config/difficulty.market'
import View from './View'

const strikePicker: GameDefinition = {
  id: 'strike_picker', kind: 'market', category: 'reasoning', title: 'Strike Picker',
  blurb: 'Choose the right option strike for the scenario.',
  instructions: [
    'Each scenario gives a direction, an expected move, the time it takes, the days to expiry, the volatility and an objective.',
    'Choose a strike from three in the money to three out of the money. Use the arrows or the keys 1 to 7 and press Enter.',
    'The game prices every strike before and after the move with Black-Scholes, including a spread that widens far out of the money.',
    'You are scored from the worst strike to the best on the stated objective. Later scenarios include moves that do not come.',
  ],
  paramTable: STRIKE_PICKER_PARAMS,
  roundsPerSession: level => paramsAt(STRIKE_PICKER_PARAMS, level).scenarios,
  View,
}
export default strikePicker
