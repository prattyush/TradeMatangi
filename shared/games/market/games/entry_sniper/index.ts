import { paramsAt } from '../../../core/difficulty'
import type { GameDefinition } from '../../../core/types'
import { ENTRY_SNIPER_PARAMS } from '../../config/difficulty.market'
import View from './View'

const entrySniper: GameDefinition = {
  id: 'entry_sniper', kind: 'market', category: 'attention', title: 'Entry Sniper',
  blurb: 'Pick the clean entry, avoid the trap.',
  instructions: [
    'You are told the direction (long or short), a stop distance and a target. The chart then forms second by second.',
    'Press Enter once to take the entry at the current price, or P to pass. The trade runs to the stop, the target or the time limit.',
    'You are scored against the best entry that window offered. Waiting for a clean entry beats chasing the first move.',
    'Some windows are traps: the setup never works. Passing on those scores. The market, day and time are revealed after each round.',
  ],
  paramTable: ENTRY_SNIPER_PARAMS,
  roundsPerSession: level => paramsAt(ENTRY_SNIPER_PARAMS, level).rounds,
  reducedMotionParams: params => ({ ...params, windowSpeed: params.windowSpeed * 0.7, replaySpeed: params.replaySpeed * 0.7 }),
  View,
}
export default entrySniper
