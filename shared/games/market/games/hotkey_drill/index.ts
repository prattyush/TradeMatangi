import type { GameDefinition } from '../../../core/types'
import { HOTKEY_DRILL, HOTKEY_DRILL_PARAMS } from '../../config/difficulty.market'
import View from './View'

const hotkeyDrill: GameDefinition = {
  id: 'hotkey_drill', kind: 'market', category: 'speed', title: 'Hotkey Drill',
  blurb: 'Hit the right order keys under time pressure.',
  instructions: [
    'A prompt such as BUY CE 2 lots, EXIT ALL or STOP TO COST appears. Do it on the mock panel: set the lots, press the action key, then Enter.',
    'A wrong key, wrong lots or wrong side is a fat-finger: it is counted and the prompt stays.',
    'Higher levels chain steps and add "ignore" cues, where the right move is to do nothing.',
    'Three one-minute blocks. This is a practice panel; nothing is ever sent to a broker.',
  ],
  paramTable: HOTKEY_DRILL_PARAMS,
  roundsPerSession: () => HOTKEY_DRILL.blocks,
  View,
}
export default hotkeyDrill
