import type { GameDefinition } from '../../../core/types'
import { paramsAt } from '../../../core/difficulty'
import { TICK_READER_PARAMS } from '../../config/difficulty.market'
import View from './View'

const tickReader: GameDefinition = {
  id: 'tick_reader', kind: 'market', category: 'speed', title: 'Tick Reader',
  blurb: 'Read a short stretch of ticks and call the next move.',
  instructions: [
    'A chart shows the last stretch of price, from an unnamed market, with the entry price at zero.',
    'Press ← to go long (a call), → to go short (a put) or ↓ to skip before the time runs out.',
    'The next few seconds then replay and the trade closes at the end; costs are taken off.',
    'Many windows have no move worth trading. Skipping those scores; guessing every round does not.',
    'The market, day and time are revealed after each round.',
  ],
  paramTable: TICK_READER_PARAMS,
  roundsPerSession: level => paramsAt(TICK_READER_PARAMS, level).rounds,
  reducedMotionParams: params => ({ ...params, replaySpeed: params.replaySpeed * 0.7 }),
  View,
}
export default tickReader
