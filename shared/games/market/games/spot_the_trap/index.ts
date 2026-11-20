import { paramsAt } from '../../../core/difficulty'
import type { GameDefinition } from '../../../core/types'
import { SPOT_THE_TRAP_PARAMS } from '../../config/difficulty.market'
import View from './View'

const spotTheTrap: GameDefinition = {
  id: 'spot_the_trap', kind: 'market', category: 'attention', title: 'Spot the Trap',
  blurb: 'Spot the false signal among real ones.',
  instructions: [
    'Breakout verdict: the chart stops at a bar that closes beyond the range of the last 24 bars. Call it REAL or FAKE before the time runs out.',
    'It is REAL if the price goes well beyond the level before it falls back inside it during the next minute; otherwise it is a fake-out.',
    'From level 6 some rounds are a pattern hunt: sixty bars and a named pattern (inside-bar break, engulfing candle, pin bar, higher lows). Click every occurrence.',
    'Hunts are scored by how many you found and how many of your clicks were right. The market, day and time are revealed afterwards.',
  ],
  paramTable: SPOT_THE_TRAP_PARAMS,
  roundsPerSession: level => paramsAt(SPOT_THE_TRAP_PARAMS, level).rounds,
  View,
}
export default spotTheTrap
